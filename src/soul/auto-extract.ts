/**
 * 自动沉淀(auto-extract)—— 回合结束后台抽取持久记忆并按层路由(P1)。
 *
 * 数字生命原本只能模型主动 `remember`,DeepSeek 这类模型很少调 → 记忆长不出来。
 * 本管线在每个 user turn 结束后(host 侧 `hook:turnEnd`)**后台、节流、互斥**地:
 *   1. 取最近若干条对话(经 ledger → eventsToMessages → normalizeHistory);
 *   2. 用本 agent 的模型跑一次抽取 side-query(JSON);
 *   3. **按 type 路由**:
 *        - `user`               → 全局 `USER.md`(跨 agent 共享,按 key upsert)
 *        - `general`/`feedback`… → traits(可移植)        ┐ 走 layered-memory
 *        - `game`               → episodes/<当前 game>    ┘ 的 classifyAndWrite
 *
 * 干净律:不阻塞主对话(fire-and-forget);无模型/无用户消息 → 跳过;失败 best-effort 吞错。
 * `FORGEAX_AUTO_EXTRACT=0` 关闭;`FORGEAX_AUTO_EXTRACT_EVERY=N` 调节流(默认 2)。
 */
import type { ModelsConfig } from '../core/types';
import type { LedgerReader } from '../context-window/context-window';
import type { LLMMessage } from '../llm/types';
import { eventsToMessages } from '../context-window/history-pipeline';
import { normalizeHistory } from '../context-window/tool-normalizer';
import { extractMessageBodyText } from '../llm/thinking';
import { createProvider } from '../llm/provider';
import { assembleResponse } from '../llm/stream';
import { normalizeContent } from '../message/modality';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getActiveGame } from '../api/lib/active-game';
import { getSessionManager } from '../core/session-registry';
import { classifyAndWrite, soulMemoryRoot } from './layered-memory';
import { upsertUserFacts, type UserFact } from './user-profile';
import type { MemoryFact } from './types';

const EXTRACT_SYS =
  'You extract durable, reusable memories from a conversation between a human USER and an AI agent. ' +
  'Focus ONLY on facts that will still matter in FUTURE sessions:\n' +
  '- type "user": durable facts ABOUT THE HUMAN USER — name/handle, timezone, language preference, ' +
  'the projects they work on, long-standing preferences and working style.\n' +
  '- type "general": portable conventions or feedback about how to work with this user (always applies).\n' +
  '- type "game": facts bound to the current game/project world.\n' +
  'Do NOT save code, file paths, transient task state, one-off requests, or anything derivable from the project. ' +
  'If the snippet is agent-to-agent coordination with no human-relevant fact, return an empty list.\n' +
  'Return ONLY JSON: {"memories":[{"type":"user|general|game","name":"short title","description":"one line",' +
  '"body":"the memory, written in the user\'s language"}]} — an empty list is correct when nothing is worth persisting.';

interface ExtractedMemory {
  type?: string;
  name?: string;
  description?: string;
  body?: string;
}

/** 容忍模型把 JSON 包在 ``` fence / 前置文字里。 */
function tryParseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[[{]/);
  if (start < 0) return null;
  try {
    return JSON.parse(raw.slice(start)) as T;
  } catch {
    return null;
  }
}

// ─── 节流 + 互斥(per sid::agentPath)──────────────────────────────────────────
interface ExtractState {
  turnsSince: number;
  extracting: boolean;
}
const _state = new Map<string, ExtractState>();

function extractEvery(): number {
  const n = Number(process.env.FORGEAX_AUTO_EXTRACT_EVERY);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export interface AutoExtractInput {
  sid: string;
  /** 刚结束回合的 agent 路径(emitterId);soul 记忆按其 leaf id 归档。 */
  agentPath: string;
  /** 该 agent 的 per-agent ledger(满足 readFromTail/readAllEvents)。 */
  ledger: LedgerReader;
  /** 该 agent 的模型解析器(agentContext.resolveModels)。 */
  resolveModels: () => ModelsConfig;
  signal?: AbortSignal;
}

/** host 在 `hook:turnEnd` 调用:节流 + 互斥地后台抽取并按层落盘(fire-and-forget)。 */
export async function runAutoExtract(input: AutoExtractInput): Promise<void> {
  if (process.env.FORGEAX_AUTO_EXTRACT === '0') return;

  const key = `${input.sid}::${input.agentPath}`;
  const st = _state.get(key) ?? { turnsSince: 0, extracting: false };
  _state.set(key, st);

  st.turnsSince++;
  if (st.turnsSince < extractEvery()) return;
  if (st.extracting) return;
  st.turnsSince = 0;

  // 取最近对话(tail 读够即停)。
  let recent: Array<{ role: string; text: string }> = [];
  try {
    const events = await input.ledger.readFromTail((acc) => acc.length >= 60);
    const { messages } = normalizeHistory(eventsToMessages(events));
    recent = messages
      .filter((m: LLMMessage) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m: LLMMessage) => ({ role: m.role, text: extractMessageBodyText(m) }))
      .filter((m) => m.text && m.text.trim());
  } catch {
    return;
  }
  // 没有真实用户消息 → 多半是 agent 内部回合,不抽。
  if (!recent.some((m) => m.role === 'user')) return;

  // 模型(沿用该 agent 的路由 / agent.json / session 默认)。
  let modelsConfig: ModelsConfig;
  let model: string;
  try {
    modelsConfig = input.resolveModels();
    const m = Array.isArray(modelsConfig.model) ? modelsConfig.model[0] : modelsConfig.model;
    if (!m) return;
    model = m;
  } catch {
    return;
  }

  st.extracting = true;
  try {
    const convo = recent.map((m) => `[${m.role}] ${m.text}`).join('\n');
    const provider = createProvider({
      ...modelsConfig,
      model,
      maxTokens: 1024,
      showThinking: false,
      temperature: 0,
    });
    const stream = provider.chatStream(
      [{ name: 'memory-extractor', text: EXTRACT_SYS, cacheHint: 'stable', priority: 0 }],
      [{ role: 'user', content: normalizeContent(`Conversation:\n${convo}`) }],
      [],
      input.signal ?? AbortSignal.timeout(60_000),
    );
    const resp = await assembleResponse(stream);
    const raw = typeof resp.content === 'string' ? resp.content : '';
    const parsed = tryParseJson<{ memories?: ExtractedMemory[] }>(raw);
    const mems = Array.isArray(parsed?.memories) ? parsed!.memories! : [];
    if (mems.length === 0) return;

    const projectRoot = defaultProjectRoot();

    // 1) user → 全局 USER.md(按 key upsert)。
    const userFacts: UserFact[] = mems
      .filter((m) => m.type === 'user' && typeof m.body === 'string' && m.body.trim())
      .map((m) => ({ name: (m.name ?? m.description ?? '').trim(), body: m.body!.trim() }));
    if (userFacts.length) upsertUserFacts(projectRoot, userFacts);

    // 2) general/feedback/… → traits;game → episodes/<game>(走分层写时分类)。
    const layered: MemoryFact[] = mems
      .filter((m) => m.type !== 'user' && typeof m.body === 'string' && m.body.trim())
      .map((m) => ({
        text: m.body!.trim(),
        kind: m.type === 'game' ? 'game' : 'general',
        ...(m.name ? { title: m.name } : {}),
      }));
    if (layered.length) {
      const soulId = input.agentPath.split('/').pop() || input.agentPath;
      // 永久绑定(PR2):game episode 落该 session 绑定的 game(config.defaultDir 由路径派生),
      // 非全局 active game——否则切 game 后旧 session 的记忆会写错 game。未绑则回落 active。
      const game = getSessionManager().peek(input.sid)?.config.defaultDir ?? getActiveGame(projectRoot);
      classifyAndWrite({ root: soulMemoryRoot(projectRoot, soulId), ...(game ? { game } : {}) }, layered);
    }
  } catch {
    /* best-effort:抽取失败不影响主流程 */
  } finally {
    st.extracting = false;
  }
}
