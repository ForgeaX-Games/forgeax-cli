#!/usr/bin/env bun
/**
 * forgeax-cli CLI — the runnable form factor。
 *
 * forgeax-cli 既是可 embed 的库,也以此 CLI 直接运行:它充当「最小自带 host」,
 * 注入 NodeSandboxFs/NodeTerminal(真实 IO)+ 从 env 造 provider,驱动 CoreAgent 跑
 * 一轮/REPL,把 AgentEvent 流渲染到终端。
 *
 * 用法:
 *   bun src/cli/main.ts -p "做个 X"        # 一次性 print 模式
 *   bun src/cli/main.ts                     # REPL(逐行读 stdin)
 *   bun src/cli/main.ts --demo -p "hi"      # 不需 API key,用内置 echo provider 演示形态
 * env: ANTHROPIC_API_KEY(必需,除非 --demo) · ANTHROPIC_BASE_URL(可选,M1/M2/M4) ·
 *      FORGEAX_MODEL(默认 claude-opus-4-8)
 * Boundary: 仅 core 相对 + node:。
 */
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CoreAgent } from '../agent/agent';
import type { AgentContext } from '../agent/types';
import { builtinToolsPack } from '../capability/builtin-tools/index';
import { webToolsPack } from '../capability/builtin-tools/web-tools';
import { todoToolsPack } from '../capability/builtin-tools/todo-tools';
import { notebookToolsPack } from '../capability/builtin-tools/notebook-tools';
import { memoryPack } from '../capability/memory/index';
import { skillPack } from '../capability/skill/index';
import { makeTaskTool, DEFAULT_SUBAGENT_MAX_TURNS } from '../agent/subagent';
import { loadAgentDefs, buildSubagentRegistry } from '../capability/agent/index';
import { builtinSubagents } from '../capability/agent/builtin/index';
import { resolveSubagentSystem } from '../agent/subagent-registry';
import { AutoMemory, type ForkRunner } from '../capability/memory/auto';
import { runForkedAgent } from '../agent/forked-agent';
import { resolveProvider } from '../provider/register';
import type { LLMProvider, ProviderStreamEvent, Usage, ProviderRequest } from '../provider/types';
import { EMPTY_USAGE } from '../provider/types';
import { makeProviderCompactSummarize } from '../context/compaction-llm';
import { makeRehydrateInjection } from '../context/post-compact-rehydrate';
import { microCompact } from '../context/micro-compaction';
import { contextWindowForModel } from '../context/model-window';
import { describeWindowOverride } from '../context/watermarks';
import { lookupModelContext } from '../context/model-context-table';
import type { ProviderMessage } from '../provider/types';
import { NodeSandboxFs, NodeTerminal, makeNodeBackgroundSpawn } from './io';
import { withSandbox } from './sandbox-terminal';
import { makeImageDownscaler } from './image-scale';
import { BackgroundShellRegistry } from '../capability/builtin-tools/shell-registry';
import { EventBus } from '../events/event-bus';
import type { AskUserFn } from '../agent/dispatch';
import { makeAskUser, makeHttpSearchBackend, makeDefaultSearchBackend } from './host-bits';
import { guardYes } from './escalation-guard';
import { defaultSessionsDir, foldSessionHistory, mostRecentSessionId } from './resume-fold';
import type { EventStore } from '../inject/types';
import { resolve as resolvePath } from 'node:path';
import { renderEvent } from './render';
import type { AutoMemoryHook } from '../agent/agent';
import type { PermissionRuleSet } from '../permission/rules';
import { demoProvider } from './demo-provider';
import { buildHostContext, resolveHostProvider, DEFAULT_MODEL, DEFAULT_LEADING, DEFAULT_MAIN_MAX_TURNS } from './host-context';
import { getMergedSettings } from './settings';
import { coercePermissionMode, PERMISSION_MODES } from '../permission/inspect';
import type { PermissionMode } from '../permission/engine';
import { loadDefaultPermissionModeFromSettings } from './permission-settings';
import { guardBypassMode } from './escalation-guard';
import { FORGEAX_CORE_VERSION } from '../version';
import { trustGate } from './trust';
import { discoverSkillDirs, discoverCommandDirs, discoverAgentDirs } from './locations';
import { makeEnvSlot } from './env-slot';

export interface CliArgs {
  prompt?: string;
  model: string;
  demo: boolean;
  help: boolean;
  version: boolean;
  /** auto-memory 落盘目录;undefined = 关闭。 */
  memoryDir?: string;
  /** skill 根目录(可逗号分隔/多次)。 */
  skillDirs?: string[];
  /** 单文件 markdown 指令根目录(可逗号分隔/多次)。 */
  commandDirs?: string[];
  /** MCP 配置文件路径(`{mcpServers:{...}}`)。 */
  mcpConfigPath?: string;
  /** MCP server→ENVVAR token 映射(`--mcp-token <server=ENVVAR | ENVVAR>`)。 */
  mcpTokenMap?: Record<string, string>;
  /** plugin 源目录(可逗号分隔/多次)。 */
  pluginDirs?: string[];
  /** settings hooks 配置文件路径(`{PreToolUse:[...],...}` 或 `{hooks:{...}}`)。 */
  hooksConfigPath?: string;
  /** 扩展思考:true=默认预算;数字=budget tokens。 */
  thinking?: boolean | number;
  /** web_search 后端 URL(POST {query})。 */
  searchUrl?: string;
  /** 交互式权限:全部放行(否则 'ask' fail-closed deny)。 */
  yes?: boolean;
  /** 初始权限模式(仅显式 `--permission-mode`;settings.permissions.defaultMode 由 runCli 合成)。 */
  permissionMode?: PermissionMode;
  /** serve 模式:在 --sock 指定的 unix-sock 上起双向 JSON-RPC(供 sidecar 托管)。 */
  serve?: boolean;
  /** serve 模式监听的 per-session unix-sock 路径。 */
  sock?: string;
  /** 会话 id(--resume/--session)。设了即开磁盘 WAL + 跨进程 resume。 */
  sessionId?: string;
  /** --continue:续接当前目录**最近活跃**会话(H-04;无会话则新建)。 */
  continueSession?: boolean;
  /** 会话 WAL 根目录(默认 ./.forgeax/sessions)。 */
  sessionsDir?: string;
  /** 关闭 Ink TUI,强制走原 readline REPL(§0-C / R9 回落)。 */
  noTui?: boolean;
  /** OS 沙箱开关(E-03):true=--sandbox、false=--no-sandbox、undefined=看 env/settings。 */
  sandbox?: boolean;
  /** print 模式输出格式(A-01):text(默认,人类可读)/ json(轮终单对象)/ stream-json(逐事件 NDJSON)。 */
  outputFormat?: 'text' | 'json' | 'stream-json';
}

function appendList(prev: string[] | undefined, v: string): string[] {
  return [...(prev ?? []), ...v.split(',').map((s) => s.trim()).filter(Boolean)];
}

export function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    // 模型优先级:`--model` flag(下方循环覆盖)> FORGEAX_MODEL env >
    //   合并后的 settings.model(user<project<local,含上轮 /model 选择)>
    //   ANTHROPIC_MODEL env > DEFAULT_MODEL。
    // ANTHROPIC_MODEL 只是上游 provider 的兼容默认值；若把它放在 settings 前，/model
    // 虽然已成功落盘，重启后仍会被常见的 shell 环境变量盖掉，表现为选择“失效”。
    model:
      process.env.FORGEAX_MODEL ??
      getMergedSettings().model ??
      process.env.ANTHROPIC_MODEL ??
      DEFAULT_MODEL,
    demo: false,
    help: false,
    version: false,
    memoryDir: process.env.FORGEAX_MEMORY_DIR ?? `${process.cwd()}/.forgeax/memory`,
    sessionsDir: process.env.FORGEAX_SESSIONS_DIR ?? `${process.cwd()}/.forgeax/sessions`,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-p' || t === '--print') a.prompt = argv[++i];
    else if (t === '--model') a.model = argv[++i];
    else if (t === '--demo') a.demo = true;
    else if (t === '--memory') a.memoryDir = argv[++i];
    else if (t === '--no-memory') a.memoryDir = undefined;
    else if (t === '--skills') a.skillDirs = appendList(a.skillDirs, argv[++i]);
    else if (t === '--commands') a.commandDirs = appendList(a.commandDirs, argv[++i]);
    else if (t === '--mcp') a.mcpConfigPath = argv[++i];
    else if (t === '--mcp-token') {
      // `<server=ENVVAR>` → 把该 server 的 token env 名记进 map;裸 `<ENVVAR>` →
      // 设为 `*` 通配(provider 对未显式映射的 server 兜底用它,优先于约定名)。
      const raw = argv[++i] ?? '';
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        const server = raw.slice(0, eq).trim();
        const envName = raw.slice(eq + 1).trim();
        if (server && envName) (a.mcpTokenMap ??= {})[server] = envName;
      } else if (raw.trim()) {
        (a.mcpTokenMap ??= {})['*'] = raw.trim();
      }
    }
    else if (t === '--plugins') a.pluginDirs = appendList(a.pluginDirs, argv[++i]);
    else if (t === '--hooks') a.hooksConfigPath = argv[++i];
    else if (t === '--search-url') a.searchUrl = argv[++i];
    else if (t === '--serve') a.serve = true;
    else if (t === '--sock') a.sock = argv[++i];
    // --session-id:外部指定会话 id(新会话亦可,供外部系统事后 --resume 同一 id;对齐 cc --session-id)。
    //   --resume/--session 语义相同(已存在则续接,不存在则以此 id 新建);三者都把 id 用作 WAL 目录名。
    else if (t === '--resume' || t === '--session' || t === '--session-id') a.sessionId = argv[++i];
    else if (t === '-c' || t === '--continue') a.continueSession = true;
    else if (t === '--sessions-dir') a.sessionsDir = argv[++i];
    else if (t === '--yes') a.yes = true;
    else if (t === '--permission-mode') {
      // 唯一 fail-fast 的 flag:权限姿态写错就静默回 default 是安全反模式(用户以为在 plan/
      //   bypass 实际不在)。缺值/非法 → 抛 usage error(runCli 捕获 → stderr + exit 1)。
      const v = argv[++i];
      const m = coercePermissionMode(v);
      if (!m) {
        throw new Error(
          `--permission-mode 需要合法模式(收到 ${v === undefined ? '空' : JSON.stringify(v)});可选:${PERMISSION_MODES.join(' / ')}`,
        );
      }
      a.permissionMode = m;
    }
    else if (t === '--no-tui') a.noTui = true;
    else if (t === '--sandbox') a.sandbox = true;
    else if (t === '--no-sandbox') a.sandbox = false;
    else if (t === '--output-format') {
      const v = argv[++i];
      if (v === 'text' || v === 'json' || v === 'stream-json') a.outputFormat = v;
    }
    else if (t === '--thinking') {
      // 可选紧跟一个数字预算;否则布尔开。
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) { a.thinking = Number(next); i++; } else a.thinking = true;
    }
    else if (t === '-h' || t === '--help') a.help = true;
    else if (t === '-v' || t === '--version') a.version = true;
    else if (!t.startsWith('-') && a.prompt == null) a.prompt = t;
  }
  return a;
}

export function buildContext(args: CliArgs, providerOverride?: LLMProvider): AgentContext {
  const provider = resolveHostProvider(args, providerOverride);
  const sandboxFs = new NodeSandboxFs();
  // 007:后台 bash 三件套共享注册表(经 toolContext 开放字段挂给三工具)。
  const shellRegistry = new BackgroundShellRegistry(makeNodeBackgroundSpawn());
  // E-03:OS 沙箱(可用且开启时套 SandboxedTerminal;要求但不可用 → loud 降级)。
  const { terminal } = withSandbox(new NodeTerminal(), args.sandbox);
  const downscaleImage = makeImageDownscaler();
  const toolContext = {
    sandboxFs,
    terminal,
    cwd: process.cwd(),
    shellRegistry,
    ...(downscaleImage ? { downscaleImage } : {}),
  };
  const searchBackend = args.searchUrl ? makeHttpSearchBackend(args.searchUrl) : makeDefaultSearchBackend();

  // 同步可构造的能力包(builtin + web/todo/notebook + memory + skill)。mcp/plugin/hooks
  // 这类异步/绑定 bus 的能力由 runCli 经 assembleCapabilities 接;buildContext 服务
  // 测试 + 简单嵌入(无 bus 副作用)。
  const memPack = args.memoryDir ? memoryPack({ memoryDir: args.memoryDir, sandboxFs }) : null;
  // skill/commands 自动发现(与 host-context 同源):给了 flag 只用 flag,否则发现项目级+用户级。
  const skillDirs = args.skillDirs?.length ? args.skillDirs : discoverSkillDirs();
  const commandDirs = args.commandDirs?.length ? args.commandDirs : discoverCommandDirs();
  const base = [
    ...(builtinToolsPack().tools ?? []),
    ...(webToolsPack({ searchBackend }).tools ?? []),
    ...(todoToolsPack().tools ?? []),
    ...(notebookToolsPack().tools ?? []),
    ...(memPack?.tools ?? []),
    ...(skillPack(skillDirs, undefined, { commandDirs }).tools ?? []),
  ];
  // subagent 类型注册表:内置(Explore / general-purpose)+ 磁盘 agents(项目级 + 用户级;
  // 磁盘同名覆盖内置)。无磁盘 agent 目录时 disk=[],registry 只含内置 —— 未指定
  // subagent_type 的 Task 解析为 undefined → 全量工具(剥 Task)+ 兜底 system,与从前一致。
  const registry = buildSubagentRegistry(
    builtinSubagents,
    loadAgentDefs(discoverAgentDirs()),
  );
  // Task 工具:父可派 subagent;子工具按 type 从 registry 解析(allTools=base,**不含 Task**,
  // 防无限递归)。子继承同一 IO。registry 的 per-type systemPrompt 优先,未命中退回兜底。
  const taskTool = makeTaskTool({
    provider,
    model: args.model,
    registry,
    allTools: base,
    resolveSystem: (t) =>
      resolveSubagentSystem(registry, t, `You are a ${t ?? 'general'} subagent of forgeax-cli. Do the task and report the result concisely.`)!,
    toolContext,
    // subagent 自压缩(V2)+ 压后重挂(D-01)。
    compactionV2: { summarize: makeProviderCompactSummarize(provider, args.model), rehydrate: makeRehydrateInjection(toolContext) },
    contextWindow: contextWindowForModel(args.model),
    // 子 agent 兜底上限;某 agent 的 frontmatter `max-turns` 仍可逐类收紧(对齐 cc)。
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
  });
  return {
    agentId: 'cli',
    provider,
    config: {
      // env slot 排静态段首:给模型 cwd 锚点(防瞎拼绝对路径)。
      systemPromptSlots: [makeEnvSlot(), ...(memPack?.slots ?? [])],
      leadingSystemText: DEFAULT_LEADING,
      model: args.model,
      tools: [...base, taskTool],
      maxTurns: DEFAULT_MAIN_MAX_TURNS,
    },
    toolContext,
  };
}

/** --thinking 标志 → ProviderRequest.thinking。 */
function thinkingFromArg(t: boolean | number | undefined): ProviderRequest['thinking'] | undefined {
  if (t == null || t === false) return undefined;
  if (t === true) return { type: 'enabled', budgetTokens: 8192 };
  return { type: 'enabled', budgetTokens: t };
}

export interface RunTurnOpts {
  autoMemory?: AutoMemoryHook;
  /** plugins/hooks 订阅的同一 bus(runCli 传;不传则 agent 自建,无订阅者)。 */
  bus?: EventBus;
  /** 交互式权限回路。 */
  askUser?: AskUserFn;
  /** 扩展思考配置。 */
  thinking?: ProviderRequest['thinking'];
  /** 回合中插话源。 */
  steeringSource?: () => ProviderMessage[];
  /** per-session 磁盘 WAL。设了即:每轮从它 fold 出历史喂进 agent.run(跨进程 resume)。
   *  事件的持久化由 runCli 在同一 bus 上 connectStore 完成,本字段只负责「读回历史」。 */
  store?: EventStore;
  /** team(FORGEAX_TEAM):coordinator inbox 闭包,挂 CoreAgent.inbox 收 peer 回报。 */
  inbox?: () => ProviderMessage[];
  /** 权限规则集(楔子1 · 046):从 settings.permissions 载出。runCli 传 host.rules;
   *  不传则无 settings 规则(默认 tier 行为不变)。 */
  rules?: Partial<PermissionRuleSet> | null;
  /** CORE-CTX-005:大结果落盘钩子(runCli 据 sessionsDir 构造);截断超限结果时全量落盘可回读。 */
  persistToolResult?: (raw: string, meta: { toolUseId: string; toolName: string }) => string | undefined;
  /** A-01:输出格式(缺省 text)。json=轮终一次性 result 对象;stream-json=每事件一行 NDJSON。 */
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** A-01:json result 里回填的 session id(供机器消费方关联)。 */
  sessionId?: string;
  /** 初始权限模式(P2:flag > settings.permissions.defaultMode > default;runCli 解析后传入)。
   *  print / 管道 / readline 每轮共用同一启动值——不记忆进程内临时切换。 */
  mode?: PermissionMode;
}

/** 跑一轮,把渲染结果写到 out(默认 stdout)。返回终态 reason。 */
export async function runTurn(
  context: AgentContext,
  prompt: string,
  out: (s: string) => void,
  opts: RunTurnOpts = {},
): Promise<string> {
  const agent = new CoreAgent({
    context,
    bus: opts.bus,
    globalCacheEnabled: true,
    // 权限规则(楔子1 · 046):settings.permissions.{deny,ask,allow} 载出的规则集
    //   (runCli 经 host.rules 传入);engine ① deny > ② ask > ⑦ allow 生效。
    ...(opts.rules ? { rules: opts.rules } : {}),
    // 初始权限模式(P2):缺省不传 = CoreAgent 默认 'default',零变化。
    ...(opts.mode ? { mode: opts.mode } : {}),
    // CLI 独立形态自管权限:开 core 内置受保护路径检查,保护本机 .git/.forgeax/shell-rc。
    enableSafetyCheck: true,
    autoMemory: opts.autoMemory,
    askUser: opts.askUser,
    thinking: opts.thinking,
    steeringSource: opts.steeringSource,
    ...(opts.inbox ? { inbox: opts.inbox } : {}), // team:coordinator 收 peer 回报(既有 inbox 接缝)
    // 主 loop 到水位自压缩(V2)+ 压后重挂最近读文件(D-01;recentReadPaths 由 loop 自取)。
    compactionV2: {
      summarize: makeProviderCompactSummarize(context.provider, context.config.model),
      rehydrate: makeRehydrateInjection(context.toolContext),
    },
    microCompact: (msgs: ProviderMessage[]) => microCompact(msgs, { now: Date.now() }), // 每轮 time-based micro
    // CORE-CTX-005:大结果落盘钩子(host/sessionDir 领地);缺省不注入 → 旧行为。
    ...(opts.persistToolResult ? { persistToolResult: opts.persistToolResult } : {}),
    contextWindow: contextWindowForModel(context.config.model),
  });
  // resume:从 per-session WAL fold 出历史(本轮之前的全部事件)→ seed 进 agent.run。
  //   store 的写入由 runCli 的 connectStore(同一 bus)负责;这里只读回(抽成
  //   resume-fold.ts 的纯函数,与未来 TUI /resume、serve RPC 复用同一条 fold 路径)。
  //   空/无 store → undefined → 单轮。
  const history = await foldSessionHistory(opts.store);
  const fmt = opts.outputFormat ?? 'text';
  let reason = 'completed';
  let resultText = ''; // A-01 json:累积 assistant 文本块
  for await (const ev of agent.run({
    input: { type: 'user', payload: prompt, ts: 0 },
    ...(history ? { history } : {}),
  })) {
    if (fmt === 'stream-json') {
      // 逐事件 NDJSON —— 直接序列化 bus 上的 AgentEvent(SSOT,不另造 DTO)。
      out(JSON.stringify(ev) + '\n');
    } else if (fmt === 'json') {
      if (ev.type === 'assistant') {
        const content = (ev.message.payload as { content?: Array<{ type: string; text?: string }> })?.content;
        if (Array.isArray(content)) {
          resultText += content.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('');
        }
      }
    } else {
      const s = renderEvent(ev);
      if (s) out(s);
    }
    if (ev.type === 'done') reason = ev.terminal.reason;
  }
  await agent.drainAutoMemory(); // 等 auto-memory 后台抽取落盘
  if (fmt === 'json') {
    // 轮终一次性结果对象(对齐 CC/cbc headless json result 形态)。
    out(
      JSON.stringify({
        type: 'result',
        subtype: reason === 'completed' ? 'success' : reason,
        is_error: reason !== 'completed',
        result: resultText,
        session_id: opts.sessionId ?? null,
        reason,
      }) + '\n',
    );
  }
  return reason;
}

const HELP = `forgeax-cli — self-contained coding agent CLI

usage:
  forgeax-cli -p "<prompt>"     one-shot print mode
  forgeax-cli                   REPL
  forgeax-cli --demo -p "hi"    demo (no API key)
  forgeax-cli mcp-serve         reverse MCP server over stdio (expose core tools to MCP clients; --allow-writes for mutating tools)

flags:
  -p, --print <prompt>   run once and exit
  --output-format <fmt>  print output: text (default) | json (one result object) | stream-json (NDJSON per event)
  --model <id>           model (default ${DEFAULT_MODEL})
  --demo                 built-in echo provider (no network)
  --memory <dir>         auto-memory dir (default ./.forgeax/memory)
  --no-memory            disable auto-memory
  --skills <dir,...>     skill root dir(s) (else auto: .forgeax/skills + ~/.forgeax/skills)
  --commands <dir,...>   markdown command dir(s) (else auto: .forgeax/commands + ~/.forgeax/commands)
  --mcp <config.json>    MCP servers config ({mcpServers:{...}}; else auto: .forgeax/mcp.json + ~/.forgeax/mcp.json)
  --mcp-token <s=ENV|ENV>  MCP bearer token env name (per server or wildcard)
  --plugins <dir,...>    plugin source dir(s)
  --hooks <config.json>  settings hooks ({PreToolUse:[{matcher,command}],...})
  --search-url <url>     web_search backend (POST {query}); else env FORGEAX_SEARCH_URL / BRAVE_API_KEY; unset → web_search hidden
  --thinking [budget]    enable extended thinking (optional token budget)
  --resume <id>          persist + resume a session (multi-turn across processes)
  --session-id <id>      use a specific session id (new or existing; alias of --resume)
  -c, --continue         resume the most recently active session in this dir (new if none)
  --sessions-dir <dir>   session WAL root (default ./.forgeax/sessions)
  --yes                  ⚠ DANGER: auto-approve ALL permission prompts (full access; = --dangerously-skip-permissions). Refused as root.
  --permission-mode <m>  initial permission mode: default | acceptEdits | plan | bypassPermissions (also settings permissions.defaultMode; bypass refused as root / when disabled by settings)
  --no-tui               force readline REPL (disable Ink TUI)
  --sandbox / --no-sandbox  OS sandbox for Bash (macOS Seatbelt / Linux bwrap); else env FORGEAX_SANDBOX / settings.sandbox.enabled
  -h, --help             this help
  -v, --version          version
env: ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, FORGEAX_MODEL, FORGEAX_MEMORY_DIR`;

/** 读 hooks 配置文件:支持顶层即 settings,或 `{hooks:{...}}` 包裹。 */
function readHooksSettings(path: string): Record<string, Array<{ matcher?: string; command: string }>> {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
  return (j.hooks ?? j) as Record<string, Array<{ matcher?: string; command: string }>>;
}

/** 读 stdin 全部内容作一次性 prompt(stdin 非 TTY = 管道/重定向时用)。timeoutMs 内无任何
 *  数据则放弃返回已得内容(继承的空管道「不写不关」会永久挂起,用超时兜底)。 */
function readStdin(timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;
    // StringDecoder:stdin 分片可能切在多字节 UTF-8 序列中间,逐块 `toString` 会把不完整
    // 尾字节解成 U+FFFD 并丢字节(同 ipc/rpc 帧解析,见验收报告 A.5)。缓到下一片再解。
    const decoder = new StringDecoder('utf8');
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      data += decoder.end(); // flush 任何残留尾字节
      resolve(data);
    };
    const onData = (chunk: Buffer | string): void => {
      data += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

export async function runCli(argv: string[], providerOverride?: LLMProvider): Promise<number> {
  // 反向 MCP server 子命令(F-01):`forgeax-cli mcp-serve` 以 stdio MCP server
  //   形态暴露本内核工具集给外部 MCP 客户端。与 `--serve`(AgentKernel sidecar)并存。
  //   host 入口在此装配工具集 + 权限规则,把纯 deps 交给 mcp-serve 的协议循环
  //   (mcp-serve 不反向 import main —— 避免入口 ↔ 子模块循环依赖)。
  if (argv[0] === 'mcp-serve') {
    const sub = argv.slice(1);
    const allowMutations = sub.includes('--allow-writes') || process.env.FORGEAX_MCP_ALLOW_WRITES === '1';
    let subArgs: CliArgs;
    try {
      subArgs = parseArgs(sub.filter((a) => a !== '--allow-writes'));
    } catch (e) {
      process.stderr.write(`[forgeax-cli] ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    // mcp-serve 不创建 agent(只暴露工具集),没有权限模式可设——显式 flag 静默无效是安全反模式,拒绝。
    if (subArgs.permissionMode) {
      process.stderr.write('[forgeax-cli] mcp-serve 不接受 --permission-mode(该形态不创建 agent,无权限模式)。\n');
      return 1;
    }
    const context = buildContext(subArgs, providerOverride);
    const { loadPermissionRulesFromSettings } = await import('./permission-settings');
    const { runMcpServe } = await import('./mcp-serve');
    return await runMcpServe({
      tools: context.config.tools,
      toolContext: context.toolContext as Record<string, unknown>,
      rules: loadPermissionRulesFromSettings(),
      allowMutations,
    });
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`[forgeax-cli] ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.version) {
    process.stdout.write(`forgeax-cli ${FORGEAX_CORE_VERSION}\n`);
    return 0;
  }

  // E-05:`--yes`(自动放行一切 ask)是危险姿态 —— root/sudo 下拒绝启动(误伤面最大)。
  if (args.yes) {
    const v = guardYes();
    if (!v.allowed) {
      process.stderr.write(`[forgeax-cli] ${v.reason}\n`);
      return 1;
    }
  }

  // serve 模式:起 RPC server 托管本内核,常驻直到 sidecar SIGTERM(不返回)。
  if (args.serve) {
    // serve 的权限模式由 setPermissionMode RPC / TurnRequest.permissionMode 控制;
    //   显式 flag 看似接受实则无效 → 拒绝(settings.defaultMode 不在此列,不创建即不消费)。
    if (args.permissionMode) {
      process.stderr.write('[forgeax-cli] --serve 不接受 --permission-mode(权限模式经 setPermissionMode RPC / TurnRequest.permissionMode 控制)。\n');
      return 1;
    }
    const sock = args.sock ?? process.env.FORGEAX_CORE_SOCK;
    if (!sock) {
      process.stderr.write('forgeax-cli --serve 需要 --sock <path>(或 FORGEAX_CORE_SOCK)。\n');
      return 1;
    }
    const { startServe } = await import('./serve');
    await startServe(sock);
    // 常驻:net.Server 持有事件循环;靠 SIGTERM/SIGINT 退出(startServe 已挂)。
    await new Promise<never>(() => {});
    return 0; // unreachable
  }

  const write = (s: string): void => void process.stdout.write(s);
  // A-01:json/stream-json 模式下,stdout 必须是纯净的机器可读流 —— 诊断/提示行改走 stderr。
  const jsonMode = args.outputFormat === 'json' || args.outputFormat === 'stream-json';
  const info = (s: string): void => void (jsonMode ? process.stderr.write(s) : write(s));

  // ── 初始权限模式(P2):flag > settings.permissions.defaultMode > default。
  //    非法 settings 值仅在无显式 flag 时警告(有 flag 时低优先级坏值不制造噪音);
  //    warning 恒走 stderr,不污染 json/stream-json 的 stdout。
  let initialMode: PermissionMode = 'default';
  if (args.permissionMode) {
    initialMode = args.permissionMode;
  } else {
    const dm = loadDefaultPermissionModeFromSettings();
    if (dm.kind === 'valid') initialMode = dm.mode;
    else if (dm.kind === 'invalid') {
      process.stderr.write(
        `[forgeax-cli] settings.permissions.defaultMode 非法(${JSON.stringify(dm.value)}),已回退 default。可选:${PERMISSION_MODES.join(' / ')}。\n`,
      );
    }
  }
  // E-05:启动即 bypass 是危险姿态 —— root / settings killswitch 下拒绝启动(与 /permissions 切换同一护栏)。
  if (initialMode === 'bypassPermissions') {
    const v = guardBypassMode();
    if (!v.allowed) {
      process.stderr.write(`[forgeax-cli] ${v.reason}\n`);
      return 1;
    }
  }

  // ── TUI 分支(PRD §0-C / R9):裸跑 + TTY + 无 -p/--serve + 非 FORGEAX_NO_TUI/--no-tui
  //    → 起 Ink TUI(进程内 embed CoreAgent,原生 askUser 弹卡)。否则维持原 headless /
  //    --serve / readline REPL。ink 加载失败也回落 readline。判定靠运行态(TTY+flags)。
  //   判定轴(`isNonInteractive = … || !process.stdout.isTTY`):
  //   能否进 TUI 取决于**渲染目标 stdout** 是不是终端,而非 stdin。再加 raw-mode 判定——
  //   Ink useInput 收键盘需要 stdin 支持 setRawMode。于是:
  //     · stdout 被重定向(`forgeax > out.txt`)→ stdoutTTY=false → 不进 TUI(不再把界面画进文件);
  //     · stdin 是管道(`echo x | forgeax`)→ stdinRawOk=false → 不进 TUI,落到下方 headless 吸 stdin 作 prompt。
  const stdoutTTY = process.stdout.isTTY === true;
  const stdinRawOk = process.stdin.isTTY === true && typeof process.stdin.setRawMode === 'function';
  const wantTui =
    args.prompt == null &&
    !args.serve &&
    !args.noTui &&
    !process.env.FORGEAX_NO_TUI &&
    stdoutTTY &&
    stdinRawOk;

  // ── 信任门(设计稿 §3.1 / P0-1):交互式首次进入未信任目录 → 弹确认;拒绝即退出,
  //    **不装配任何项目侧可执行配置**(hooks/MCP/plugins)。门刻意在下方 TUI 回落
  //    try/catch 之外:runTui 崩溃回落 readline 也已在门内;弹窗自身异常在 trustGate
  //    里降级纯文本 y/N(fail-closed,绝不因异常放行)。--demo / --yes 照常弹
  //    (demo 只换 provider、装配面不减,P0-2;--yes 与 trust 正交,§1.3)。
  //    非交互(-p / 管道 / serve)跳过,对齐 cc `-p`;FORGEAX_SKIP_TRUST=1 为 CI 逃生口。
  const interactive = args.prompt == null && !args.serve && process.stdin.isTTY === true;
  const trusted = await trustGate({
    cwd: process.cwd(),
    interactive,
    wantTui,
    dialog: async (cwd) => (await import('../tui/screens/Trust')).runTrustDialog(cwd),
  });
  if (!trusted) return 1;

  if (wantTui) {
    try {
      const { runTui } = await import('../tui/app');
      return await runTui({ ...args, initialMode }, providerOverride);
    } catch (e) {
      // ink 不可用 / TUI 起不来 → 回落 readline REPL(不阻断交互)。
      process.stderr.write(`[forgeax-cli] TUI 不可用,回落 readline REPL: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // 全量装配(builtin + web/todo/notebook + memory + skill + mcp + plugin + hooks + Task),
  // plugins/hooks 订阅同一 bus(loop 用之),disposers 退出时清理。统一走 buildHostContext
  // (与 TUI driver 同源,§0-A)。
  // H-04:`-c/--continue` = 续接当前目录**最近活跃**会话(非固定 `default`);无会话则回落
  //   新建(undefined = 本次不持久化,不报错)。`--resume/--session <id>` 显式指名仍照旧。
  const sessionId =
    args.sessionId ?? (args.continueSession ? mostRecentSessionId(args.sessionsDir) : undefined);
  let host;
  try {
    host = await buildHostContext(
      {
        model: args.model,
        demo: args.demo,
        memoryDir: args.memoryDir,
        skillDirs: args.skillDirs,
        commandDirs: args.commandDirs,
        mcpConfigPath: args.mcpConfigPath,
        mcpTokenMap: args.mcpTokenMap,
        pluginDirs: args.pluginDirs,
        hooksConfigPath: args.hooksConfigPath,
        searchUrl: args.searchUrl,
        sessionId,
        sessionsDir: args.sessionsDir,
      },
      providerOverride,
    );
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const { context, bus, provider, store, disposers, rules } = host;
  if (sessionId) {
    const file = resolvePath(args.sessionsDir ?? `${process.cwd()}/.forgeax/sessions`, sessionId, 'events.jsonl');
    info(`[forgeax-cli] session "${sessionId}" → ${file}\n`);
  }

  // auto-memory:一个 session 一个实例,跨 REPL 轮保留 surfaced/预算。
  //  extract 走 cache-safe fork(host 层构造 forkRunner:复用本 agent 的 slots/tools/model/provider,
  //  复用父缓存前缀 + 追加提取指令 + 写闸锁 memory 目录)。
  const forkRunner: ForkRunner = (parentMessages, instruction, canUseTool, signal) =>
    runForkedAgent(
      {
        parentMessages,
        systemPromptSlots: context.config.systemPromptSlots,
        leadingSystemText: context.config.leadingSystemText,
        model: args.model,
        tools: context.config.tools,
        instruction,
        canUseTool,
      },
      { provider, toolContext: context.toolContext, signal },
    ).then((r) => r.writtenPaths);
  const autoMemory: AutoMemoryHook | undefined = args.memoryDir
    ? new AutoMemory({
        memoryDir: args.memoryDir,
        sandboxFs: context.toolContext.sandboxFs as NodeSandboxFs,
        provider,
        model: args.model,
        forkRunner,
        // consolidation(cc /dream 等价):文件数到阈值后蒸馏合并,治碎片膨胀。
        consolidateThreshold: 40,
      })
    : undefined;

  // CORE-CTX-005:大结果落盘到 <sessionsDir>/<sid>/tool-results/<id>.txt(best-effort)。
  const persistBaseDir = resolvePath(args.sessionsDir ?? defaultSessionsDir(), sessionId ?? 'default', 'tool-results');
  const persistToolResult = (raw: string, meta: { toolUseId: string }): string | undefined => {
    try {
      mkdirSync(persistBaseDir, { recursive: true });
      const path = resolvePath(persistBaseDir, `${meta.toolUseId}.txt`);
      writeFileSync(path, raw, 'utf8');
      return path;
    } catch {
      return undefined;
    }
  };
  // CORE-CTX-002:配得太小的 FORGEAX_COMPACT_WINDOW 已被忽略回落真实窗口;此处 warn 一次。
  {
    const wo = describeWindowOverride(lookupModelContext(args.model));
    if (wo.rejected) {
      info(
        `[forgeax-cli] FORGEAX_COMPACT_WINDOW=${wo.requested} 低于有效下限 ${wo.floor},已忽略并回落模型真实窗口(避免每轮 blocking_limit 硬停)。\n`,
      );
    }
  }

  const runOpts: RunTurnOpts = {
    autoMemory,
    bus,
    askUser: makeAskUser(!!args.yes),
    thinking: thinkingFromArg(args.thinking),
    store,
    rules,
    persistToolResult,
    mode: initialMode,
    ...(args.outputFormat ? { outputFormat: args.outputFormat } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(host.coordinatorInbox ? { inbox: host.coordinatorInbox } : {}),
  };

  const cleanup = async (): Promise<void> => {
    for (const d of disposers) {
      try {
        await d();
      } catch {
        /* ignore */
      }
    }
  };

  try {
    // 一次性 prompt:显式 -p,或 stdin 是管道/重定向(非 TTY)→ 读其全部内容作单次 prompt
    //   (非 TTY stdin 吸成 prompt)。只有 stdin 是
    //   真 TTY 时才落 readline REPL —— 避免「echo x | forgeax」掉进 readline 读管道的怪行为。
    let oneShot = args.prompt;
    if (oneShot == null && process.stdin.isTTY !== true) {
      const piped = (await readStdin()).trim();
      if (piped) oneShot = piped;
    }
    if (oneShot != null) {
      await runTurn(context, oneShot, write, runOpts);
      if (!jsonMode) write('\n'); // json/stream-json:stdout 保持纯净,不追加尾换行
      return 0;
    }
    // REPL(--no-tui + TTY / TUI 回落 → 原 readline)
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\nforgeax> ' });
    rl.prompt();
    for await (const line of rl) {
      const p = line.trim();
      if (p === '/exit' || p === '/quit') break;
      if (p) {
        await runTurn(context, p, write, runOpts);
        write('\n');
      }
      rl.prompt();
    }
    return 0;
  } finally {
    await cleanup();
  }
}

// 直接运行时执行(node `dist/cli/main.js …` / `src/cli/main.ts …`),被 import 为库时不执行。
// 用 node-portable 的入口脚本路径比对。**不用 `import.meta.main`**:它是 Bun/Node≥24.2 专属,
// 且 bun build 会把它转成引用未定义 `__require` 的 polyfill —— 在 ESM 产物里直接 ReferenceError 崩溃。
const runAsEntry =
  process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (runAsEntry) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
