/**
 * A-01 — `--output-format text|json|stream-json`(print 模式机器可读输出)。
 * spawn 真 CLI(--demo,无网无 key)验证三分支;stdout 在 json 模式必须纯净可 parse。
 */
import { test, expect, describe } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli', 'main.ts');
function run(args: string[]): { stdout: string; code: number } {
  const r = spawnSync('bun', [CLI, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout ?? '', code: r.status ?? -1 };
}

describe('A-01 --output-format', () => {
  test('json:stdout 是单个合法 JSON result 对象', () => {
    const { stdout } = run(['--demo', '-p', 'hello', '--output-format', 'json', '--no-memory']);
    const obj = JSON.parse(stdout.trim());
    expect(obj.type).toBe('result');
    expect(obj.is_error).toBe(false);
    expect(typeof obj.result).toBe('string');
    expect(obj.result).toContain('hello'); // demo echoes prompt
    expect(obj.reason).toBe('completed');
  });

  test('stream-json:每行都是可 parse 的 NDJSON 事件', () => {
    const { stdout } = run(['--demo', '-p', 'hello', '--output-format', 'stream-json', '--no-memory']);
    const lines = stdout.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    // 含 assistant 事件且有 done 事件(轮终)。
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain('assistant');
    expect(types).toContain('done');
  });

  test('默认(不带 flag)= text:非 JSON,含 demo echo', () => {
    const { stdout } = run(['--demo', '-p', 'hello', '--no-memory']);
    expect(stdout).toContain('hello');
    expect(() => JSON.parse(stdout.trim())).toThrow(); // 人类可读,非 JSON
  });
});
