/** appendToolAudit 单测 —— 审计行追加到 session 数据目录(经 path-manager)且字段完整。 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendToolAudit } from '../src/kernel/tool-audit';
import { initPathManager, resetPathManager } from '../src/fs/path-manager';

// 审计落 `getPathManager().session(sid).root()` = `<userRoot>/sessions/<sid>/`。
// 用 initPathManager({ userRoot }) 把单例沙箱到临时目录,避免污染 ~/.forgeax。
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tool-audit-test-'));
  initPathManager({ userRoot: tmpDir });
});

afterEach(() => {
  resetPathManager();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function auditFile(sid: string): string {
  return join(tmpDir, 'sessions', sid, 'kernel-tool-audit.jsonl');
}

describe('appendToolAudit', () => {
  test('两条审计行追加到 session 根的 kernel-tool-audit.jsonl', () => {
    const sid = 'test-session-abc';
    const entry1 = { sid, agent: 'forge', tool: 'read_file', trustTier: 'own', allow: true, ok: true, durationMs: 42, ts: 1000000 };
    const entry2 = { sid, agent: 'reia', tool: 'Bash', trustTier: 'imported', allow: false, error: 'denied by trust tier', durationMs: 5, ts: 1000100 };

    appendToolAudit(entry1);
    appendToolAudit(entry2);

    const lines = readFileSync(auditFile(sid), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const p1 = JSON.parse(lines[0]);
    expect(p1.sid).toBe(sid);
    expect(p1.agent).toBe('forge');
    expect(p1.tool).toBe('read_file');
    expect(p1.trustTier).toBe('own');
    expect(p1.allow).toBe(true);
    expect(p1.ok).toBe(true);
    expect(p1.durationMs).toBe(42);
    expect(p1.ts).toBe(1000000);

    const p2 = JSON.parse(lines[1]);
    expect(p2.agent).toBe('reia');
    expect(p2.tool).toBe('Bash');
    expect(p2.trustTier).toBe('imported');
    expect(p2.allow).toBe(false);
    expect(p2.error).toBe('denied by trust tier');
  });

  test('文件不存在时自动创建目录', () => {
    const sid = 'brand-new-session-xyz';
    appendToolAudit({ sid, agent: 'forge', tool: 'list_games', trustTier: 'own', allow: true, ok: true, durationMs: 1, ts: 9999 });
    const lines = readFileSync(auditFile(sid), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).tool).toBe('list_games');
  });

  test('audit 绝不抛出', () => {
    expect(() => {
      appendToolAudit({ sid: 'x', agent: 'y', tool: 'z', trustTier: 'own', allow: true, ok: true, durationMs: 0, ts: 0 });
    }).not.toThrow();
  });
});
