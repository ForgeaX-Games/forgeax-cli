// @desc Command runner — stateless directory scanner + ESM cache-bust import + dispatcher
//
// 镜像 agenteam-os-ref/src/capability/command/runner.ts（含同一份注释口径）。
// 与 ref 的差异仅在层名：agenteam 是 `team` + `instance`，forgeax 是 `builtin`。
// builtin 层 = `packages/server/builtin/commands/`（与 builtin/kits 并列，由
// PathManager 的 ResourceKind="commands" 单点解析）。未来按 plan 接入用户/
// 会话级 overlay 时，在 LAYERS 数组里追加即可（user / session）。

import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPathManager } from "../fs/path-manager";
import type {
  CallContext,
  CommandModule,
  CommandResult,
  CommandSpec,
  ModuleContext,
} from "./types";

// `require.cache` access for bun ESM —— see comment on `importModule` below.
const _localRequire = createRequire(import.meta.url);

const LAYERS = ["builtin"] as const;
type Layer = (typeof LAYERS)[number];

/** Resolve layer dir。builtin → `pm.builtin().resourceDir("commands")`（与
 *  kits / agent-templates / tree-templates 同位）。env override
 *  `FORGEAX_COMMANDS_DIR` 给 e2e test 用：把目录指到 tmpdir 里塞 fake module。
 *  未来 user / session overlay 接入时，这个 switch 里加 case 即可。 */
function dirOf(layer: Layer): string {
  if (layer === "builtin") {
    if (process.env.FORGEAX_COMMANDS_DIR) return process.env.FORGEAX_COMMANDS_DIR;
    return getPathManager().builtin().resourceDir("commands");
  }
  throw new Error(`commands runner: unknown layer ${layer}`);
}

/** Per-path mtime ledger —— 只在文件确实变了的时候才删 require.cache + 重 import，
 *  避免每次 list/query/execute 都付 import 成本。第一次见到的文件、mtime 变化的文件
 *  会触发 reload；mtime 没变的命中现有 ESM cache。 */
const _lastSeenMtime = new Map<string, number>();

/** Dynamic-import with mtime-driven cache bust.
 *
 *  agenteam-os-ref 在 Node 上用 `import("file:///path?t=<mtime>")` 实现 cache-bust ——
 *  Node 把整个 URL（包括 query）作为 module cache key。bun 不一样（issue oven-sh/bun#21346）：
 *  query 段被 normalize 掉，URL 不带 query 总是命中第一次导入的 module。所以这里改成
 *  Jarred-Sumner 在 oven-sh/bun#14435 给的官方做法 —— `delete require.cache[path] + import`。
 *
 *  注意点：
 *   - bun ESM 下 `require.cache` 是**绝对 path → module** 的真实 Map（不是 URL key），
 *     用 `createRequire(import.meta.url).cache` 取最稳。
 *   - require.cache 只清一级；嵌套 deps 不重 load。CommandModule 是顶层 single-file，
 *     不分享 transitive state，对我们的语义来说够用（如果命令模块依赖某个 shared
 *     helper 文件，那个 helper 的更新需要重启 server —— 与 agenteam-ref 行为一致）。
 *   - mtime 不变就不动 cache：跑 list_commands / 频繁 dispatch 时零开销。 */
async function importModule(path: string): Promise<CommandModule | string> {
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { /* file vanished */ }

  const prev = _lastSeenMtime.get(path);
  if (prev !== mtime) {
    delete _localRequire.cache[path];
    _lastSeenMtime.set(path, mtime);
  }

  try {
    const mod = (await import(pathToFileURL(path).href)) as { default?: CommandModule };
    if (!mod.default || typeof mod.default.list !== "function") {
      return "module has no default CommandModule export";
    }
    return mod.default;
  } catch (err) {
    return (err as Error)?.message ?? String(err);
  }
}

/** Test-only —— reset the mtime ledger so each test runs cache-busted. */
export function _resetImportLedger(): void {
  _lastSeenMtime.clear();
}

function errSpec(name: string, msg: string): CommandSpec {
  return { name: `_error:${name}`, description: msg, hasQuery: false, hasExecute: false };
}

interface ScannedEntry { spec: CommandSpec; mod: CommandModule | null }

/** Scan one layer; failures become synthetic `_error:*` specs (never throw).
 *  与 ref 一致：bad module → `_error:<file>` spec；同层同名冲突 → `_error:duplicate:*`。 */
async function scanLayer(layer: Layer, ctx: ModuleContext): Promise<ScannedEntry[]> {
  const dir = dirOf(layer);
  if (!existsSync(dir)) return [];

  const out: ScannedEntry[] = [];
  const seen = new Map<string, string>(); // name → first owning file
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"));
  } catch { return []; }

  for (const file of files) {
    const r = await importModule(join(dir, file));
    if (typeof r === "string") {
      out.push({ spec: errSpec(file, `${file}: ${r}`), mod: null });
      continue;
    }
    try {
      for (const s of await r.list(ctx)) {
        const prev = seen.get(s.name);
        if (prev !== undefined) {
          out.push({
            spec: errSpec(`duplicate:${s.name}`, `same-layer duplicate "${s.name}" in ${file} (first: ${prev})`),
            mod: null,
          });
          continue;
        }
        seen.set(s.name, file);
        out.push({ spec: s, mod: r });
      }
    } catch (err) {
      out.push({ spec: errSpec(file, `${file} list() threw: ${(err as Error)?.message ?? String(err)}`), mod: null });
    }
  }
  return out;
}

/** List all commands. R3 阶段单层；与 ref 行为对齐：跨层同名后扫的覆盖前扫的（team wins）。 */
export async function listAllCommands(ctx: ModuleContext): Promise<CommandSpec[]> {
  const byName = new Map<string, CommandSpec>();
  for (const layer of LAYERS) {
    for (const { spec } of await scanLayer(layer, ctx)) byName.set(spec.name, spec);
  }
  return [...byName.values()];
}

/** Find the module providing `name`. 后扫的层级胜出（与 ref 同向）。 */
async function findModule(name: string, ctx: ModuleContext): Promise<CommandModule | null> {
  // 反向扫描，让后扫的层级胜出 —— R3 单层时退化为普通查找。
  for (const layer of [...LAYERS].reverse()) {
    for (const { spec, mod } of await scanLayer(layer, ctx)) {
      if (mod && spec.name === name) return mod;
    }
  }
  return null;
}

async function callSegment(
  kind: "query" | "execute",
  name: string,
  args: string[],
  ctx: CallContext,
): Promise<CommandResult> {
  try {
    const mod = await findModule(name, ctx);
    if (!mod) return { ok: false, error: `Unknown command: ${name}` };
    const fn = mod[kind];
    if (!fn) return { ok: false, error: `Command "${name}" has no ${kind}` };
    return { ok: true, data: await fn(name, args ?? [], ctx) };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

export const callQuery   = (name: string, args: string[], ctx: CallContext): Promise<CommandResult> => callSegment("query",   name, args, ctx);
export const callExecute = (name: string, args: string[], ctx: CallContext): Promise<CommandResult> => callSegment("execute", name, args, ctx);
