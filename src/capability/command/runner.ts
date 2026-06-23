// @desc Command runner — stateless directory scanner + ESM cache-bust import + dispatcher

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPathManager } from "../../fs/path-manager.js";
import type { CommandModule, CommandSpec, CommandResult, ModuleContext, CallContext } from "./types.js";

const LAYERS = ["instance", "team"] as const;
type Layer = (typeof LAYERS)[number];

function dirOf(layer: Layer): string {
  const pm = getPathManager();
  return layer === "instance" ? pm.instance().commandsDir() : pm.team().commandsDir();
}

/** Dynamic-import with mtime cache bust. Returns the module or an error string. */
async function importModule(path: string): Promise<CommandModule | string> {
  let mtime = 0;
  try { mtime = statSync(path).mtimeMs; } catch { /* file vanished */ }
  try {
    const mod = (await import(`${pathToFileURL(path).href}?t=${mtime}`)) as { default?: CommandModule };
    if (!mod.default || typeof mod.default.list !== "function") return "module has no default CommandModule export";
    return mod.default;
  } catch (err) {
    return (err as Error)?.message ?? String(err);
  }
}

function errSpec(name: string, msg: string): CommandSpec {
  return { name: `_error:${name}`, description: msg, hasQuery: false, hasExecute: false };
}

interface ScannedEntry { spec: CommandSpec; mod: CommandModule | null; }

/** Scan one layer; failures become synthetic `_error:*` specs (never throw). */
async function scanLayer(layer: Layer, ctx: ModuleContext): Promise<ScannedEntry[]> {
  const dir = dirOf(layer);
  if (!existsSync(dir)) return [];

  const out: ScannedEntry[] = [];
  const seen = new Map<string, string>();  // name → first owning file
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const r = await importModule(join(dir, file));
    if (typeof r === "string") {
      out.push({ spec: errSpec(file, `${file}: ${r}`), mod: null });
      continue;
    }
    try {
      for (const s of await r.list(ctx)) {
        const prev = seen.get(s.name);
        if (prev !== undefined) {
          out.push({ spec: errSpec(`duplicate:${s.name}`, `same-layer duplicate "${s.name}" in ${file} (first: ${prev})`), mod: null });
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

/** List all commands. Cross-layer same-name: team wins. */
export async function listAllCommands(ctx: ModuleContext): Promise<CommandSpec[]> {
  const byName = new Map<string, CommandSpec>();
  for (const layer of LAYERS) {
    for (const { spec } of await scanLayer(layer, ctx)) byName.set(spec.name, spec);
  }
  return [...byName.values()];
}

/** Find the module providing `name`. Team scanned first (team wins). */
async function findModule(name: string, ctx: ModuleContext): Promise<CommandModule | null> {
  for (const layer of ["team", "instance"] as const) {
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
