/**
 * composeTurnRequest — 编排层把一次 chat 组装成中立 `TurnRequest`(喂内核)。
 *
 * M2:**编排层真正拥有"组装一轮"**——systemPrompt(charter + persona)在此拼装,
 * 内核只执行。charter/environment/note 来自注入的产品壳 composer(阶段A §3.2),编排层
 * 自身不含游戏宪章内容,故业务无关。
 *   - charter:产品壳宪章 + 当前激活 scope note(稳定缓存前缀)
 *   - persona:marketplace agent 的人格(default/root 无)
 *   - model:优先 body.model,否则读 agent.json::models.model(ModelPicker 不回归)
 *   - tools:M2 仍空(CC 自带工具);MCP 工具下发在 M3。
 */
import type { TurnRequest, TurnMessage } from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getSessionManager } from '../core/session-registry';
import { getPathManager } from '../fs/path-manager';
import { ContextWindow } from '../context-window/context-window';
import { llmMessagesToTurnHistory } from './llm-history';
import { getSystemPromptComposer, getHostTools } from '../orchestration-seams';
import {
  loadAgentRecord,
  composeStableMemory,
  composeEpisodicRecall,
  composeReincarnationNotice,
  emitLifeEvent,
} from '../soul';
import { drainPerceptionNotes } from '../api/lib/perception-registry';
import { firstClassUiToolSpecs } from '../api/lib/ui-manifest-registry';
import type { SkillRefLite } from '../soul/types';
import uiBridgeContract from './ui-bridge-contract.json';

/** P3(B 路径):core 有 builtin 实现的「安全类」工具集。own trustTier 下这些标
 *  `delivery:'local'`(forgeax-core 内核本进程直跑)。name 与 core builtin 对齐,且
 *  forgeax-cli `builtin/kits/workspace/tools/` 同名。危险类(bash/出网/删/凭据)与 host
 *  专属工具(list_games/query_world…)不入此集 → 仍走 host 桥把闸。 */
const LOCAL_CAPABLE_TOOLS = new Set<string>(['read_file', 'write_file', 'edit_file', 'grep', 'glob']);

/** 编排层声明的基础工具(中立 ToolSpec)。内核据此挂 MCP server + `--allowedTools` 放行。
 *  `memory_search`/`remember` = 数字生命(R6)通道,真实后端 = soul 分层记忆库。
 *  游戏语义工具(list_games/query_world/capture_frame)**不再硬编码于此**——由产品壳
 *  经 HostToolSpec seam 注入(阶段A §3 设计意图,P1-7 落地),cli 层保持业务无关。 */
const FORGEAX_TOOLS = [
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
  // UI 语义操作层(产品 AI 化 P0):ui_snapshot / ui_invoke。契约 SSOT =
  // ui-bridge-contract.json(与 .mjs MCP server 共读同一文件 → 各内核看到字节一致的
  // 工具说明)。宿主侧实现在 forgeax-builtin-tools.ts,权限见 trust-gate 的 per-action 特判。
  ...uiBridgeContract.tools,
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
  /** 本轮期望的回复语言(UI 结算:跟随输入 / 快捷开关)。注入进 `dynamicSuffix`
   *  (轮间 user 后缀,不进 persona/charter,不 bust 缓存前缀),让 agent 用该语言
   *  回复。缺省 ⇒ 不注入(agent 自行判断)。 */
  replyLanguage?: 'en' | 'zh';
}

/** 一行回复语言指令(英文中立,注入 dynamicSuffix)。 */
function replyLanguageDirective(lang: 'en' | 'zh'): string {
  const name = lang === 'zh' ? 'Simplified Chinese' : 'English';
  return `# Reply language\nWrite your reply to the user in ${name}. Keep code, identifiers, file paths and technical terms unchanged.`;
}

export async function composeTurnRequest(input: ComposeInput): Promise<TurnRequest> {
  const projectRoot = defaultProjectRoot();
  // charter / environment / note 由注入的产品壳 composer 提供(阶段A §3.2)——编排层不再
  // 硬编码游戏宪章。无注入(standalone game-agnostic cli)⇒ composer 缺省 ⇒ 三段皆空。
  const composer = getSystemPromptComposer();
  const scopeSlug = sessionScopeSlug(input.sessionId ?? input.threadId) ?? getPathManager().resolveScope();
  const note = composer?.activeGameNote(scopeSlug) ?? '';
  // environment(Paths / 当前游戏 / Workbench 插件 / Skills 目录)。Working directory =
  //   projectRoot:core 文件工具相对 process.cwd()(serve.ts 即 projectRoot)解析,与 charter
  //   「starts at project root」一致。best-effort:composer 未就绪/异常 → 跳过 environment,不挡本轮。
  let environment = '';
  try {
    environment = composer?.environment({ cwd: projectRoot, projectRoot, slug: scopeSlug ?? null }) ?? '';
  } catch {
    environment = '';
  }
  const charter = [composer?.charter() ?? '', environment, note].filter((s) => s && s.trim()).join('\n\n');

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
  const replyLang = input.replyLanguage ? replyLanguageDirective(input.replyLanguage) : '';
  const dynamicSuffix = [rebirth, episodic, runtimeFeedback, replyLang].filter((s) => s && s.trim()).join('\n\n---\n\n');

  // 模型 + 级联回退:UI 覆盖(input.model)只给主模型无回退;否则从 agent.json::models.model
  // 解析——数组形态 = [主模型, ...fallback](--fallback-model 链),单串 = 无回退。
  const resolvedModels = input.model ? { model: input.model } : await resolveAgentModels(input.sessionId, input.agentId);
  const model = resolvedModels.model;
  const fallbackModels = resolvedModels.fallbackModels;

  // 合并工具(去重,名字冲突时先到先得)→ 经 MCP 桥下发内核。
  // 优先级:FORGEAX_TOOLS(内置真值)> seam hostTools(产品壳注入,如 list_games/
  //   query_world/capture_frame)> first-class UI action(manifest 派生)> extraTools
  //   (agent host-tools/kits)> record.tools(soul-pack tools/*.json)> skill-derived。
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
  // seam hostTools:只出墙可序列化三元组(run 是宿主侧执行体,永不过 wire)。
  pushDeduped(getHostTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
  // P1-9 一等工具化:manifest 里标 firstClass 的 UI action 派生独立 ToolSpec
  //   (ui_act_*)。模型原生看到 schema、免一次 snapshot 发现往返;执行/权限在两个
  //   host 工具执行口被反解回 ui_invoke(actionId)走同一 per-action 闸与往返。
  pushDeduped(firstClassUiToolSpecs(input.sessionId));
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
    // 编排层(数字生命引擎)拥有记忆成长 → 内核**不得自主**跑 auto-memory(防双写/双成本/两套SSOT)。
    // 内核的 fork-extract 机制仍可被编排层驱动;forgeax-core 本无自主记忆=no-op,rented(cc)据此关闭其自带提取。
    memoryAutonomy: false,
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
    // existence guard via PathManager (path-segments, no `.forgeax/games` literal).
    return existsSync(getPathManager().user().gameDir(slug)) ? slug : undefined;
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
    const cfg = JSON.parse(await readFile(path, 'utf8')) as { models?: { model?: string | string[] | null } };
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
