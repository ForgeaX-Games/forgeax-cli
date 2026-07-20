/**
 * Schema 驱动的入参「隐形容错」(core 无 zod,按声明类型把合法字面量字符串转成真实类型)。
 *
 * 工具输入是模型生成的 JSON,模型常把数字/布尔加引号:`{"head_limit":"30"}`、`{"-i":"true"}`。
 * 声明式(JSON Schema)工具在 dispatch 里过 `validateAgainstSchema`(见 ./validate),`type:number`
 * 会因收到字符串而判失配 → 该次工具调用直接 validation 错。本函数在**校验前**按 schema 声明的类型,
 * 把「确实合法的字面量字符串」转成真实类型,消除这类可工程消除的失败。
 *
 * 克制(**不用** JS 宽松强转 `Number()`/truthiness):
 *   - number/integer:仅 `/^-?\d+(\.\d+)?$/` 且 `Number.isFinite` 的十进制字面量才转;`""`/`" 30 "`/
 *     `"abc"`/`"0x1e"`/`"1e3"` 一律原样透传 → 交给 walker 按原 schema 报错(不掩盖 bug)。
 *   - integer:再要求结果为整数,否则不转。
 *   - boolean:仅字面 `"true"`/`"false"` → `true`/`false`;其余(含 `"1"`/`"yes"`)原样透传。
 *   - 不吞 `null`/`undefined`;**对外 schema 不变**(模型看到的仍是 number/boolean),是客户端隐形修复。
 *
 * 纯函数:返回新值,不改原对象;无 IO、无 import —— Boundary 天然满足。仅覆盖 walker 实际用到的
 * 结构关键字子集(type / properties 递归 / items 递归);oneOf/anyOf 等不做转换(标量入参罕见,
 * 保守放过)。空/无约束 schema → 原样返回。
 */

const DECIMAL_LITERAL = /^-?\d+(\.\d+)?$/;

function coerceNumberLiteral(s: string, integer: boolean): number | undefined {
  if (!DECIMAL_LITERAL.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  if (integer && !Number.isInteger(n)) return undefined;
  return n;
}

function isPlainSchema(schema: unknown): schema is Record<string, unknown> {
  return !!schema && typeof schema === 'object' && !Array.isArray(schema);
}

/**
 * 按 `schema` 对 `value` 做隐形类型容错,返回(可能被替换的)新值。无法安全转换的一律原样返回。
 */
export function coerceBySchema(value: unknown, schema: unknown): unknown {
  if (!isPlainSchema(schema)) return value;

  // 标量:字符串 → number/integer/boolean(仅合法字面量)。
  if (typeof value === 'string' && typeof schema.type === 'string') {
    if (schema.type === 'number' || schema.type === 'integer') {
      const n = coerceNumberLiteral(value, schema.type === 'integer');
      return n === undefined ? value : n;
    }
    if (schema.type === 'boolean') {
      return value === 'true' ? true : value === 'false' ? false : value;
    }
  }

  // object:按声明的 properties 逐字段递归(只处理已出现的键;缺省键不造字段)。
  if (value && typeof value === 'object' && !Array.isArray(value) && isPlainSchema(schema.properties)) {
    const props = schema.properties as Record<string, unknown>;
    const src = value as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(src)) {
      const childSchema = props[key];
      if (!isPlainSchema(childSchema)) continue;
      const coerced = coerceBySchema(src[key], childSchema);
      if (coerced !== src[key]) {
        if (!out) out = { ...src };
        out[key] = coerced;
      }
    }
    return out ?? value;
  }

  // array:按 items 递归(单一 items schema;tuple 形式按位)。
  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    let out: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const itemSchema = Array.isArray(items) ? items[i] : items;
      if (!isPlainSchema(itemSchema)) continue;
      const coerced = coerceBySchema(value[i], itemSchema);
      if (coerced !== value[i]) {
        if (!out) out = [...value];
        out[i] = coerced;
      }
    }
    return out ?? value;
  }

  return value;
}
