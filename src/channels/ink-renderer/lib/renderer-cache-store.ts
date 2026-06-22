// @desc Renderer cache store — in-memory state with debounced atomic persistence
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStateDir } from "../../../fs/state-dir.js";
import type { DraftSnapshot } from "./renderer-config.js";

export interface InkCache {
  agentByInstance?: Record<string, string>;
  drafts?: Record<string, Record<string, DraftSnapshot>>;
  terminalSetupDismissed?: boolean;
  [k: string]: unknown;
}

const FLUSH_DEBOUNCE_MS = 200;

function cachePath(): string {
  return join(resolveStateDir(), "cache", "renderer", "ink-cache.json");
}

function readCache(path: string): InkCache {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function serialize(cache: InkCache): string {
  return JSON.stringify(cache, null, 2) + "\n";
}

async function atomicWrite(path: string, text: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf-8");
  await rename(tmp, path);
}

function atomicWriteSync(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

class RendererCacheStore {
  private readonly path = cachePath();
  private cache: InkCache = readCache(this.path);
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  snapshot(): InkCache {
    return this.cache;
  }

  update(mutator: (cache: InkCache) => boolean | void): void {
    const changed = mutator(this.cache);
    if (changed === false) return;
    this.scheduleFlush();
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    atomicWriteSync(this.path, serialize(this.cache));
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      atomicWrite(this.path, serialize(this.cache)).catch(() => {});
    }, FLUSH_DEBOUNCE_MS);
  }
}

export const rendererCacheStore = new RendererCacheStore();
