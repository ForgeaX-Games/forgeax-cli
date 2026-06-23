// @desc Precise TypeScript/JavaScript LSP for both host and container paths

import { spawn, type ChildProcess } from "node:child_process";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSONRPCEndpoint } from "ts-lsp-client/build/src/jsonRpcEndpoint.js";
import { LspClient } from "ts-lsp-client/build/src/lspClient.js";
import { getSandboxManager } from "#src/sandbox/manager.js";
import { runDocker } from "#src/sandbox/docker-cli.js";
import { resolveContainerUser } from "#src/sandbox/user-resolver.js";
import type { ToolDefinition, ToolOutput, AgentContext } from "#src/core/types.js";

type LspOp = "go_to_definition" | "find_references" | "hover" | "document_symbols" | "workspace_symbol" | "diagnostics";
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]);
const PYTHON_EXTENSIONS = new Set([".py"]);

interface DiagnosticItem {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: string;
  message: string;
  code?: string | number;
  source?: string;
}

const SEVERITY_MAP: Record<number, string> = {
  1: "Error",
  2: "Warning",
  3: "Information",
  4: "Hint",
};

/**
 * Base LSP client — owns the JSON-RPC protocol, file tracking, retry, and the
 * 6 op methods. Subclasses override only spawnLspProcess() and readFileContent()
 * to bridge host vs container execution environments.
 */
abstract class BaseLSPClient {
  protected process: ChildProcess | null = null;
  protected lsp: any = null;
  protected endpoint: any = null;
  protected initialized = false;
  protected openedFiles = new Set<string>();
  protected fileVersions = new Map<string, number>();
  protected operationQueue: Promise<unknown> = Promise.resolve();
  protected diagnosticStore = new Map<string, DiagnosticItem[]>();

  constructor(protected readonly cwd: string) {}

  /** Spawn the LSP server process; subclass decides where (host or container). */
  protected abstract spawnLspProcess(): ChildProcess;

  /** Read file content for didOpen/didChange — must reach the same fs the spawned server sees. */
  protected abstract readFileContent(absPath: string): Promise<string>;

  protected async ensureStarted(): Promise<void> {
    if (this.initialized) return;

    this.process = this.spawnLspProcess();

    this.endpoint = new JSONRPCEndpoint(this.process.stdin!, this.process.stdout!);
    this.endpoint.on("error", () => {});
    this.process.stderr?.on("data", () => {});

    this.endpoint.on("textDocument/publishDiagnostics", (params: any) => {
      if (!params?.uri || !Array.isArray(params.diagnostics)) return;
      const filePath = params.uri.startsWith("file://") ? new URL(params.uri).pathname : params.uri;
      const items: DiagnosticItem[] = params.diagnostics.map((d: any) => ({
        file: filePath,
        line: (d.range?.start?.line ?? 0) + 1,
        character: (d.range?.start?.character ?? 0) + 1,
        endLine: (d.range?.end?.line ?? 0) + 1,
        endCharacter: (d.range?.end?.character ?? 0) + 1,
        severity: SEVERITY_MAP[d.severity] ?? "Unknown",
        message: d.message ?? "",
        code: typeof d.code === "object" ? d.code?.value : d.code,
        source: d.source,
      }));
      this.diagnosticStore.set(filePath, items);
    });

    this.lsp = new LspClient(this.endpoint);
    await this.lsp.initialize({
      processId: process.pid,
      capabilities: {
        textDocument: {
          publishDiagnostics: {
            relatedInformation: true,
            tagSupport: { valueSet: [1, 2] },
          },
          synchronization: {
            didSave: true,
          },
        },
      },
      rootUri: pathToFileURL(this.cwd).href,
      workspaceFolders: [{ uri: pathToFileURL(this.cwd).href, name: "workspace" }],
    });
    this.lsp.initialized();
    await new Promise((resolveStart) => setTimeout(resolveStart, 500));
    this.initialized = true;
  }

  protected resolvePath(file: string): string {
    return resolve(this.cwd, file);
  }

  protected async openFile(absPath: string): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    if (this.openedFiles.has(uri)) return;

    const content = await this.readFileContent(absPath);
    const languageId = getTypeScriptLanguageId(extname(absPath));

    this.lsp.didOpen({
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    this.openedFiles.add(uri);
    this.fileVersions.set(uri, 1);
  }

  protected async notifyFileChanged(absPath: string): Promise<void> {
    const uri = pathToFileURL(absPath).href;
    const content = await this.readFileContent(absPath);
    const version = (this.fileVersions.get(uri) ?? 1) + 1;
    this.fileVersions.set(uri, version);

    if (!this.openedFiles.has(uri)) {
      const languageId = getTypeScriptLanguageId(extname(absPath));
      this.lsp.didOpen({
        textDocument: { uri, languageId, version, text: content },
      });
      this.openedFiles.add(uri);
    } else {
      this.endpoint.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
  }

  protected notifyFileSaved(absPath: string): void {
    const uri = pathToFileURL(absPath).href;
    if (!this.openedFiles.has(uri)) return;
    // Note: didSave does not require text; server already has buffer from didOpen/didChange.
    this.endpoint.notify("textDocument/didSave", {
      textDocument: { uri },
    });
  }

  protected async withTimeout<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`LSP operation timed out after ${timeoutMs / 1000}s`)), timeoutMs);
      }),
    ]);
  }

  protected async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.withTimeout(fn);
    } catch (error: any) {
      const message = error?.message ?? "";
      const recoverable =
        message.includes("mismatch") ||
        message.includes("EPIPE") ||
        message.includes("timed out") ||
        !this.process?.connected;

      if (!recoverable) throw error;

      this.initialized = false;
      this.openedFiles.clear();
      this.fileVersions.clear();
      this.diagnosticStore.clear();
      try {
        this.process?.kill();
      } catch {}
      this.process = null;

      await this.ensureStarted();
      return this.withTimeout(fn);
    }
  }

  protected runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.catch(() => undefined).then(fn);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async goToDefinition(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.definition({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
        });
        return formatLocations(result);
      });
    });
  }

  async findReferences(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.references({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
          context: { includeDeclaration: true },
        });
        return formatLocations(result);
      });
    });
  }

  async hover(file: string, line: number, char: number): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.hover({
          textDocument: { uri: pathToFileURL(absPath).href },
          position: { line: line - 1, character: char - 1 },
        });
        return formatHover(result?.contents);
      });
    });
  }

  async documentSymbols(file: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();
      const absPath = this.resolvePath(file);
      await this.openFile(absPath);

      return this.withRetry(async () => {
        const result = await this.lsp.documentSymbol({
          textDocument: { uri: pathToFileURL(absPath).href },
        });
        if (!result || result.length === 0) return "No symbols found.";
        return formatSymbols(result, 0);
      });
    });
  }

  async workspaceSymbol(query: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();

      return this.withRetry(async () => {
        const result = await this.endpoint.send("workspace/symbol", { query });
        if (!result || result.length === 0) return "No symbols found.";
        return formatLocations(result);
      });
    });
  }

  async diagnostics(file?: string): Promise<string> {
    return this.runExclusive(async () => {
      await this.ensureStarted();

      if (file) {
        const absPath = this.resolvePath(file);
        await this.notifyFileChanged(absPath);
        this.notifyFileSaved(absPath);
        await new Promise((r) => setTimeout(r, 1500));

        const items = this.diagnosticStore.get(absPath) ?? [];
        if (items.length === 0) return "No diagnostics found.";
        return formatDiagnostics(items);
      }

      for (const uri of this.openedFiles) {
        const filePath = new URL(uri).pathname;
        await this.notifyFileChanged(filePath);
        this.notifyFileSaved(filePath);
      }
      await new Promise((r) => setTimeout(r, 2000));

      const all: DiagnosticItem[] = [];
      for (const items of this.diagnosticStore.values()) {
        all.push(...items);
      }
      if (all.length === 0) return "No diagnostics found.";
      return formatDiagnostics(all);
    });
  }
}

/** Runs typescript-language-server in the host Node process — direct fs access. */
class HostLSPClient extends BaseLSPClient {
  protected spawnLspProcess(): ChildProcess {
    const local = resolve(this.cwd, "node_modules/.bin/typescript-language-server");
    const serverPath = getSandboxFs().existsSync(local) ? local : "typescript-language-server";
    return spawn(serverPath, ["--stdio"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  protected async readFileContent(absPath: string): Promise<string> {
    return getSandboxFs().readTextSync(absPath);
  }
}

/**
 * Runs typescript-language-server inside the sandbox container via docker exec.
 *
 * Used when the target file path is container-only (i.e. ctx.fs.needsProxy(file) === true).
 * SandboxManager.ensureSandbox() pre-installs the binary in /usr/local (idempotent).
 */
class ContainerLSPClient extends BaseLSPClient {
  protected spawnLspProcess(): ChildProcess {
    const sandbox = getSandboxManager();
    if (!sandbox?.isEnabled()) {
      throw new Error("ContainerLSPClient requires sandbox to be enabled (non-direct mode)");
    }
    // Fail-at-use-site: if the toolchain install during ensureSandbox failed
    // (e.g. no npm registry network), surface a clear error here instead of an
    // opaque "server crashed" / hang from the spawned exec hitting code 127.
    const toolchainErr = sandbox.getToolchainError();
    if (toolchainErr) {
      throw new Error(
        `Container LSP unavailable: typescript-language-server install failed during sandbox setup. ` +
        `Original error: ${toolchainErr}. ` +
        `Fix: ensure the container can reach the npm registry, then restart the instance.`,
      );
    }
    return sandbox.spawnInContainer({
      command: "typescript-language-server",
      args: ["--stdio"],
      cwd: this.cwd,
      user: resolveContainerUser(false),
    });
  }

  protected async readFileContent(absPath: string): Promise<string> {
    const sandbox = getSandboxManager();
    if (!sandbox?.isEnabled()) {
      throw new Error("ContainerLSPClient requires sandbox to be enabled");
    }
    // `cat` via runDocker — short-lived, captures stdout. Used only for didOpen/didChange.
    return await runDocker(["exec", sandbox.getContainerName(), "cat", absPath]);
  }
}

function getTypeScriptLanguageId(extension: string): string {
  const languageMap: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mts": "typescript",
    ".mjs": "javascript",
    ".cts": "typescript",
    ".cjs": "javascript",
  };
  return languageMap[extension] ?? "typescript";
}

function formatLocations(locations: any): string {
  if (!locations) return "No results found.";
  const items = Array.isArray(locations) ? locations : [locations];
  if (items.length === 0) return "No results found.";

  return items
    .map((location: any) => {
      const uri = location.uri ?? location.targetUri ?? "";
      const range = location.range ?? location.targetSelectionRange ?? location.targetRange;
      const filePath = uri.startsWith("file://") ? new URL(uri) : null;
      if (!range) return filePath ? filePath.pathname : uri;
      const line = (range.start?.line ?? 0) + 1;
      const char = (range.start?.character ?? 0) + 1;
      return `${filePath ? filePath.pathname : uri}:${line}:${char}`;
    })
    .join("\n");
}

function formatHover(contents: any): string {
  if (!contents) return "No hover information.";
  if (typeof contents === "string") return contents;
  if (typeof contents.value === "string") return contents.value;
  if (Array.isArray(contents)) {
    return contents
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (typeof item?.value === "string") return item.value;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(contents);
}

function formatSymbols(symbols: any[], indent: number): string {
  const kindNames: Record<number, string> = {
    1: "File",
    2: "Module",
    3: "Namespace",
    4: "Package",
    5: "Class",
    6: "Method",
    7: "Property",
    8: "Field",
    9: "Constructor",
    10: "Enum",
    11: "Interface",
    12: "Function",
    13: "Variable",
    14: "Constant",
    15: "String",
    16: "Number",
    17: "Boolean",
    18: "Array",
    19: "Object",
    23: "Event",
    24: "Operator",
    25: "TypeParameter",
  };

  const prefix = "  ".repeat(indent);
  return symbols
    .map((symbol) => {
      const kind = kindNames[symbol.kind] ?? `Kind(${symbol.kind})`;
      const line = (symbol.range ?? symbol.location?.range)?.start?.line;
      const lineSuffix = line != null ? `:${line + 1}` : "";
      const detail = symbol.detail ? ` - ${symbol.detail}` : "";
      const children = symbol.children?.length ? `\n${formatSymbols(symbol.children, indent + 1)}` : "";
      return `${prefix}${kind} ${symbol.name}${lineSuffix}${detail}${children}`;
    })
    .join("\n");
}

function getLanguageBoundaryMessage(extension: string): string {
  if (PYTHON_EXTENSIONS.has(extension)) {
    return "Python files are supported in the workspace, but Python LSP/checking is not integrated yet.";
  }
  return `LSP currently supports TypeScript/JavaScript files only. Got: ${extension || "unknown"}`;
}

function formatDiagnostics(items: DiagnosticItem[]): string {
  const byFile = new Map<string, DiagnosticItem[]>();
  for (const item of items) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const sections: string[] = [];
  for (const [file, diags] of byFile) {
    const lines = diags.map((d) => {
      const loc = `${d.line}:${d.character}`;
      const code = d.code != null ? ` (${d.source ?? "ts"}:${d.code})` : "";
      return `  ${d.severity} ${loc} - ${d.message}${code}`;
    });
    sections.push(`${file}\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

let sharedHostClient: HostLSPClient | null = null;
let sharedHostClientCwd: string | null = null;
let sharedContainerClient: ContainerLSPClient | null = null;
let sharedContainerClientCwd: string | null = null;

function getOrCreateHostClient(cwd: string): HostLSPClient {
  if (!sharedHostClient || sharedHostClientCwd !== cwd) {
    sharedHostClient = new HostLSPClient(cwd);
    sharedHostClientCwd = cwd;
  }
  return sharedHostClient;
}

function getOrCreateContainerClient(cwd: string): ContainerLSPClient {
  if (!sharedContainerClient || sharedContainerClientCwd !== cwd) {
    sharedContainerClient = new ContainerLSPClient(cwd);
    sharedContainerClientCwd = cwd;
  }
  return sharedContainerClient;
}

export default {
  name: "lsp",
  description:
    "Precise TypeScript/JavaScript code intelligence via LSP. " +
    "Supports go_to_definition, find_references, hover, document_symbols, workspace_symbol, and diagnostics. " +
    "The diagnostics operation returns linter/type errors for a file (re-reads from disk, notifies LSP, then collects pushed diagnostics). " +
    "If file is omitted for diagnostics, returns errors for all previously opened files. " +
    "Routes to host LSP for project paths and container-side LSP (via docker exec) for container-only paths automatically. " +
    "Line and character positions are 1-based. " +
    "Python files are recognized but Python LSP is not yet integrated.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["go_to_definition", "find_references", "hover", "document_symbols", "workspace_symbol", "diagnostics"],
        description: "LSP operation to perform. Use 'diagnostics' to get linter/type errors.",
      },
      query: {
        type: "string",
        description: "Symbol name query for workspace_symbol operation",
      },
      file: {
        type: "string",
        description: "File path (absolute or project-relative). Optional for diagnostics (omit to check all opened files).",
      },
      line: {
        type: "integer",
        description: "1-based line number (required for go_to_definition, find_references, hover)",
      },
      character: {
        type: "integer",
        description: "1-based character offset (required for go_to_definition, find_references, hover)",
      },
    },
    required: ["operation"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const op = String(args.operation) as LspOp;
    const rawFile = args.file != null ? String(args.file) : undefined;
    const root = ctx.pathManager.root();
    const file = rawFile ? resolve(root, rawFile) : undefined;
    const useContainer = file ? ctx.fs.needsProxy(file) : false;
    const line = typeof args.line === "number" ? args.line : 1;
    const char = typeof args.character === "number" ? args.character : 1;
    const extension = file ? extname(file) : "";

    try {
      const client = useContainer
        ? getOrCreateContainerClient(root)
        : getOrCreateHostClient(root);

      if (op === "diagnostics") {
        if (file && !TS_EXTENSIONS.has(extension)) {
          return getLanguageBoundaryMessage(extension);
        }
        return await client.diagnostics(file);
      }

      if (!file) return "file is required for this operation.";

      if (!TS_EXTENSIONS.has(extension)) {
        return getLanguageBoundaryMessage(extension);
      }

      switch (op) {
        case "go_to_definition":
          return await client.goToDefinition(file, line, char);
        case "find_references":
          return await client.findReferences(file, line, char);
        case "hover":
          return await client.hover(file, line, char);
        case "document_symbols":
          return await client.documentSymbols(file);
        case "workspace_symbol":
          return await client.workspaceSymbol(String(args.query ?? ""));
        default:
          return `Unknown operation: ${op}`;
      }
    } catch (error: any) {
      return `LSP error: ${error?.message ?? error}`;
    }
  },
  serial: false,
  compactResult(args) {
    const parts = [`[lsp ${args.operation}`];
    if (args.file) parts.push(`file="${args.file}"`);
    if (args.line) parts.push(`line=${args.line}`);
    if (args.query) parts.push(`query="${args.query}"`);
    return `${parts.join(" ")}]`;
  },
} satisfies ToolDefinition;
