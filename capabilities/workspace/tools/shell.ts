// @desc Run a shell command in a persistent bash session, or wait on a backgrounded terminal.
import { displayChalk as chalk } from "../lib/display-chalk.js";
import type { ToolDefinition, ToolOutput } from "#src/core/types.js";
import { TEAMBOARD_KEYS } from "#src/defaults/teamboard-vars.js";
import { getTerminalManager } from "#src/terminal/manager.js";

const DEFAULT_TIMEOUT = 30_000;
const INLINE_OUTPUT_LIMIT = 20_000;  // ~20 KB inline, beyond this → read from logFile

export default {
  name: "shell",
  condition: (ctx) => ctx.tree.roleOf(ctx.agentId) !== "admin",
  description:
    "Execute a shell command in a persistent bash session, OR wait on an existing backgrounded terminal. " +
    "State (cwd, venv, exports) persists across calls. " +
    "New commands exceeding timeout_ms are auto-backgrounded — the return includes their terminal_id. " +
    "To continue waiting on a backgrounded command, call again with `terminal_id` (and optional timeout_ms); " +
    "if the command finishes within the new window the full result is returned, otherwise a snapshot + still_running hint. " +
    "Set run_in_background to immediately background long-running commands (dev servers, watchers). " +
    "Do NOT use grep/find/cat/sed/awk — use the dedicated tools instead. " +
    "Quote paths with spaces. Chain with ';' or '&&', not newlines.",
  guidance: "**shell**: Always provide the description parameter (5-10 words, active voice, e.g. 'Install project dependencies'). For long commands (git clone of large repo, npm install, mass file ops) pass a larger `timeout_ms` up front; if the command still outlasts it and is backgrounded, resume with `{terminal_id, timeout_ms}` instead of sleep + read_file polling.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute. Omit when using `terminal_id` to wait on an existing backgrounded terminal.",
      },
      description: {
        type: "string",
        description: "Concise description of what this command does (5-10 words)",
      },
      cwd: {
        type: "string",
        description: "Working directory. Relative paths resolve from CURRENT_DIR. Defaults to CURRENT_DIR.",
      },
      timeout_ms: {
        type: "integer",
        description: "For a new command: timeout before auto-backgrounding (default 30000). For wait-on-existing: max wait before returning a still_running snapshot (default 30000). Pass 0 with terminal_id for an immediate status snapshot.",
      },
      run_in_background: {
        type: "boolean",
        description: "Immediately background a new command without waiting. Use for dev servers, watchers, or long-running processes. Read the returned logFile or call with `terminal_id` to poll/wait. Ignored when `terminal_id` is set.",
      },
      terminal_id: {
        type: "string",
        description: "Resume waiting on a previously backgrounded terminal (from an earlier shell call's return). Mutually exclusive with `command`. Returns status=done (with exit code + full stdout) if it finished within timeout_ms, otherwise status=still_running + snapshot.",
      },
    },
    required: [],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const terminalId = args.terminal_id ? String(args.terminal_id) : undefined;
    const command = args.command ? String(args.command) : undefined;

    if (terminalId && command) {
      return "Error: pass either `command` (to run a new command) or `terminal_id` (to wait on an existing one), not both.";
    }
    if (!terminalId && !command) {
      return "Error: must pass either `command` or `terminal_id`.";
    }

    const terminalManager = getTerminalManager();

    // ── Wait-on-existing branch ──
    if (terminalId) {
      const waitMs = (args.timeout_ms as number | undefined) ?? DEFAULT_TIMEOUT;
      const result = await terminalManager.wait(terminalId, waitMs, ctx.signal);

      if (result.status === "not_found") {
        return `Terminal '${terminalId}' not found. Either the ID is wrong, it was cleaned up (terminals >1h old are garbage-collected), or the instance restarted.`;
      }

      const parts: string[] = [];
      if (result.status === "done") {
        parts.push(`Exit code: ${result.exitCode ?? "unknown"}`);
        if (result.elapsedMs !== undefined) {
          parts.push(`Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`);
        }
      } else {
        // still_running
        parts.push(`[still running] Terminal '${terminalId}' has not finished within the wait window.`);
        parts.push(`Call shell again with terminal_id="${terminalId}" (and adjust timeout_ms) to keep waiting.`);
      }
      appendStdout(parts, result.stdout, result.logFile);
      return parts.join("\n");
    }

    // ── Run-new-command branch (original behavior) ──
    const cwd = args.cwd ? String(args.cwd) : undefined;
    const initialCwd = ctx.teamBoard.get(ctx.agentId, TEAMBOARD_KEYS.CURRENT_DIR) as string | undefined;
    const runInBackground = !!args.run_in_background;
    const timeout = runInBackground ? 1 : ((args.timeout_ms as number) ?? DEFAULT_TIMEOUT);

    const description = args.description ? String(args.description) : undefined;
    const result = await terminalManager.exec(command!, {
      cwd,
      initialCwd,
      agentId: ctx.agentId,
      timeout,
      description,
      signal: ctx.signal,
    });

    if (result.cwd) {
      ctx.teamBoard.set(ctx.agentId, TEAMBOARD_KEYS.CURRENT_DIR, result.cwd, { persist: false });
    }

    const parts: string[] = [];
    if (result.backgrounded) {
      parts.push(`[backgrounded] Command still running in the background as terminal_id="${result.terminalId}".`);
      parts.push(`Shell state (cwd, venv, exports) is preserved — you can run the next command normally.`);
      parts.push(`To wait for completion: call shell again with terminal_id="${result.terminalId}" and timeout_ms=<ms>.`);
      parts.push(`To poll without blocking: read_file("${result.logFile}")`);
    } else {
      parts.push(`Exit code: ${result.exitCode ?? "unknown"}`);
    }
    appendStdout(parts, result.stdout, result.logFile);
    return parts.join("\n");
  },
  compactResult(args, result) {
    const cmd = String(args.command ?? (args.terminal_id ? `wait ${args.terminal_id}` : ""));
    const tail = result.length > 400 ? "...\n" + result.slice(-400) : result;
    return `[shell] $ ${cmd}\n${tail}`;
  },
  formatDisplay(args, result) {
    const cmd = args.command ? String(args.command) : (args.terminal_id ? `wait ${args.terminal_id}` : "");
    const res = typeof result === "string" ? result : "";
    const desc = args.description ? String(args.description) : null;
    const cmdShort = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    const label = desc ?? cmdShort;

    if (res.includes("[backgrounded]"))
      return chalk.cyan(label) + " " + chalk.yellow("[backgrounded]");
    if (res.includes("[still running]"))
      return chalk.cyan(label) + " " + chalk.yellow("[still running]");

    const exitMatch = res.match(/^Exit code: (\d+)/);
    const code = exitMatch ? Number(exitMatch[1]) : null;
    const tag = code === 0
      ? chalk.green("[exit 0]")
      : code !== null ? chalk.red(`[exit ${code}]`) : "";

    return chalk.cyan(label) + " " + tag;
  },
} satisfies ToolDefinition;

/** Shared stdout formatting: inline when small, head+tail with omitted marker when large. */
function appendStdout(parts: string[], stdout: string, logFile: string): void {
  if (!stdout) return;
  if (stdout.length > INLINE_OUTPUT_LIMIT && logFile) {
    const head = stdout.slice(0, 2000);
    const tail = stdout.slice(-2000);
    parts.push(
      "",
      head,
      `\n[... ${((stdout.length - 4000) / 1024).toFixed(0)} KB omitted — full output in logFile ...]\n`,
      tail,
      `\nFull output: read_file("${logFile}")`,
    );
  } else {
    parts.push("", stdout);
  }
}
