/**
 * H-01 跨进程 rewind→resume e2e —— 驱动**真实 forgeax-cli 二进制** `--resume`,验证
 * WAL 里的 append-only `rewind.applied` 事件让被回退轮次在跨进程 fold 时被排除,
 * 不会「复活」进喂给模型的历史。
 *
 * 复现的 bug:回退后继续对话,旧轮次仍原样留在 WAL 且无遮蔽标记 → 跨进程 `--resume` 把
 * 回退前后串成一条。这里预置一个「turn0 → turn1(被回退)→ rewind.applied(保留 turn0)」
 * 的 WAL,再用真进程 `--resume -p "turn2"`:
 *   观测点:mock provider 收到的请求 messages 里出现 turn0 的正文、但**不含被回退的 turn1**。
 *
 * 与 rewind-wal.test.ts(单元,直调 foldFromStore)互补:本测试钉死**真实 --resume 命令**
 * 走的 foldSessionHistory 路径确实吃到了遮蔽。全程离线(mock SSE),属 `bun test`。
 * Boundary(test 层):node: + Bun + 相对 import。
 */
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const MAIN = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');

function sse(frames: Array<{ event: string; data: unknown }>): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}
function textTurn(text: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', role: 'assistant', model: 'x', usage: { input_tokens: 9, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';
/** 每次主对话请求的全部 messages 正文拼串(供断言"含/不含"某轮)。 */
let mainReqTexts: string[] = [];

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const x = b as { text?: string; content?: unknown };
        if (typeof x.text === 'string') return x.text;
        if (typeof x.content === 'string') return x.content;
        return JSON.stringify(b);
      })
      .join(' ');
  }
  return JSON.stringify(content);
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { system?: Array<{ text?: string }>; messages?: Array<{ content?: unknown }> };
      const sys = (body.system ?? []).map((b) => b.text ?? '').join('\n');
      if (!sys.includes('extract durable') && !sys.includes('select which stored memories')) {
        mainReqTexts.push((body.messages ?? []).map((m) => flatten(m.content)).join(' || '));
      }
      return new Response(textTurn('ack'), { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_rewind_e2e' } });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(() => server?.stop(true));

/** 预置一个含 rewind.applied 的会话 WAL(模拟 driver 回退后写下的遮蔽事件)。 */
function seedWal(file: string): void {
  const ev = (type: string, payload: unknown) => JSON.stringify({ type, payload, ts: 0 });
  const lines = [
    ev('user_prompt.submit', { prompt: 'KEEP-turn-zero', turn: 0 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'assistant-zero' }] }),
    ev('user_prompt.submit', { prompt: 'REWOUND-turn-one', turn: 1 }),
    ev('assistant.message', { role: 'assistant', content: [{ type: 'text', text: 'assistant-one-REWOUND' }] }),
    // 回退:保留第 0 轮 → 遮蔽从第 1 个 user_prompt.submit 起、本事件之前的会话。
    ev('rewind.applied', { rewindId: 'r-1', keepUserTurns: 1 }),
  ];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
}

async function runResume(sessionsDir: string, sessionId: string, prompt: string): Promise<number> {
  const proc = Bun.spawn(['bun', MAIN, '--no-memory', '--sessions-dir', sessionsDir, '--resume', sessionId, '-p', prompt], {
    cwd: join(import.meta.dir, '..'),
    env: { ...process.env, ANTHROPIC_API_KEY: 'dummy-rewind-e2e', ANTHROPIC_BASE_URL: baseUrl, FORGEAX_MODEL: 'forgeax-e2e' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return proc.exited;
}

describe('cross-process rewind→resume (real --resume folds a WAL with rewind.applied)', () => {
  test('rewound turn is masked: resumed provider request keeps turn0 but drops the rewound turn1', async () => {
    mainReqTexts = [];
    const root = mkdtempSync(join(tmpdir(), 'fxc-rewind-proc-'));
    const sessionsDir = join(root, 'sessions');
    const wal = join(sessionsDir, 'sessR', 'events.jsonl');
    try {
      seedWal(wal);
      const code = await runResume(sessionsDir, 'sessR', 'turn-two-new');
      expect(code).toBe(0);

      // 主对话请求的历史:含保留轮正文,不含被回退轮正文。
      const req = mainReqTexts.join('\n');
      expect(req).toContain('KEEP-turn-zero');
      expect(req).toContain('assistant-zero');
      expect(req).toContain('turn-two-new');
      expect(req).not.toContain('REWOUND-turn-one');
      expect(req).not.toContain('assistant-one-REWOUND');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 45000);
});
