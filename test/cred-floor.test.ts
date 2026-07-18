import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { scrubbedSecretEnv } from '../src/cli-providers/shared/subprocess-jsonl';

// 凭据地板(T-C0 phase-1):imported 信任的 turn 在 spawn CLI 子进程前,把宿主
// 进程里非必要的应用密钥 scrub 掉(置 undefined → spawnJsonl 删除,不被继承)。
// 这里锁死 scrub 模型:已知 key + 泛化 /(_KEY|_SECRET|_TOKEN)$/ 命中置空,
// 但模型 key(ANTHROPIC_API_KEY/OPENAI_API_KEY)keep-list 保留 → 不进 scrub map。
describe('scrubbedSecretEnv()', () => {
  const saved: Record<string, string | undefined> = {};
  const touched = ['FOO_SECRET', 'ARK_IMAGE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

  beforeEach(() => {
    for (const k of touched) saved[k] = process.env[k];
    process.env.FOO_SECRET = 'x';
    process.env.ARK_IMAGE_KEY = 'y';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-keep';
    process.env.OPENAI_API_KEY = 'sk-openai-keep';
  });

  afterEach(() => {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  test('known app secret ARK_IMAGE_KEY → undefined', () => {
    const scrub = scrubbedSecretEnv();
    expect('ARK_IMAGE_KEY' in scrub).toBe(true);
    expect(scrub.ARK_IMAGE_KEY).toBeUndefined();
  });

  test('generic *_SECRET match (FOO_SECRET) → undefined', () => {
    const scrub = scrubbedSecretEnv();
    expect('FOO_SECRET' in scrub).toBe(true);
    expect(scrub.FOO_SECRET).toBeUndefined();
  });

  test('model keys are KEPT (not present in the scrub map)', () => {
    const scrub = scrubbedSecretEnv();
    // keep-list:不出现在 scrub map 里 → 子进程仍继承宿主值。
    expect('ANTHROPIC_API_KEY' in scrub).toBe(false);
    expect('OPENAI_API_KEY' in scrub).toBe(false);
  });
});
