/**
 * T1 —— TUI 启动 boot rehydrate:带 --resume/--continue 且会话有 WAL 历史时,首帧 mount 后
 * 自动回灌历史(transcript 半边 + LLM reseed 半边),而非「只连 WAL 追加、从不回放」。
 *
 * 复现旧 bug:runTui 只把 sessionId 连上 WAL,启动后 transcript 空白、下一轮模型看不到历史。
 * 修法:runTui 判定有历史 → 置 bootResumeId 经 BootResumeProvider 注入;Repl mount effect
 * 调一次现成 doResume(它 = agent.resumeSession reseed LLM + session.replaceAll 回灌 transcript)。
 *
 * 测法(真链路,不 mock):driver1(demo)写一轮 WAL{marker} → dispose;driver2(同 session)
 * 经真实 <App bootResumeId> 渲染 → mount effect 触发 doResume → transcript 出现 marker、
 * resumeSession 恰调一次;对照组无 bootResumeId → 不回灌、resumeSession 不被调。
 *
 * Boundary(test 层):相对 import + Bun + ink-testing-library。
 */
import { test, expect, describe, beforeEach, afterEach, spyOn } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHostContext } from '../../src/cli/host-context';
import { createAgentDriver } from '../../src/tui/driver/useAgent';
import { App } from '../../src/tui/app';
import { createRemoteController } from '../../src/tui/remote/controller';
import { createFakeChannel } from '../../src/tui/remote/fake-channel';

const ARGS = { model: 'claude-opus-4-8', demo: true } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let prevCwd: string;
beforeEach(() => {
  prevCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'boot-resume-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function mkDriver(sessionsDir: string, sessionId: string) {
  const host = await buildHostContext({ ...ARGS, sessionsDir, sessionId });
  return createAgentDriver({ ...ARGS, sessionsDir, sessionId }, host);
}

function mkController() {
  return createRemoteController(() => createFakeChannel({ label: 'x', autoLoginMs: 0, autoInboundMs: 0 }));
}

/** driver1:demo 跑一轮(marker 进 WAL user_prompt.submit)→ dispose(落盘)。 */
async function seedWal(sessionsDir: string, sessionId: string, marker: string): Promise<void> {
  const d1 = await mkDriver(sessionsDir, sessionId);
  try {
    await d1.driveTurn(`please remember ${marker}`, () => {});
  } finally {
    await d1.dispose();
  }
}

function seedLongWal(sessionsDir: string, sessionId: string, turns: number): void {
  const dir = join(sessionsDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const events = Array.from({ length: turns }, (_, i) => [
    {
      type: 'user_prompt.submit',
      ts: i * 2,
      payload: { prompt: i === 0 ? 'EARLY-WAL-MARKER' : `historical prompt ${i}` },
    },
    {
      type: 'assistant.message',
      ts: i * 2 + 1,
      payload: {
        role: 'assistant',
        content: [{ type: 'text', text: i === turns - 1 ? 'LATEST-WAL-MARKER' : `historical answer ${i}` }],
      },
    },
  ]).flat();
  writeFileSync(join(dir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
}

describe('T1 boot rehydrate(--resume/--continue 启动回放历史)', () => {
  test('有历史 + bootResumeId → mount 后 doResume 一次,transcript 回灌 marker', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    const MARK = 'MARK_BOOT_ALPHA';
    await seedWal(sessionsDir, 's1', MARK);

    const d2 = await mkDriver(sessionsDir, 's1');
    const spy = spyOn(d2, 'resumeSession');
    const ctrl = mkController();
    const ink = render(<App driver={d2} controller={ctrl} bootResumeId="s1" />);
    try {
      await sleep(400); // 等 mount effect → doResume(async 读 WAL + replaceAll) + 重渲染
      // ★ 关键1:mount effect 恰触发一次 resumeSession('s1')。
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe('s1');
      // ★ 关键2:transcript 半边回灌 —— 历史 marker 出现在渲染帧里(此前 bug 下为空白)。
      const rendered = ink.frames.join('\n');
      expect(rendered).toContain(MARK);
    } finally {
      ink.unmount();
      await ctrl.dispose();
      await d2.dispose();
    }
  });

  test('长历史完整恢复,但启动只 materialize 尾窗', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    seedLongWal(sessionsDir, 'long', 80);

    const d2 = await mkDriver(sessionsDir, 'long');
    const spy = spyOn(d2, 'resumeSession');
    const ctrl = mkController();
    const ink = render(<App driver={d2} controller={ctrl} bootResumeId="long" />);
    try {
      await sleep(400);
      expect(spy).toHaveBeenCalledTimes(1);
      const rendered = ink.frames.join('\n');
      expect(rendered).toContain('LATEST-WAL-MARKER');
      expect(rendered).toContain('160 条');
      expect(rendered).not.toContain('EARLY-WAL-MARKER');
    } finally {
      ink.unmount();
      await ctrl.dispose();
      await d2.dispose();
    }
  });

  test('无 bootResumeId(普通新会话)→ 不回灌、resumeSession 不被调(对照组)', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    const MARK = 'MARK_BOOT_BETA';
    await seedWal(sessionsDir, 's2', MARK);

    const d2 = await mkDriver(sessionsDir, 's2');
    const spy = spyOn(d2, 'resumeSession');
    const ctrl = mkController();
    const ink = render(<App driver={d2} controller={ctrl} />); // 无 bootResumeId
    try {
      await sleep(400);
      expect(spy).not.toHaveBeenCalled();
      expect(ink.frames.join('\n')).not.toContain(MARK);
    } finally {
      ink.unmount();
      await ctrl.dispose();
      await d2.dispose();
    }
  });

  test('去重:重复 rerender 不二次 doResume(useRef 只跑一次)', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    await seedWal(sessionsDir, 's3', 'MARK_BOOT_GAMMA');

    const d2 = await mkDriver(sessionsDir, 's3');
    const spy = spyOn(d2, 'resumeSession');
    const ctrl = mkController();
    const ink = render(<App driver={d2} controller={ctrl} bootResumeId="s3" />);
    try {
      await sleep(200);
      ink.rerender(<App driver={d2} controller={ctrl} bootResumeId="s3" />);
      ink.rerender(<App driver={d2} controller={ctrl} bootResumeId="s3" />);
      await sleep(200);
      expect(spy).toHaveBeenCalledTimes(1); // 仍只一次
    } finally {
      ink.unmount();
      await ctrl.dispose();
      await d2.dispose();
    }
  });
});

describe('T1 resume 一致性探针(截断 WAL → warn)', () => {
  test('故意截断 WAL 尾行 → resumeSession console.warn', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    await seedWal(sessionsDir, 's4', 'MARK_TRUNC');
    // 故意在健康 WAL 末尾追加一条**被截断**的 assistant.message(半行,JSON 不闭合):
    //   loader 静默跳过它(parsedCount 不变),但盘上原始行数 +1 → 探针失配 → warn。
    const walFile = join(sessionsDir, 's4', 'events.jsonl');
    appendFileSync(walFile, '\n{"type":"assistant.message","payload":{"content":[{"typ', 'utf8');

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const d2 = await mkDriver(sessionsDir, 's4');
    try {
      const msgs = await d2.resumeSession('s4'); // 仍成功返回(graceful,不阻断)
      expect(msgs).not.toBeNull();
      const warned = warnSpy.mock.calls.some((c) => String(c[0] ?? '').includes('一致性探针'));
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
      await d2.dispose();
    }
  });

  test('健康 WAL → resumeSession 不 warn(无误报)', async () => {
    const sessionsDir = join(tmp, '.forgeax/sessions');
    await seedWal(sessionsDir, 's5', 'MARK_OK');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const d2 = await mkDriver(sessionsDir, 's5');
    try {
      await d2.resumeSession('s5');
      const warned = warnSpy.mock.calls.some((c) => String(c[0] ?? '').includes('一致性探针'));
      expect(warned).toBe(false);
    } finally {
      warnSpy.mockRestore();
      await d2.dispose();
    }
  });
});
