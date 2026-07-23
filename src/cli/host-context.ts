/**
 * Host-context 装配(从 cli/main.ts `runCli` 抽出,供 runCli 与 TUI driver 共用)。
 *
 * 这是 forgeax-core「最小自带 host」的全量装配路径:从 env/--demo 造 provider,
 * 注 NodeSandboxFs/NodeTerminal,跑 assembleCapabilities(builtin+web+todo+notebook+
 * memory+skill+mcp+plugin+hooks+subagent),建 AgentContext,并返回 disposers/bus/store。
 *
 * ⚠️ 与同步的 `buildContext`(main.ts)区别:那条**无** mcp/plugin/hooks/disposers,
 * 只服务测试 + 简单嵌入。TUI driver 与 runCli 必须走**本文件**(§0-A、PRD §4)。
 *
 * Boundary(HOST 层):仅 core 相对 import + node:。
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import type { AgentContext } from '../agent/types';
import { DEFAULT_MAIN_MAX_TURNS } from '../agent/agent';
import type { LLMProvider, ProviderMessage } from '../provider/types';
import { resolveProviderEnv, resolveProviderFromEnv } from './provider-env';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { contextWindowForModel } from '../context/model-window';
import { NodeSandboxFs, NodeTerminal, makeNodeBackgroundSpawn } from './io';
import { withSandbox } from './sandbox-terminal';
import { makeImageDownscaler } from './image-scale';
import { EventBus } from '../events/event-bus';
import { assembleCapabilities } from '../runtime/assemble';
import { makeSpawnSyncHookRunner, makeHttpSearchBackend, makeDefaultSearchBackend } from './host-bits';
import { makeStdioMcpFactory } from './mcp-stdio';
import { makeEnvTokenProvider } from './mcp-token';
import { connectStore } from '../history/event-store';
import { JsonlFileEventStore } from './event-store-fs';
import type { EventStore } from '../inject/types';
import { loadAgentDefs, buildSubagentRegistry } from '../capability/agent/index';
import { builtinSubagents } from '../capability/agent/builtin/index';
import { resolveSubagentSystem } from '../agent/subagent-registry';
import { DEFAULT_SUBAGENT_MAX_TURNS, type SubagentResult } from '../agent/subagent';
import { BackgroundTasks } from '../agent/background';
import { TaskNotificationHub } from './task-notification';
import { demoProvider } from './demo-provider';
import { TeamBoardStore, taskBoardToolsPack } from '../agent/team/task-board-tools';
import { InProcessTeammateExecutor } from '../inject/in-process-teammate-executor';
import { buildInboxClosure } from '../agent/team/inbox-router';
import { sendMessageTool } from '../capability/builtin-tools/message-tools';
import { teamSpawnTool } from '../capability/builtin-tools/team-spawn-tool';
import { makeTeamPeerSpawner } from './peer';
import { makeEnvSlot } from './env-slot';
import { effectiveSkillDirs, effectiveCommandDirs, discoverAgentDirs, discoverPluginDirs, loadMergedMcpConfig } from './locations';
import { getMergedSettings } from './settings';
import { configHomeDir } from './settings';
import { loadPermissionRulesFromSettings } from './permission-settings';
import type { PermissionRuleSet } from '../permission/rules';

export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_LEADING = 'You are forgeax-core, a self-contained coding agent running as a CLI.';

/**
 * 交互式主 loop 单次用户请求的「LLM↔工具」往返硬上限。
 *
 * 交互式主会话不该被低上限硬截停——一个复杂任务轻松 >24 往返(命中即弹「已停止:
 * max_turns」)。这里只保留一个**防失控**的高位兜底(同一工具连错、token 预算、
 * reactive autocompact 等另有更精细的兜底),给正常长任务足够余量。
 * `FORGEAX_MAX_TURNS` 可覆盖(<=0 / 非法 → 退回默认)。
 *
 * 子 agent 走 `DEFAULT_SUBAGENT_MAX_TURNS`(另一个高位兜底,frontmatter 可逐类收紧),
 * 不走这个常量。
 */
export { DEFAULT_MAIN_MAX_TURNS };

export function resolveMainMaxTurns(raw = process.env.FORGEAX_MAX_TURNS): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAIN_MAX_TURNS;
}

/** host-context 装配所需的输入(runCli 从 CliArgs 喂;driver 自造)。 */
export interface HostContextArgs {
  model: string;
  demo?: boolean;
  memoryDir?: string;
  skillDirs?: string[];
  /** 单文件 markdown 指令根目录(给了即只用 flag,关闭自动发现)。 */
  commandDirs?: string[];
  mcpConfigPath?: string;
  /** MCP server→ENVVAR token 映射(透传给 makeEnvTokenProvider)。 */
  mcpTokenMap?: Record<string, string>;
  pluginDirs?: string[];
  hooksConfigPath?: string;
  searchUrl?: string;
  /** 会话 id(--resume/--session)。设了即开磁盘 WAL + connectStore。 */
  sessionId?: string;
  /** 会话 WAL 根目录(默认 ./.forgeax/sessions)。 */
  sessionsDir?: string;
  /** OS 沙箱开关(E-03):true/false 显式,undefined=看 env/settings。 */
  sandbox?: boolean;
}

/** 全量装配结果。disposers 退出时必须 await(R4)。 */
export interface HostContext {
  context: AgentContext;
  /** plugins/hooks/WAL 订阅的同一 bus。 */
  bus: EventBus;
  provider: LLMProvider;
  /** per-session 磁盘 WAL(--resume 时;否则 undefined)。 */
  store?: EventStore;
  /** 退出清理:断 store + dispose 装配的子进程(mcp/plugin/hooks)。 */
  disposers: Array<() => void | Promise<void>>;
  /** 从分层 settings 的 `permissions.{deny,ask,allow}` 载出的规则集(楔子1 · 046)。
   *  调用方须把它喂进 `new CoreAgent({rules})`,「配置里写 deny」才对本 host 生效。
   *  无 permissions → 三空桶(不改变默认 tier 行为)。 */
  rules: PermissionRuleSet;
  /** team 模式(FORGEAX_TEAM=1):coordinator 的 inbox 闭包——挂到 CoreAgent.inbox 收 peer 回报。
   *  非 team → undefined(CoreAgent 不挂 inbox,零变化)。 */
  coordinatorInbox?: () => ProviderMessage[];
  /** T4/T4.5 后台完成通知中枢:pending 队列 + 唤醒接缝。TUI 经 driver 注册 wake listener
   *  并在 idle 时 drain 合成一轮;非 TUI 宿主不碰它,T4 的 UserPromptSubmit 注入兜底。 */
  taskNotifications: TaskNotificationHub;
}

/** 解析 provider(env/--demo/override 三态)。env 语义见 provider-env(家族可被 FORGEAX_PROVIDER_API 覆盖)。 */
export function resolveHostProvider(args: { model: string; demo?: boolean }, providerOverride?: LLMProvider): LLMProvider {
  if (args.demo || providerOverride) return providerOverride ?? demoProvider();
  const cfg = resolveProviderEnv(args.model);
  if (!cfg.apiKey) {
    // openai-compat 家族凭证 OPENAI_* 优先、兜底 ANTHROPIC_*(见 provider-env),故两者皆可。
    const keyName =
      cfg.api === 'openai-compat' ? 'OPENAI_API_KEY(或 ANTHROPIC_API_KEY)' : 'ANTHROPIC_API_KEY';
    throw new Error(`${keyName} 未设置(api 家族 ${cfg.api})。设置后重试,或用 --demo 演示 CLI 形态。`);
  }
  return resolveProviderFromEnv(args.model);
}

/** 读 hooks 配置文件:支持顶层即 settings,或 `{hooks:{...}}` 包裹。 */
export function readHooksSettings(path: string): Record<string, Array<{ matcher?: string; command: string }>> {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
  return (j.hooks ?? j) as Record<string, Array<{ matcher?: string; command: string }>>;
}

/**
 * 跑全量装配路径,产出 AgentContext + bus + disposers(+ 可选 WAL store)。
 * 与 runCli 的装配逻辑同源(单一真相),TUI driver 直接复用。
 */
export async function buildHostContext(args: HostContextArgs, providerOverride?: LLMProvider): Promise<HostContext> {
  const provider = resolveHostProvider(args, providerOverride);
  const sandboxFs = new NodeSandboxFs();
  // E-03:OS 沙箱(可用且开启时套 SandboxedTerminal;要求但不可用 → loud 降级)。
  const { terminal } = withSandbox(new NodeTerminal(), args.sandbox);
  // toolContext 开放形状:assemble 建出的后台进程注册表(007)在装配后挂到 shellRegistry。
  //   downscaleImage:图片进 context 前缩图(对齐 CC;read_file 经 ctx 消费,缺省 degrade)。
  const downscaleImage = makeImageDownscaler();
  const toolContext: Record<string, unknown> = {
    sandboxFs,
    terminal,
    cwd: process.cwd(),
    ...(downscaleImage ? { downscaleImage } : {}),
  };
  const bus = new EventBus();
  const searchBackend = args.searchUrl ? makeHttpSearchBackend(args.searchUrl) : makeDefaultSearchBackend();

  // T4:后台完成 → 对话主动回注(`<task_notification>`)。纯 HOST 层接线,core 不改。
  //   观察侧①:包装 makeNodeBackgroundSpawn() 看后台 bash 的 exit;②:BackgroundTasks.onDone
  //   看后台子 agent settle。注入侧:subscribe(bus) 在 UserPromptSubmit 回执挂 additionalContext。
  const taskNotifications = new TaskNotificationHub();
  // 后台子 agent 登记处:注入 task 工具后,`Task run_in_background:true` 走真后台路径,
  //   settle 时经 onSubagentDone 入队(缺省未注入时该标记被忽略,同步跑;此处注入即启用)。
  const subagentBackground = new BackgroundTasks<SubagentResult>({
    onStart: taskNotifications.onSubagentStart,
    onDone: taskNotifications.onSubagentDone,
  });

  // 自动发现:各能力按 `.forgeax` 约定发现「项目级 + 用户级」目录(项目优先,见 locations.ts)。
  //   规则:**给了 flag 就只用 flag**(关闭该能力的自动发现);否则用发现到的两层目录。
  const skillDirs = effectiveSkillDirs(args.skillDirs);
  const commandDirs = effectiveCommandDirs(args.commandDirs);
  const pluginDirs = args.pluginDirs?.length ? args.pluginDirs : discoverPluginDirs();

  // subagent 类型注册表:内置(Explore / general-purpose)+ 磁盘 agents(项目级 + 用户级)。
  const disk = loadAgentDefs(discoverAgentDirs());
  const registry = buildSubagentRegistry(builtinSubagents, disk);

  // MCP:`--mcp` 给了只读该文件;否则合并 `<root>/mcp.json`(项目键覆盖用户键)。无 → undefined。
  const mcpConfig = loadMergedMcpConfig(args.mcpConfigPath);

  // hooks:`--hooks` 给了走文件;否则读合并 settings 的 `hooks` 键(user<project<local,补上
  //   settings.json 里 hooks 之前未被加载的缺口)。两者都空 → 不挂。
  const hooksSettings = args.hooksConfigPath
    ? readHooksSettings(args.hooksConfigPath)
    : (getMergedSettings().hooks as Record<string, Array<{ matcher?: string; command: string }>> | undefined);

  const assembled = await assembleCapabilities({
    bus,
    searchBackend,
    memory: args.memoryDir ? { dir: args.memoryDir, sandboxFs } : undefined,
    // 分层指令(AGENTS.md/CLAUDE.md + rules + @import):dirs 由 host 算出(发现层不读 env)。
    //   canonical=~/.forgeax(FORGEAX_CONFIG_DIR 优先),CC 兼容=~/.claude,项目=cwd。
    instructions: { cwd: process.cwd(), userForgeax: configHomeDir(), userClaude: resolvePath(homedir(), '.claude') },
    skillDirs,
    commandDirs,
    mcp: mcpConfig
      ? {
          config: mcpConfig,
          // host 注入接缝:stdio spawn factory + env-based token provider;env 透传给
          // parseMcpConfig 做 `${VAR}` 展开 + `auth.tokenEnv` 解析。
          deps: {
            stdioFactory: makeStdioMcpFactory(),
            tokenProvider: makeEnvTokenProvider(args.mcpTokenMap),
          },
          env: process.env,
        }
      : undefined,
    // 007:host 注入真实非阻塞 spawn → 后台 bash 三件套可用。
    //   T4:包一层观察 exit chunk,后台 bash 跑完入队一条 task_notification。
    backgroundSpawn: taskNotifications.wrapBackgroundSpawn(makeNodeBackgroundSpawn()),
    pluginSources: pluginDirs.map((d) => ({ source: 'session' as const, dir: d })),
    hooks: hooksSettings && Object.keys(hooksSettings).length > 0
      ? { settings: hooksSettings, runHook: makeSpawnSyncHookRunner() }
      : undefined,
    task: {
      provider,
      model: args.model,
      toolContext,
      registry,
      resolveSystem: (t) =>
        resolveSubagentSystem(
          registry,
          t,
          `You are a ${t ?? 'general'} subagent of forgeax-core. Do the task and report the result concisely.`,
        )!,
      compactionV2: { summarize: makeProviderCompactSummarize(provider, args.model) },
      contextWindow: contextWindowForModel(args.model),
      // 子 agent 兜底上限;某 agent 的 frontmatter `max-turns` 仍可逐类收紧(对齐 cc)。
      maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
      // T4:后台子 agent 登记处 —— `Task run_in_background:true` 走真后台,settle 时入队通知。
      background: subagentBackground,
    },
  });

  // 007:把装配出的后台进程注册表挂到 toolContext,供三工具经 ctx 取用。
  if (assembled.shellRegistry) toolContext.shellRegistry = assembled.shellRegistry;

  // ── team 接线(FORGEAX_TEAM=1;coordinator-view,无 OOS-3)─────────────────────
  //   per-session 一个共享任务表 + 进程内 executor(mailbox 两平面)+ team 共享 bus。
  //   coordinator(本 agent,id='cli')持 team 工具(task_* + SendMessage + team_spawn);
  //   peer 经 team_spawn 的注入 spawnPeer(HOST 层 makeTeamPeerSpawner)真起,剥 team_spawn/Task。
  //   coordinator inbox 从 executor.mailbox drain peer 的 SendMessage(经既有 CoreAgent.inbox 接缝)。
  const coordinatorId = 'cli';
  let coordinatorInbox: (() => ProviderMessage[]) | undefined;
  let leadingSystemText = DEFAULT_LEADING;
  const teamTools = [];
  // 运行期读 env(非 module-load const):**默认开**;`FORGEAX_TEAM=0` 显式关。
  //   demo provider 不组队(echo 驱不动 peer)→ demo 形态下恒关。
  if (process.env.FORGEAX_TEAM !== '0' && !args.demo) {
    const board = new TeamBoardStore({ teamId: 'tui-team' }); // 内存态(session 内可见;落盘已单测覆盖)
    const executor = new InProcessTeammateExecutor();
    executor.register(coordinatorId);
    const teamBus = new EventBus();
    toolContext.teamBoard = board; // coordinator 的 task_* 工具据此解析共享板
    toolContext.agentId = coordinatorId; // claim 的 owner 主键(loop 不把 context.agentId 注进 tool ctx)
    coordinatorInbox = buildInboxClosure({ self: coordinatorId, mailbox: executor.mailbox });
    const spawnPeer = makeTeamPeerSpawner({ provider, model: args.model, executor, bus: teamBus, board, coordinatorId });
    teamTools.push(
      ...(taskBoardToolsPack().tools ?? []),
      sendMessageTool({ executor, coordinatorId }),
      teamSpawnTool({ spawnPeer }),
    );
    // ★ 让模型理解「启动一个 team」= 用这些工具(否则模型会去翻代码、问你 team 是啥)。
    leadingSystemText +=
      '\n\nTEAM MODE is ON. You are the team coordinator and have team tools: ' +
      '`team_spawn` (form a team of peer agents), `task_create`/`task_list`/`task_get`/`task_update` ' +
      '(a shared task board with atomic claim/owner/blockedBy; task_update {action:"claim"} to take a task), ' +
      'and `SendMessage` (talk to peers / coordinator). ' +
      'When the user asks to start/launch/test a team or its members: seed work with `task_create`, ' +
      'then call `team_spawn` with members (each {name, brief}); peers self-claim tasks from the board and ' +
      'report back to you via SendMessage (you receive their reports next turn). Use `task_list` to see progress. ' +
      'Do NOT go read the source code to figure out what "team" means — just use these tools.';
  }

  const context: AgentContext = {
    agentId: coordinatorId,
    provider,
    config: {
      // env slot 排静态段首:紧跟 leading 作 cwd 锚点(防模型瞎拼绝对路径)。
      systemPromptSlots: [makeEnvSlot(), ...assembled.slots],
      leadingSystemText,
      model: args.model,
      tools: [...assembled.tools, ...teamTools],
      maxTurns: resolveMainMaxTurns(),
    },
    toolContext,
  };

  const disposers: Array<() => void | Promise<void>> = [...assembled.disposers];

  // per-session 磁盘 WAL(--resume <id> / --continue):接同一 bus 持久化事件流
  //   (必须在 assembleCapabilities 之后 → connectStore 排在 blocking hooks 之后,§6.3)。
  let store: EventStore | undefined;
  if (args.sessionId) {
    const file = resolvePath(args.sessionsDir ?? `${process.cwd()}/.forgeax/sessions`, args.sessionId, 'events.jsonl');
    store = new JsonlFileEventStore(file);
    const disconnect = connectStore(bus, store);
    disposers.unshift(disconnect);
  }

  // 权限规则(楔子1 · 046):从分层 settings 的 permissions 段载出(与上面读 hooks 同口径)。
  const rules = loadPermissionRulesFromSettings();

  // T4 注入侧:在 bus 上订阅 UserPromptSubmit,drain 后台完成通知 → additionalContext。
  //   排在 connectStore 之后订阅:WAL 持久化的是干净事件,ephemeral 的 task_notification
  //   只落到 loop 读的内存回执上(resume 不重放旧通知)。unsub 挂 disposers 清理。
  const unsubTaskNotifications = taskNotifications.subscribe(bus);
  disposers.push(unsubTaskNotifications);

  return { context, bus, provider, store, disposers, rules, taskNotifications, ...(coordinatorInbox ? { coordinatorInbox } : {}) };
}
