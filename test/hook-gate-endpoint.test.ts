/** 046 楔子3:/:sid/hook-gate 决策端点 集成测试(真 router,经 hono app.request,
 *  不起 HTTP)。settings 规则来自临时 projectRoot(FORGEAX_PROJECT_ROOT)+ 临时 HOME
 *  (封闭:不读真用户 ~/.forgeax)。
 *
 *  覆盖:deny 即拒 / allow 即批 / 未命中 none / ask 无活 session → fail-closed deny /
 *  permission-request 的规则前置(deny 免卡直拒)。弹卡路径需要活 session + 前端回执,
 *  属 e2e 面(docs/testing.md),不在此仿。 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createSessionsRouter } from '../src/api/sessions';
import { clearSettingsPermissionRulesCache } from '../src/api/lib/permission-settings';

let home: string;
let project: string;
let savedHome: string | undefined;
let savedRoot: string | undefined;
let app: Hono;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'fx-hookgate-home-'));
  project = mkdtempSync(join(tmpdir(), 'fx-hookgate-proj-'));
  savedHome = process.env.HOME;
  savedRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.HOME = home;
  process.env.FORGEAX_PROJECT_ROOT = project;
  mkdirSync(join(project, '.forgeax'), { recursive: true });
  writeFileSync(
    join(project, '.forgeax', 'settings.json'),
    JSON.stringify({
      permissions: {
        deny: ['Bash(rm *)'],
        ask: ['Bash(git push*)'],
        allow: ['Bash(git *)'],
      },
    }),
  );
  clearSettingsPermissionRulesCache();
  app = new Hono().route('/api/sessions', createSessionsRouter());
});

afterAll(() => {
  process.env.HOME = savedHome;
  if (savedRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = savedRoot;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  clearSettingsPermissionRulesCache();
});

async function postHookGate(body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request('/api/sessions/test-sid/hook-gate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /:sid/hook-gate', () => {
  test('deny 规则 → decision deny(命中复合命令子命令,无需活 session)', async () => {
    const { status, json } = await postHookGate({
      kernel: 'codex',
      toolName: 'Bash',
      input: { command: 'echo hi && rm -rf /tmp/x' },
    });
    expect(status).toBe(200);
    expect(json.decision).toBe('deny');
    expect(json.reason).toContain('Bash(rm *)');
  });

  test('allow 规则 → decision allow', async () => {
    const { json } = await postHookGate({ kernel: 'claude-code', toolName: 'Bash', input: { command: 'git status' } });
    expect(json.decision).toBe('allow');
  });

  test('未命中 → decision none(内核默认权限流接管)', async () => {
    const { json } = await postHookGate({ kernel: 'cursor', toolName: 'Write', input: { file_path: '/tmp/a' } });
    expect(json.decision).toBe('none');
  });

  test('ask 规则 + 无活 session → fail-closed deny(不能静默放行用户显式要求 ask 的操作)', async () => {
    const { json } = await postHookGate({ kernel: 'codex', toolName: 'Bash', input: { command: 'git push origin main' } });
    expect(json.decision).toBe('deny');
    expect(json.reason).toContain('no live session');
  });

  test('缺 toolName → none(形状非法不猜)', async () => {
    const { json } = await postHookGate({ kernel: 'codex', input: { command: 'x' } });
    expect(json.decision).toBe('none');
  });
});

describe('POST /:sid/permission-request 的规则前置', () => {
  test('deny 规则 → {allow:false} 免卡直拒(无 session 时仍先回 no-session;有规则命中的优先级见实现)', async () => {
    // 无活 session:端点先查 session → no-session。规则前置只对活 session 生效
    // (弹卡本就需要 session)。这里钉住 no-session 的既有回执不被规则改变。
    const res = await app.request('/api/sessions/test-sid/permission-request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', command: 'rm -rf /tmp/x' }),
    });
    const json = await res.json();
    expect(json.allow).toBe(false);
  });
});
