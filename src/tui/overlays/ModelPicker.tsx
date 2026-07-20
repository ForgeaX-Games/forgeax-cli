/**
 * ModelPicker 浮层(受控,无 useInput)—— /model 选择页。
 *
 * 列表 + 高亮 index 由上层 state 持有,本组件只做纯渲染;导航(↑↓/enter/esc)交给
 * 本文件导出的纯 reducer `modelPickerReducer`,供 P6 router 调。
 * 候选表来源:上层用 `fetchRemoteModels`(env 的 key/base → `GET /v1/models`)拉当前
 * key 真正可用的模型,拉不到退静态 `KNOWN_MODELS` 兜底,再经 `modelList` 并入 current。
 * 选中 → router 调 driver.setModel(id);esc → router 关闭回 prompt。
 * **本组件不调 useInput**(梁③:单一输入 owner)。
 *
 * Boundary(HOST 层):react + ink + 相对 import。
 */
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../providers/theme';
import type { Key } from '../contracts';
import type { NavResult } from './CommandMenu';

export type { NavResult };

/** 列表可视窗口行数(远端表 40+ 项,整列渲染会超终端高度 → Ink 擦不掉旧帧留残影)。 */
export const MAX_VISIBLE = 8;

/** 静态兜底候选(远端 /v1/models 拉不到时用)。current 不在表里也会并入。 */
export const KNOWN_MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5',
  'gemini-2.5-pro',
  'deepseek-v4',
];

/** 把 current 置于候选表首位(优先远端列表,空则退 KNOWN_MODELS),并去掉其原位置。 */
export function modelList(current: string, remote?: string[]): string[] {
  const base = remote && remote.length > 0 ? remote : KNOWN_MODELS;
  return [current, ...base.filter((model) => model !== current)];
}

/** id 切成「非数字 / 数字(含点号版本,如 2.5)」交替 token,供 compareModelId 逐段比较。 */
function modelIdTokens(id: string): string[] {
  return id.match(/\d+(?:\.\d+)+|\d+|\D+/g) ?? [];
}

/** 版本 token 降序比("5.1" > "5" > "4.8";缺段当 -1,使 5.1 排在 5 前)。 */
function compareVersionDesc(x: string, y: string): number {
  const xs = x.split('.').map(Number);
  const ys = y.split('.').map(Number);
  const n = Math.max(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const d = (ys[i] ?? -1) - (xs[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 模型 id 排序比较器:名字字母升序,同名下版本号**降序**(新版本在前)。
 * 逐 token 比:两边都是数字(含点号版本)→ 数值大的在前;否则字典序升序;
 * 全等前缀 → 短的(基础名)在前。
 * 例:claude-opus-4-8 < claude-opus-4-7 < claude-sonnet-4-6 < codex-5.3;
 *     gemini-3.5-flash < gemini-3-pro-image(3.5 > 3)。
 */
export function compareModelId(a: string, b: string): number {
  const ta = modelIdTokens(a);
  const tb = modelIdTokens(b);
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i]!;
    const y = tb[i]!;
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) return compareVersionDesc(x, y);
    return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}

/** fetchRemoteModels 的注入接缝(测试注 mock;运行时默认 process.env + 全局 fetch)。 */
export interface FetchRemoteModelsDeps {
  env?: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 从 provider 网关拉当前 key 可用的模型表(OpenAI-compat `GET {base}/v1/models`,
 * `Authorization: Bearer` + `x-api-key` 双头兼容 openai-compat 网关与 anthropic 原生)。
 * key/base 取 env(`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`);缺配置、网络错、超时、
 * 响应不合形 → 一律返回 `[]`(调用方退 KNOWN_MODELS,graceful degradation,绝不 throw)。
 */
export async function fetchRemoteModels(deps: FetchRemoteModelsDeps = {}): Promise<string[]> {
  const env = deps.env ?? process.env;
  const key = env.ANTHROPIC_API_KEY;
  const base = env.ANTHROPIC_BASE_URL;
  if (!key || !base) return [];
  const root = base.replace(/\/+$/, '');
  const url = root.endsWith('/v1') ? `${root}/models` : `${root}/v1/models`;
  try {
    const res = await (deps.fetchFn ?? fetch)(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (Array.isArray(body?.data) ? body.data : [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort(compareModelId);
  } catch {
    return [];
  }
}

/**
 * ModelPicker 纯导航 reducer —— 供 P6 router 调。
 * ↑↓ 环形移动、enter 选中当前、esc 关闭。
 */
export function modelPickerReducer(index: number, length: number, key: Key): NavResult {
  if (key.kind === 'esc') return { kind: 'close' };
  if (length === 0) return { kind: 'none' };
  if (key.kind === 'up') return { kind: 'move', index: (index - 1 + length) % length };
  if (key.kind === 'down') return { kind: 'move', index: (index + 1) % length };
  if (key.kind === 'enter') return { kind: 'select', index };
  return { kind: 'none' };
}

export interface ModelPickerProps {
  /** 候选模型(由上层 modelList(current) 算好传入)。 */
  models: string[];
  /** 当前生效模型(标 ●)。 */
  current: string;
  /** 当前高亮下标(由上层 state 持有)。 */
  index: number;
  /** 远端模型表在拉取中(true → 只显 loading,不显兜底表)。 */
  loading?: boolean;
}

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const theme = useTheme();
  const { models, current, index, loading } = props;
  // 高亮居中的滑动窗口(与 CommandMenu/ResumePicker 同模式):只渲染 MAX_VISIBLE 行,
  // 上下用「^/v N 更多」占位,保证浮层高度恒定小于终端高度。
  const window = useMemo(() => {
    if (models.length === 0) return null;
    const begin = Math.max(
      0,
      Math.min(index - Math.floor(MAX_VISIBLE / 2), models.length - MAX_VISIBLE),
    );
    const visible = models.slice(begin, begin + MAX_VISIBLE);
    return {
      visible,
      begin,
      hiddenAbove: begin,
      hiddenBelow: models.length - (begin + visible.length),
    };
  }, [models, index]);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent}>{'选择模型(up/down 选择 | enter 切换 | esc 返回)'}</Text>
      {loading ? <Text color={theme.dim}>{'正在获取可用模型列表…'}</Text> : null}
      {window ? (
        <>
          {window.hiddenAbove > 0 ? <Text color={theme.dim}>{`  ^ ${window.hiddenAbove} 更多`}</Text> : null}
          {window.visible.map((m, vi) => {
            const i = window.begin + vi;
            const active = i === index;
            const isCurrent = m === current;
            return (
              <Box key={m}>
                <Text color={active ? theme.accent : theme.text}>
                  {active ? '> ' : '  '}
                  {isCurrent ? '* ' : '  '}
                  {m}
                </Text>
                {isCurrent ? <Text color={theme.dim}>{'  (当前)'}</Text> : null}
              </Box>
            );
          })}
          {window.hiddenBelow > 0 ? <Text color={theme.dim}>{`  v ${window.hiddenBelow} 更多`}</Text> : null}
        </>
      ) : null}
    </Box>
  );
}
