/**
 * composeTurnRequest — 编排层把一次 chat 组装成中立 `TurnRequest`(喂内核)。
 *
 * M2:**编排层真正拥有"组装一轮"**——systemPrompt(游戏宪章 charter + persona)
 * 在此构建,内核只执行。来源与旧 claude-code provider 一致(`buildGameCharter` +
 * `buildActiveGameNote` + `composeSystemPrompt`),所以从老路径切过来 prompt 不变。
 *   - charter:游戏宪章 + 当前激活游戏 note(稳定缓存前缀)
 *   - persona:marketplace agent 的人格(default/root 无)
 *   - model:优先 body.model,否则读 agent.json::models.model(ModelPicker 不回归)
 *   - tools:M2 仍空(CC 自带工具);MCP 工具下发在 M3。
 */
import type { TurnRequest, TurnMessage } from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getActiveGame } from '../api/lib/active-game';
import { getSessionManager } from '../core/session-registry';
import { getPathManager } from '../fs/path-manager';
import { ContextWindow } from '../context-window/context-window';
import { llmMessagesToTurnHistory } from './llm-history';
import { buildGameCharter, buildActiveGameNote } from '../agents/game-charter';
import { renderEnvironmentText } from '../agents/environment';
import {
  loadAgentRecord,
  composeStableMemory,
  composeEpisodicRecall,
  composeReincarnationNotice,
  emitLifeEvent,
} from '../soul';
import { drainPerceptionNotes } from '../api/lib/perception-registry';
import type { SkillRefLite } from '../soul/types';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';
const INTERFACE_PORT = process.env.FORGEAX_INTERFACE_PORT ?? '18920';
const GAME_CHARTER = buildGameCharter({ serverPort: SERVER_PORT, interfacePort: INTERFACE_PORT });

/** P3(B 路径):core 有 builtin 实现的「安全类」工具集。own trustTier 下这些标
 *  `delivery:'local'`(forgeax-core 内核本进程直跑)。name 与 core builtin 对齐,且
 *  forgeax-cli `builtin/kits/workspace/tools/` 同名。危险类(bash/出网/删/凭据)与 host
 *  专属工具(list_games/query_world…)不入此集 → 仍走 host 桥把闸。 */
const LOCAL_CAPABLE_TOOLS = new Set<string>(['read_file', 'write_file', 'edit_file', 'grep', 'glob']);

/** 编排层声明的基础工具(中立 ToolSpec)。内核据此挂 MCP server + `--allowedTools` 放行。
 *  `list_games` = 真实只读 forgeax 能力;`memory_search` = 数字生命(R6)按需召回通道
 *  (含前世 episodes),真实后端 = soul 分层记忆库。后续从 agent 能力集动态填充。 */
const FORGEAX_TOOLS = [
  {
    name: 'list_games',
    description: 'List the game projects in this forgeax workspace. Returns { count, games }.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_search',
    description:
      "Search your long-term layered memory (identity / traits / episodes, including past-life worlds) for relevant entries. Returns { query, matches:[{tier, game?, file, text}] }.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'remember',
    description:
      "Persist a durable memory about the user or this game into your long-term layered memory so you recall it in future sessions (数字生命成长). kind:'general' = portable fact about the user (carries across games); kind:'game' = bound to the current game world.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['general', 'game'] }, title: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    // 感知接地(R5/M8):向运行中的游戏取真值。仅取数,裁判是你 + 结构/不变量,引擎不当裁判。
    name: 'query_world',
    description:
      "Query the RUNNING game's live world for ground truth: a structural ECS snapshot { entityCount, archetypes:[{componentNames, entityCount}], activeComponents, systems, resourceKeys }. Use it to VERIFY what the game actually contains/does (after writing code) instead of guessing. Data only — you are the judge.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'capture_frame',
    description:
      'Capture the running game preview\'s current rendered frame as a PNG data URL (best-effort; may be blank on some GPUs — judge by structure/invariants, not pixels). Returns { dataUrl, bytes }.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface ComposeInput {
  message: string;
  agentId: string;
  threadId?: string;
  sessionId?: string;
  callId?: string;
  /** UI 直传的模型覆盖(优先);否则从 agent.json 解析。 */
  model?: string;
  /** 该 agent 的 host-tools(kits/toolRegistry)→ 经 MCP 桥下发内核(T-A)。 */
  extraTools?: TurnRequest['tools'];
  /** 多模态附件(图片等)。透传进 `TurnRequest.input.attachments`,由原生内核 facade
   *  组成 image content block 送模型。形状开放(contract `InputMessage.attachments`):
   *  `{ kind:'image', mediaType, data?(base64) | path?(host 文件) }`。 */
  attachments?: TurnRequest['input']['attachments'];
  /** 全链路 trace:上游(浏览器 ui.request)的 W3C traceparent;透传进 TurnRequest,
   *  内核 facade 把 kernel.turn 挂成它的 child。缺省 ⇒ kernel.turn 自建 root。 */
  traceparent?: string;
}

export async function composeTurnRequest(input: ComposeInput): Promise<TurnRequest> {
  const projectRoot = defaultProjectRoot();
  const scopeSlug = sessionScopeSlug(input.sessionId ?? input.threadId) ?? getActiveGame(projectRoot);
  const note = buildActiveGameNote(scopeSlug);
  // environment(Paths / 当前游戏 / Workbench 插件 / Skills 目录)。重构切到 core 内核后
  //   这块整段没了 —— 老 claude-code 路径有 <environment>,新装配器从未构建它,导致模型不知道
  //   项目根绝对路径、有哪些工作台/技能。Working directory = projectRoot:core 文件工具相对
  //   process.cwd()(serve.ts 即 projectRoot)解析,与 charter「starts at project root」一致。
  //   best-effort:plugin registry 未就绪等异常 → 跳过 environment,不挡本轮。
  let environment = '';
  try {
    environment = renderEnvironmentText({ cwd: projectRoot, projectRoot, slug: scopeSlug ?? null });
  } catch {
    environment = '';
  }
  const charter = [GAME_CHARTER, environment, note].filter((s) => s && s.trim()).join('\n\n');

  // R6 数字生命:把 agentId「重生」成 AgentRecord(persona + 分层记忆 + 信任档)。
  //  - persona(stable 前缀)= soul persona + identity/traits + MEMORY.md 索引
  //  - dynamicSuffix(user 后缀,不busts cache)= 当前 game 的 episodes 召回
  //  - trustTier 权威 = 加载路径(pass-through 给宿主 enforcement)
  const record = await loadAgentRecord(input.agentId, { projectRoot, game: scopeSlug });
  const stableMem = composeStableMemory(record.memory);
  const persona = [record.persona, stableMem].filter((s) => s && s.trim()).join('\n\n---\n\n');
  // dynamicSuffix(不 bust 缓存)= 今世 episodes 召回,或(有前世首进新世界)转世唤醒。
  // 两者互斥:转世通知要求今世 episodes=0,episodic 召回要求 ≥1。
  const episodic = composeEpisodicRecall(record.memory);
  const rebirth = composeReincarnationNotice(record.memory);
  if (rebirth && scopeSlug) {
    emitLifeEvent({ kind: 'rebirth.projected', agentId: input.agentId, into: scopeSlug, at: Date.now() });
  }
  // L1 感知回灌(M8):上一轮后游戏运行期 console/preview error 排空进本轮 user 后缀,
  // 让 agent 看见自己写的代码在引擎里真实报的错(轮间注入,不进 system prompt)。
  const notes = drainPerceptionNotes(input.sessionId);
  const runtimeFeedback = notes.length
    ? `# Runtime feedback from the game preview (console — newest last)\n${notes
        .map((n) => `- [${n.level}] ${n.text}`)
        .join('\n')}\n\nIf these indicate a problem with code you wrote, fix it; otherwise acknowledge and continue.`
    : '';
  const dynamicSuffix = [rebirth, episodic, runtimeFeedback].filter((s) => s && s.trim()).join('\n\n---\n\n');

  // 模型 + 级联回退:UI 覆盖(input.model)只给主模型无回退;否则从 agent.json::models.model
  // 解析——数组形态 = [主模型, ...fallback](--fallback-model 链),单串 = 无回退。
  const resolvedModels = input.model ? { model: input.model } : await resolveAgentModels(input.sessionId, input.agentId);
  const model = resolvedModels.model;
  const fallbackModels = resolvedModels.fallbackModels;

  // 合并工具(去重,名字冲突时先到先得)→ 经 MCP 桥下发内核。
  // 优先级:FORGEAX_TOOLS(内置真值)> extraTools(agent host-tools/kits)
  //   > record.tools(soul-pack tools/*.json)> skill-derived(soul-pack skills/)。
  //   内置/host 工具在冲突时获胜,soul-pack 不能覆盖宿主真值工具。
  const seen = new Set(FORGEAX_TOOLS.map((t) => t.name));
  const tools: TurnRequest['tools'] = [...FORGEAX_TOOLS];
  type ToolEntry = NonNullable<TurnRequest['tools']>[number];
  const pushDeduped = (cands: ReadonlyArray<{ name?: string }>) => {
    for (const t of cands) {
      if (t?.name && !seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t as ToolEntry);
      }
    }
  };
  pushDeduped(input.extraTools ?? []);
  // R2/C1:把 soul-pack「重生」时带来的 tools(已是 ToolSpec[])注入本轮。
  pushDeduped(record.tools ?? []);
  // skills(SkillRefLite,非 ToolSpec)→ 派生最小 invocation ToolSpec,让内核能放行 +
  //   agent 自知其技能。kind/description 透传到 description;暂用 `args` 自由文本入参,
  //   结构化 skill schema 待 SkillRunner 接线(follow-up)。
  pushDeduped(skillsToToolSpecs(record.skills ?? []));

  // P3(B 路径):给每个工具标 `delivery`——own 的「安全类且 core 有 builtin 实现」的工具
  //   标 'local'(forgeax-core 内核本进程直跑,经 NodeSandboxFs,满速+crash 隔离);危险类
  //   (bash/出网/删/凭据)、host 专属(list_games/query_world…)、imported 一律 'host'(缺省,
  //   回宿主走 host-tool-bridge→checkKernelTool 把闸)。claude-code/codex 等租用内核忽略此字段。
  //   fail-closed:trustTier 非 'own' 或不在 allowlist → 'host'。
  const deliveredTools = tools.map((t) => ({
    ...t,
    delivery: (record.trustTier === 'own' && t.name != null && LOCAL_CAPABLE_TOOLS.has(t.name)
      ? 'local'
      : 'host') as 'local' | 'host',
  }));

  // F6:仅当目标内核 = 原生 forgeax-core 时,把账本物化成 host-owned history(它消费之);
  //   租用内核(claude-code/codex)忽略 history、走自己会话续接。best-effort:失败 ⇒ 不带
  //   history ⇒ 原生内核退化为单轮自续(契约 fallback),不影响主流程。
  const history = await materializeNativeHistory(input.sessionId, input.agentId);

  return {
    session: { threadId: input.threadId ?? '', agentId: input.agentId },
    callId: input.callId,
    input: {
      text: input.message,
      ...(input.attachments && input.attachments.length ? { attachments: input.attachments } : {}),
    },
    // pack 经 manifest.json 声明的策略(promptMode/toolPolicy)透传给内核 profile。
    // own/builtin(forge)无 manifest ⇒ 缺省 append + 无 toolPolicy(零回归)。
    systemPrompt: {
      charter,
      persona,
      ...(dynamicSuffix ? { dynamicSuffix } : {}),
      ...(record.promptMode ? { mode: record.promptMode } : {}),
    },
    tools: deliveredTools,
    ...(record.toolPolicy ? { toolPolicy: record.toolPolicy } : {}),
    // pack 经 manifest.json 可声明预算硬闸(maxTurns/maxBudgetUsd → --max-turns/--max-budget-usd)。
    budget: record.budget ?? {},
    trustTier: record.trustTier,
    ...(input.sessionId ? { hostSessionId: input.sessionId } : {}),
    ...(input.traceparent ? { traceparent: input.traceparent } : {}),
    ...(model ? { model } : {}),
    ...(fallbackModels && fallbackModels.length ? { fallbackModels } : {}),
    ...(history && history.length ? { history } : {}),
  };
}

/** 物化原生内核所需的 host-owned 历史(仅 FORGEAX_KERNEL_IMPL=forgeax-core 时)。 */
async function materializeNativeHistory(sessionId: string | undefined, agentId: string): Promise<TurnMessage[] | undefined> {
  if (process.env.FORGEAX_KERNEL_IMPL?.trim() !== 'forgeax-core' || !sessionId) return undefined;
  try {
    const session = getSessionManager().peek(sessionId);
    const ledger = session?.ledgers.get(agentId) ?? session?.ledgers.get('forge');
    if (!session || !ledger) return undefined;
    const cw = new ContextWindow(agentId, ledger, session.blackboard);
    const msgs = await cw.buildPrompt();
    return llmMessagesToTurnHistory(msgs);
  } catch {
    return undefined; // 契约 fallback:无 history ⇒ 内核自续
  }
}

/** 把 soul-pack 的 skills(SkillRefLite,非 ToolSpec)派生成最小 invocation ToolSpec。
 *  每个技能 → 一个 `skill_<skillId>` 工具,供内核放行 + agent 自知。结构化 skill
 *  schema(参数/返回)待 SkillRunner 接线,暂用自由文本 `args` 入参(follow-up)。 */
function skillsToToolSpecs(skills: ReadonlyArray<SkillRefLite>): TurnRequest['tools'] {
  const sanitize = (id: string) => id.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return skills
    .filter((s) => s && typeof s.skillId === 'string' && s.skillId.trim())
    .map((s) => ({
      name: `skill_${sanitize(s.skillId)}`,
      description: s.description?.trim() || `Invoke the "${s.skillId}" skill (${s.kind}).`,
      inputSchema: { type: 'object', properties: { args: { type: 'string' } } },
    }));
}

/** 当前 chat tab 绑定的游戏 slug(peek-only,不 hydrate);'default'/不存在 → undefined。 */
function sessionScopeSlug(sid?: string): string | undefined {
  if (!sid) return undefined;
  try {
    const slug = getSessionManager().peek(sid)?.config.defaultDir;
    if (!slug || slug === 'default') return undefined;
    const dir = resolvePath(defaultProjectRoot(), '.forgeax/games', slug);
    return existsSync(dir) ? slug : undefined;
  } catch {
    return undefined;
  }
}

/** best-effort 读 `<sid>/agents/<agentId>/agent.json::models.model`。
 *  数组形态 = [主模型, ...fallback]:首个有效串作 model,其余作 fallbackModels(--fallback-model)。
 *  单串 = 仅主模型、无回退。读不到 → 空。 */
async function resolveAgentModels(
  sessionId?: string,
  agentId?: string,
): Promise<{ model?: string; fallbackModels?: string[] }> {
  if (!sessionId || !agentId) return {};
  try {
    const pm = getPathManager();
    const path = pm.session(sessionId).agent(agentId).agentJson();
    const cfg = JSON.parse(await Bun.file(path).text()) as { models?: { model?: string | string[] | null } };
    const raw = cfg.models?.model;
    if (Array.isArray(raw)) {
      const clean = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (!clean.length) return {};
      return { model: clean[0], ...(clean.length > 1 ? { fallbackModels: clean.slice(1) } : {}) };
    }
    return typeof raw === 'string' && raw.trim() ? { model: raw.trim() } : {};
  } catch {
    return {};
  }
}
