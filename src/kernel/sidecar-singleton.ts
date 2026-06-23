/**
 * ensureSidecar —— server 侧懒启 + 连接 ring-0 `agent-host`(singleton)。
 *
 * 试连已有实例;连不上 → `Bun.spawn` agent-host(随 server 生命周期;agent-host 自身单例,
 * 重复 spawn 安全)→ 重试连接。缓存 client;连接失效下次重连。
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';
import { SidecarClient, defaultSockPath } from './sidecar-client';

/** sidecar(agent-host)serve 入口:经**包解析**定位(发布后跨包仍成立),
 *  monorepo 源码态回退到相对路径(发包前过渡)。耦合从「硬编码兄弟路径」收敛到
 *  「`@forgeax/agent-host` 包依赖 + `./serve` 导出」——见 package.json。 */
function resolveAgentHostMain(): string {
  try {
    return fileURLToPath(import.meta.resolve('@forgeax/agent-host/serve'));
  } catch {
    return resolve(import.meta.dir, '../../../agent-host/src/main.ts');
  }
}
const AGENT_HOST_MAIN = resolveAgentHostMain();

let cached: SidecarClient | null = null;
let proc: Subprocess | null = null;

async function tryConnect(): Promise<SidecarClient | null> {
  try {
    const c = await SidecarClient.connect(defaultSockPath(), 1000);
    await c.ping();
    return c;
  } catch {
    return null;
  }
}

export async function ensureSidecar(): Promise<SidecarClient> {
  if (cached) {
    try { await cached.ping(); return cached; } catch { cached = null; }
  }
  // 1) 已有实例?
  const existing = await tryConnect();
  if (existing) { cached = existing; return cached; }

  // 2) 懒启 agent-host(共享 server 的 env,含 FORGEAX_AGENT_HOST_SOCK)。
  if (!proc || proc.killed) {
    proc = Bun.spawn({
      cmd: ['bun', AGENT_HOST_MAIN],
      env: process.env as Record<string, string>,
      stdout: 'ignore',
      stderr: 'inherit',
    });
  }

  // 3) 重试连接。
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const c = await tryConnect();
    if (c) { cached = c; return cached; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('sidecar (agent-host) not reachable after spawn');
}

/** 测试/关停用。 */
export function resetSidecarSingleton(): void {
  try { cached?.close(); } catch { /* ignore */ }
  cached = null;
  try { proc?.kill(); } catch { /* ignore */ }
  proc = null;
}
