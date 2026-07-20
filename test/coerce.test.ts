/**
 * coerceBySchema — schema 驱动的入参隐形容错(cc semanticNumber/Boolean 的 core 等价物)。
 * 核心不变量:只转合法字面量;非法字面量/null 原样透传(交给 walker 报错);对外无副作用。
 */
import { test, expect, describe } from 'bun:test';
import { coerceBySchema } from '../src/capability/coerce';

const numSchema = { type: 'number' } as const;
const intSchema = { type: 'integer' } as const;
const boolSchema = { type: 'boolean' } as const;

describe('coerceBySchema — scalars', () => {
  test('quoted number → number', () => {
    expect(coerceBySchema('30', numSchema)).toBe(30);
    expect(coerceBySchema('-5', numSchema)).toBe(-5);
    expect(coerceBySchema('3.14', numSchema)).toBe(3.14);
  });

  test('quoted boolean → boolean', () => {
    expect(coerceBySchema('true', boolSchema)).toBe(true);
    expect(coerceBySchema('false', boolSchema)).toBe(false);
  });

  test('restrained: illegal number literals pass through untouched', () => {
    expect(coerceBySchema('', numSchema)).toBe(''); // 空
    expect(coerceBySchema(' 30 ', numSchema)).toBe(' 30 '); // 含空白
    expect(coerceBySchema('abc', numSchema)).toBe('abc');
    expect(coerceBySchema('0x1e', numSchema)).toBe('0x1e'); // 十六进制不吃
    expect(coerceBySchema('1e3', numSchema)).toBe('1e3'); // 指数不吃
    expect(coerceBySchema('30px', numSchema)).toBe('30px');
  });

  test('restrained: non true/false strings pass through', () => {
    expect(coerceBySchema('1', boolSchema)).toBe('1');
    expect(coerceBySchema('yes', boolSchema)).toBe('yes');
    expect(coerceBySchema('True', boolSchema)).toBe('True'); // 大小写敏感
  });

  test('integer type rejects fractional literal', () => {
    expect(coerceBySchema('3.14', intSchema)).toBe('3.14');
    expect(coerceBySchema('42', intSchema)).toBe(42);
  });

  test('already-correct types + null/undefined untouched', () => {
    expect(coerceBySchema(30, numSchema)).toBe(30);
    expect(coerceBySchema(true, boolSchema)).toBe(true);
    expect(coerceBySchema(null, numSchema)).toBe(null);
    expect(coerceBySchema(undefined, boolSchema)).toBe(undefined);
  });

  test('string-typed field never coerced', () => {
    expect(coerceBySchema('30', { type: 'string' })).toBe('30');
  });
});

describe('coerceBySchema — objects/arrays', () => {
  const objSchema = {
    type: 'object',
    properties: {
      head_limit: { type: 'number' },
      '-i': { type: 'boolean' },
      pattern: { type: 'string' },
    },
  } as const;

  test('coerces declared props by type', () => {
    const out = coerceBySchema(
      { head_limit: '30', '-i': 'true', pattern: 'x' },
      objSchema,
    ) as Record<string, unknown>;
    expect(out).toEqual({ head_limit: 30, '-i': true, pattern: 'x' });
  });

  test('returns same reference when nothing changes (no needless copy)', () => {
    const input = { head_limit: 30, pattern: 'x' };
    expect(coerceBySchema(input, objSchema)).toBe(input);
  });

  test('unknown keys + missing props left alone', () => {
    const out = coerceBySchema({ pattern: 'x', extra: '9' }, objSchema) as Record<string, unknown>;
    expect(out).toEqual({ pattern: 'x', extra: '9' }); // extra 无声明 → 不动
  });

  test('array items coerced by items schema', () => {
    const schema = { type: 'array', items: { type: 'number' } } as const;
    expect(coerceBySchema(['1', '2', 'x'], schema)).toEqual([1, 2, 'x']);
  });

  test('empty / non-object schema → passthrough', () => {
    expect(coerceBySchema('30', {})).toBe('30');
    expect(coerceBySchema('30', null as unknown as object)).toBe('30');
  });
});
