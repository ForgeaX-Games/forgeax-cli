/**
 * codex-mapper — codex `exec --json` JSONL 事件 → 中立 `KernelEvent`。
 *
 * Codex(headless `codex exec --json`)的 stdout 是点命名的 JSONL 事件流:
 *   {type:"thread.started",thread_id}
 *   {type:"turn.started"}
 *   {type:"item.started"|"item.completed", item:{id,type,...}}
 *   {type:"turn.completed", usage:{input_tokens,cached_input_tokens,output_tokens,reasoning_output_tokens}}
 *   {type:"turn.failed"|"error", ...}
 *
 * item.type 见过:
 *   agent_message       {text}            助手文本(整段,仅 item.completed,无 started)
 *   reasoning           {text}            思考(整段)
 *   command_execution   {command,status,exit_code,aggregated_output}  shell 执行
 *   (mcp tool call 同 command_execution 形态:item.started → item.completed)
 *
 * 设计稿《通用内核接入协议》§3 事件映射:
 *   item.completed agent_message → message.delta(整段,可一次性)
 *   item reasoning               → thinking.delta
 *   item.started command/mcp     → tool.call{callId:item.id,name,args}
 *   item.completed command/mcp   → tool.result{callId,ok,result}
 *   turn.completed               → turn.usage(无 costUsd) 然后 turn.done{stop}
 *   turn.failed/error            → turn.usage + error{protocol} + turn.done{error}
 *
 * 不变量:turn.usage 必在 turn.done 之前(含 error 路径)。Codex 只给 token,
 * 无 $ cost → KernelEvent.turn.usage.costUsd 留空。thread_id 由调用方在收到
 * thread.started 时记下(用于 `codex exec resume <thread_id>`)。
 */
import type { KernelEvent } from '@forgeax/agent-runtime';

// ─── codex JSONL raw 事件形状(只声明本映射用到的字段，其余 tolerant) ──

export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexItem {
  id: string;
  type: string;
  /** agent_message / reasoning */
  text?: string;
  /** command_execution */
  command?: string;
  status?: string;
  exit_code?: number | null;
  aggregated_output?: string;
  /** mcp tool call(形态未冻结，tolerant 透传) */
  name?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  // 允许未知键(forward-compat)
  [k: string]: unknown;
}

export type CodexRawEvent =
  | { type: 'thread.started'; thread_id?: string }
  | { type: 'turn.started' }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error?: { message?: string }; message?: string }
  | { type: 'error'; message?: string; error?: { message?: string } }
  | { type: string; [k: string]: unknown };

// ─── 映射器状态(跨行) ───────────────────────────────────────────────

export interface CodexMapperState {
  /** 首个 thread.started.thread_id；供调用方记录以便 resume。 */
  threadId?: string;
  /** 是否已发出 turn.done(任一终态后置 true，防重复)。 */
  doneEmitted: boolean;
  /** 已为某 item.id 发过 tool.call,避免 item.started/updated 重复发 call。 */
  toolCallsOpened: Set<string>;
}

export function createCodexMapperState(): CodexMapperState {
  return { doneEmitted: false, toolCallsOpened: new Set() };
}

const TOOL_ITEM_TYPES = new Set([
  'command_execution',
  'mcp_tool_call',
  'tool_call',
  'function_call',
  'local_shell_call',
]);

function isToolItem(item: CodexItem): boolean {
  return TOOL_ITEM_TYPES.has(item.type) || item.type.endsWith('_call');
}

function toolName(item: CodexItem): string {
  if (item.type === 'command_execution' || item.type === 'local_shell_call') return 'shell';
  if (item.name) return item.name;
  if (item.server && item.tool) return `mcp__${item.server}__${item.tool}`;
  if (item.tool) return item.tool;
  return item.type;
}

function toolArgs(item: CodexItem): unknown {
  if (item.command !== undefined) return { command: item.command };
  if (item.arguments !== undefined) return item.arguments;
  return {};
}

function toolOk(item: CodexItem): boolean {
  if (typeof item.exit_code === 'number') return item.exit_code === 0;
  if (item.status) return item.status === 'completed' || item.status === 'success';
  return true;
}

function toolResult(item: CodexItem): unknown {
  if (item.aggregated_output !== undefined) return item.aggregated_output;
  if (item.result !== undefined) return item.result;
  return undefined;
}

/** 单条 codex raw 事件 → 0..n 个 KernelEvent。state 跨行累积。 */
export function* mapCodexEvent(raw: CodexRawEvent, state: CodexMapperState): Generator<KernelEvent> {
  switch (raw.type) {
    case 'thread.started': {
      const ev = raw as Extract<CodexRawEvent, { type: 'thread.started' }>;
      if (ev.thread_id && !state.threadId) state.threadId = ev.thread_id;
      return;
    }

    case 'turn.started':
      return;

    case 'item.started':
    case 'item.updated': {
      const item = (raw as { item: CodexItem }).item;
      if (item && isToolItem(item) && !state.toolCallsOpened.has(item.id)) {
        state.toolCallsOpened.add(item.id);
        yield { kind: 'tool.call', callId: item.id, name: toolName(item), args: toolArgs(item) };
      }
      return;
    }

    case 'item.completed': {
      const item = (raw as { item: CodexItem }).item;
      if (!item) return;
      if (item.type === 'agent_message') {
        if (item.text) yield { kind: 'message.delta', role: 'assistant', text: item.text };
        return;
      }
      if (item.type === 'reasoning') {
        if (item.text) yield { kind: 'thinking.delta', text: item.text };
        return;
      }
      if (isToolItem(item)) {
        // 极少数情况下 codex 直接发 item.completed(无 started)→ 补一条 call。
        if (!state.toolCallsOpened.has(item.id)) {
          state.toolCallsOpened.add(item.id);
          yield { kind: 'tool.call', callId: item.id, name: toolName(item), args: toolArgs(item) };
        }
        const ok = toolOk(item);
        yield {
          kind: 'tool.result',
          callId: item.id,
          ok,
          result: toolResult(item),
          error: ok ? undefined : (item.aggregated_output ?? `exit ${item.exit_code ?? '?'}`),
        };
        return;
      }
      // 未知 item 类型:tolerant 忽略(forward-compat)。
      return;
    }

    case 'turn.completed': {
      const ev = raw as Extract<CodexRawEvent, { type: 'turn.completed' }>;
      const u = ev.usage;
      yield {
        kind: 'turn.usage',
        inputTokens: u?.input_tokens,
        outputTokens: u?.output_tokens,
        cacheRead: u?.cached_input_tokens,
        // costUsd 留空:codex 只给 token。
      };
      yield { kind: 'turn.done', reason: 'stop' };
      state.doneEmitted = true;
      return;
    }

    case 'turn.failed':
    case 'error': {
      const msg =
        (raw as { error?: { message?: string }; message?: string }).error?.message ??
        (raw as { message?: string }).message ??
        `codex ${raw.type}`;
      yield { kind: 'turn.usage' };
      yield { kind: 'error', error: { code: 'protocol', message: msg } };
      yield { kind: 'turn.done', reason: 'error' };
      state.doneEmitted = true;
      return;
    }

    default:
      // 未知顶层事件(turn.* 之外):tolerant 忽略。
      return;
  }
}

/** 进程退出但从未发过终态(无 turn.completed/failed)时的兜底。
 *  保证不变量:turn.usage 必在 turn.done 之前。
 *  `aborted=true`(被取消杀进程)时:exit.code 必非零,但这是主动中断而非真崩溃 ——
 *  收口为 turn.done{cancelled}(R4-05:取消后最后一个事件必须是 cancelled,而非 error)。 */
export function* flushCodexMapper(
  state: CodexMapperState,
  exit: { code: number; stderr: string },
  aborted = false,
): Generator<KernelEvent> {
  if (state.doneEmitted) return;
  if (aborted) {
    yield { kind: 'turn.usage' };
    yield { kind: 'turn.done', reason: 'cancelled' };
  } else if (exit.code === 0) {
    yield { kind: 'turn.usage' };
    yield { kind: 'turn.done', reason: 'stop' };
  } else {
    const tail = exit.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').trim();
    yield { kind: 'turn.usage' };
    yield {
      kind: 'error',
      error: { code: 'protocol', message: `codex exited ${exit.code}${tail ? ': ' + tail : ''}` },
    };
    yield { kind: 'turn.done', reason: 'error' };
  }
  state.doneEmitted = true;
}
