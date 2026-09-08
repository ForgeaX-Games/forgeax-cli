/**
 * 上下文压缩触发 e2e —— 驱动**真实 forgeax-cli 二进制**(子进程,`--demo` 免 API key),
 * 用脚本预置一段长历史 WAL,验证「`--resume` 这个会话 + 发一条消息」一上来就越过压缩水位、
 * 触发 compaction,整条链路在真实进程下闭环:
 *   seed WAL → resume fold 出历史 → loop 估 token 越水位 → V2 闸放行 → 压缩 → 事件落盘。
 *
 * 观测点是 WAL 本身(SSOT、事件流即真相):压缩成功会把 `compaction.applied` 经同一 bus
 * connectStore 落进 events.jsonl,跨进程可读、确定性断言,不依赖 stdout 渲染文字。
 *
 * 触发靠 `FORGEAX_COMPACT_WINDOW` 把模型窗口钳小(effective = 钳后窗口 - 20000;
 * emergency = effective×0.92),让一段适中历史就越线 —— 无需造 660KB 真实历史。
 * 负向 control 用同一份历史、不钳窗口(真 200k 窗口)→ 不触发,证明断言非恒真。
 *
 * hermetic:`--demo` 内置 echo provider(连 summarize 也走它),全程不打网络;属 `bun test`。
 * Boundary(HOST/test 层):node: + Bun + 相对 import(含 scripts/ 的 seed builder)。
 */
import { test, expect, describe, beforeAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedSession } from '../scripts/seed-session';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

interface RunResult {
  code: number | null;
  /** WAL 里每个事件的 type(顺序保留)。 */
  types: string[];
  /** compaction.applied 事件的 payload(若有)。 */
  applied: Array<{ coveredFrom?: number; coveredTo?: number; replacement?: unknown }>;
  /** compaction.failed 诊断;demo provider 原样回显时用于验证有界 fail-closed。 */
  failed: Array<{ diagnostics?: { reason?: string }; type?: string }>;
}

/** 读 WAL events.jsonl → 投影出 type 列表 + compaction.applied 载荷(坏行跳过)。 */
function readWal(file: string): Pick<RunResult, 'types' | 'applied' | 'failed'> {
  const types: string[] = [];
  const applied: RunResult['applied'] = [];
  const failed: RunResult['failed'] = [];
  if (!existsSync(file)) return { types, applied, failed };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as { type: string; payload?: unknown };
      types.push(e.type);
      if (e.type === 'compaction.applied') applied.push((e.payload ?? {}) as RunResult['applied'][number]);
      if (e.type === 'compaction.failed') failed.push((e.payload ?? {}) as RunResult['failed'][number]);
    } catch {
      /* skip corrupt line */
    }
  }
  return { types, applied, failed };
}

/** seed 一段历史 → `--demo --resume <id> -p` 发一条消息 → 读回 WAL。extraEnv 控制窗口钳制。 */
async function seedAndResume(
  dir: string,
  sessionId: string,
  extraEnv: Record<string, string>,
  turns = 20,
): Promise<RunResult & { estTokens: number }> {
  const sessionsDir = join(dir, 'sessions');
  const { file, estTokens } = seedSession({ sessionsDir, sessionId, turns });
  const proc = Bun.spawn(['bun', MAIN, '--demo', '--no-memory', '--sessions-dir', sessionsDir, '--resume', sessionId, '-p', '继续'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      // Hermetic: do not let the developer's persisted model/settings alter watermarks.
      FORGEAX_CONFIG_DIR: join(dir, 'config'),
      ...extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, estTokens, ...readWal(file) };
}

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'forgeax-compact-resume-'));
});

describe('compaction trigger on resume (real binary, --demo, no network)', () => {
  test(
    'clamped window + non-compressive demo summary → compaction fires and fails closed at bounded split depth',
    async () => {
      // effective = 29000 - 20000 = 9000;emergency = 8280。40 turns 越线且可在严格 75% 叶上限内收敛。
      const r = await seedAndResume(root, 'trigger', { FORGEAX_COMPACT_WINDOW: '29000' }, 40);
      expect(r.code).toBe(0);
      expect(r.estTokens).toBeGreaterThan(8280); // 预置历史确实越过 emergency 水位
      // demo provider 原样回显，无法把高于 92% 水位的输入压到严格 75% 叶上限内；
      // 管线必须在有界深度明确失败，不能放宽上限或把原请求送给主 provider。
      expect(r.applied).toHaveLength(0);
      expect(r.types).toContain('compaction.pre');
      expect(r.types).toContain('compaction.failed');
      expect(r.types).not.toContain('compaction.post');
      expect(r.failed).toHaveLength(1);
      expect(r.failed[0]?.type).toBe('pre-message-auto');
      expect(r.failed[0]?.diagnostics?.reason).toBe('split_exhausted');
    },
    60_000,
  );

  test(
    'same history, full real window → no compaction (assertion is not vacuous)',
    async () => {
      // 不钳窗口:默认 claude-opus-4-8 → 200k 窗口,emergency ~165k ≫ ~5200 token → 不触发。
      const r = await seedAndResume(root, 'control', {});
      expect(r.code).toBe(0);
      expect(r.applied.length).toBe(0);
      expect(r.types).not.toContain('compaction.applied');
      // 但这一轮确实正常跑完了(新的 user_prompt.submit 落了盘),证明"没触发"≠"没跑"。
      expect(r.types.filter((t) => t === 'user_prompt.submit').length).toBeGreaterThan(20);
    },
    60_000,
  );
});
