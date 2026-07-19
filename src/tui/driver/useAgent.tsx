/**
 * Agent driver —— 进程内 embed CoreAgent(直构,不走 runTurn;PRD §0-A)。
 *
 * 数据层:复用 cli/host-context 的全量装配(buildHostContext = assembleCapabilities
 * 路径,含 mcp/plugin/hooks/disposers),**不复用 runTurn**(它把事件 renderEvent
 * 成字符串写 stdout,正是 TUI 要替换的那层)。driver 直接 `new CoreAgent({...})`,
 * 迭代 agent.run,把 AgentEvent 流逐个回调给 React。
 *
 * 关键不变量:
 *   - rules 是 driver 持有的**同一可变对象**({deny,ask,allow}),按引用传给 CoreAgent;
 *     allowAlways 就地 push(绝不重新赋值,§0-B)→ 下一轮派发引擎 ⑦ 即命中。
 *   - setModel 整 context 重建(provider+Task+compaction+window,§0-D),dispose 旧装配。
 *   - dispose await 装配的 disposers(R4)。
 *
 * T0 交付最小可用实现;T2 在本文件硬化(取消收尾 / resume fold / 错误事件)。
 * Boundary(HOST 层):react + 相对 import(含 ../cli/host-context)。
 */
import React, { createContext, useContext } from 'react';
import { CoreAgent } from '../../agent/agent';
import type { AgentContext, AgentEvent } from '../../agent/types';
import type { AskUserFn } from '../../agent/dispatch';
import { findTool } from '../../agent/dispatch';
import type { PermissionRuleSet } from '../../permission/rules';
import { loadAllowRules, saveAllowRules } from '../../permission/persist';
import type { PermissionMode } from '../../permission/engine';
import { CoreEventType } from '../../events/events';
import type { LLMProvider, ProviderMessage } from '../../provider/types';
import { makeProviderCompactSummarize } from '../../context/compaction-llm';
import { makeRehydrateInjection } from '../../context/post-compact-rehydrate';
import { microCompact } from '../../context/micro-compaction';
import { contextWindowForModel } from '../../context/model-window';
import { buildHostContext, type HostContext, type HostContextArgs } from '../../cli/host-context';
import type { PendingTaskNotification } from '../../cli/task-notification';
import { effectiveSkillDirs } from '../../cli/locations';
import { updateUserSettings } from '../../cli/settings';
import type { AgentDriver, UiMessage, PendingRewindView, RewindOutcome, DiffStats, ImageAttachment } from '../contracts';
import { buildUserContent } from '../input/imagePaste';
import { CheckpointManager } from '../../cli/checkpoint-manager';
import { defaultSessionsDir } from '../../cli/resume-fold';
// ── 命令补齐批次(025)A 层能力 + 装配接缝 ──
import { type Usage, EMPTY_USAGE } from '../../provider/types';
import { summarizeUsage, contextStats } from '../../context/usage-stats';
import { inspectMcpServers, type InspectMcpOptions } from '../../capability/mcp/inspect';
import { getPermissionRules } from '../../permission/inspect';
import { listSessions, foldSessionById, readSessionEvents, foldSessionHistory, readSessionRaw } from '../../cli/resume-fold';
import { foldFromStore } from '../../history/llm-fold-adapter';
import { walEventsToUiMessages, relinkMsgIds, checkResumeConsistency } from '../transcript/rehydrate';
import { inspectAgents } from '../../capability/agent/inspect';
import { listMemory } from '../../capability/memory/inspect';
import { listSkills, listPlugins, listHooks } from '../../capability/extensions-inspect';
import { getStatus } from '../../cli/status-aggregate';
import { runDoctor } from '../../cli/doctor';
import { triggerCompact as runManualCompact } from '../../context/manual-compact';
import { runInitProject } from '../../cli/init-project';
import { computeWatermarksFromModel } from '../../context/watermarks';
import { estimateTokens } from '../../context/deterministic-compact';
import { lookupModelContext } from '../../context/model-context-table';
import { makeStdioMcpFactory } from '../../cli/mcp-stdio';
import { makeEnvTokenProvider } from '../../cli/mcp-token';
import { resolveSandboxStatus, sandboxRequested } from '../../cli/sandbox-terminal';
import { builtinSubagents } from '../../capability/agent/builtin/index';
import { loadAgentDefs } from '../../capability/agent/index';
import type { SandboxFs, AskQuestionFn } from '../../inject/types';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { describeWindowOverride } from '../../context/watermarks';
import { randomUUID } from 'node:crypto';

/** 上下文窗口占用口径(对齐 cc calculateContextPercentages):input + cacheCreation + cacheRead,
 *  不含 output(output 不在当前 prompt 里,要到下一轮作历史进 input 时才计)。 */
function ctxTokensOf(u: Partial<Usage>): number {
  return (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
}

/** driver 构造选项(来自 CLI args / TUI 入口)。 */
export interface DriverOptions extends HostContextArgs {
  /** 测试 / --demo 的 provider override。 */
  providerOverride?: LLMProvider;
  /** 初始权限模式(--permission-mode / settings.permissions.defaultMode 解析结果;缺省 default)。
   *  bypass 值的 root/killswitch 护栏由 CLI 启动 boundary 把关,这里只消费已解析终值。 */
  initialMode?: PermissionMode;
}

/**
 * 创建一个 AgentDriver(命令式,非 React;App 在 useMemo 里持有一个实例)。
 * 先 buildHostContext 出初始 context,再按需重建。
 */
export function createAgentDriver(opts: DriverOptions, initial: HostContext): AgentDriver {
  // 进程级可变 rules(§0-B):同一引用传给每一个 CoreAgent,allowAlways 就地 push。
  //   楔子1 · 046:从 host 载出的 settings.permissions 规则**播种**这份可变集(deny/ask/allow
  //   立即生效);allow 桶再叠加项目文件 <cwd>/.forgeax/permissions.json 读回的「总是允许」
  //   (跨会话记住),之后 allowAlways 仍就地 push 到同一引用。
  const rules: PermissionRuleSet = {
    deny: [...(initial.rules?.deny ?? [])],
    ask: [...(initial.rules?.ask ?? [])],
    allow: [...(initial.rules?.allow ?? []), ...loadAllowRules(process.cwd())],
  };
  let mode: PermissionMode = opts.initialMode ?? 'default';
  let askUser: AskUserFn | undefined;
  // 008 结构化提问:host 注入的回调。区别于 askUser(布尔闸),AskUserQuestion 工具经
  //   toolContext.askQuestion 取用(agent dispatch 读 this.o.context.toolContext)。
  let askQuestion: AskQuestionFn | undefined;
  // T4.5:Repl 注入的后台任务活动回调(完成入队携完成项 / shell 起停不带参;idle 判定在 Repl 侧)。
  let taskActivity: ((completed?: PendingTaskNotification) => void) | undefined;

  // 把「稳定委托」挂到 toolContext.askQuestion:始终读 driver 持有的可变 askQuestion 变量,
  //   故 setAskQuestion 在 render 时晚到也无碍;setModel 重建 toolContext 后须重挂(见下)。
  //   未注入(变量为空)时 resolve([]) —— 工具据空 answers 视作未取到选择,不断流。
  const installAskQuestion = (h: HostContext): void => {
    (h.context.toolContext as { askQuestion?: AskQuestionFn }).askQuestion = (questions, signal) =>
      askQuestion ? askQuestion(questions, signal) : Promise.resolve([]);
  };

  // T4.5:同一「稳定委托」套路挂活动接缝——hub enqueue/shell 起停时调 taskActivity
  //   (晚注入/未注入都无碍);setModel 重建出**新 hub** 后须对新 hub 重挂(旧 hub 随旧装配废弃)。
  const installTaskWake = (h: HostContext): void => {
    h.taskNotifications.setActivityListener((completed) => taskActivity?.(completed));
  };

  let host = initial;
  installAskQuestion(host);
  installTaskWake(host);
  let model = opts.model;
  // 会话身份(sessionId):可变——/clear 视作「开一条新会话」时换新 id(F1)。getter / getStatus /
  //   setModel 重建都读这份,故换新后全链一致。CheckpointManager 构造时快照旧 id(见下),不随
  //   /clear 重键:旧 checkpoints 已随历史清空而失效,重建 manager 反而丢进程内索引,得不偿失。
  let sessionId = opts.sessionId;
  let agent: CoreAgent | null = null;
  // setModel 会异步清掉 `agent` 以便下一轮用新 context 重建；在飞轮必须另持引用，
  // 否则重建完成后 abort 会错过仍在旧 provider 上运行的真实 agent。
  let inFlightAgent: CoreAgent | null = null;
  /** 回退点 reseed:下一轮 driveTurn 用这份历史播种一次,然后清空。 */
  let pendingHistory: ProviderMessage[] | null = null;

  // ── 回退点状态机:文件侧 manager(落 <cwd>/.forgeax/checkpoints + 会话 checkpoints.jsonl)──
  const checkpoints = new CheckpointManager({
    cwd: process.cwd(),
    sessionId: opts.sessionId ?? 'default',
    sessionsDir: opts.sessionsDir ?? defaultSessionsDir(),
  });
  /** 当前挂起态的「对话侧」快照(messages 由 Repl 持有传入,convo 由 driver 持有)。
   *  boundaryId 串联文件侧 manager.pending();null = 无挂起。 */
  let activeBoundary: { boundaryId: string; preMessages: UiMessage[]; preConvo: ProviderMessage[]; hasCode: boolean } | null = null;
  // 启动/重启后从磁盘恢复挂起态:loadIndex 已重建 pendingRec,但 activeBoundary 是纯内存态。
  // 对话侧 pre 快照(preMessages/preConvo)无法从磁盘恢复,置空;文件侧 Redo 仍可用。
  { const _lp = checkpoints.pending(); if (_lp) activeBoundary = { boundaryId: _lp.boundaryId, preMessages: [], preConvo: [], hasCode: _lp.preManifestId !== null }; }
  // ── 会话续接(025):driver 维护对话历史并每轮 thread 给 CoreAgent(它本身不跨 run 持有)。
  //    文本级重建(user 文本 + assistant 文本轮;工具轮从略,与 Repl.toHistory / rewind 同口径)。
  let convo: ProviderMessage[] = [];
  // ── 累计 usage(025 /cost):从 stream assistant 事件逐项累加,跨 setModel 不清零。供 getUsage。
  let usageAcc: Usage = EMPTY_USAGE;
  // ── 当前上下文窗口占用(状态栏 + /context):最近一次请求的 input+cacheCreation+cacheRead
  //   (ctxTokensOf),**非累计**——每次 message_start 刷新成新请求的 prompt 大小(它本身已含全部
  //   历史,跨轮累加会把同段历史数 N 遍)。assistant 收尾按 final usage 校准。这是「窗口满了多少」,
  //   不是计费里程表(后者归 /cost / usageAcc)。
  let ctxPromptTokens = 0;
  // Anthropic 流不发增量 output usage。为让状态栏数字在 output 生成期间也平滑涨,按已流出的
  //   文本/思考/工具入参字符数 ~/4 估算在飞 output,叠加到 ctxPromptTokens 上;message_start 与
  //   assistant 收尾各重置一次,故静默时只剩纯 input+cache(对齐 cc 状态栏的「上下文占用」)。
  let liveOutChars = 0;

  // ── CORE-CTX-005 大结果落盘:截断超限 tool 结果时把全量写 <sessionsDir>/<sid>/tool-results/<id>.txt,
  //   返回路径供 marker 追加「full result at <path>」,模型可 read 回捞中段。best-effort,失败返回 undefined。
  const toolResultsDir = (): string =>
    resolvePath(opts.sessionsDir ?? defaultSessionsDir(), sessionId ?? 'default', 'tool-results');
  const persistToolResult = (raw: string, meta: { toolUseId: string }): string | undefined => {
    try {
      const dir = toolResultsDir();
      mkdirSync(dir, { recursive: true });
      const path = resolvePath(dir, `${meta.toolUseId}.txt`);
      writeFileSync(path, raw, 'utf8');
      return path;
    } catch {
      return undefined; // 落盘失败 → 退回旧行为(截断无回读路径),不崩。
    }
  };

  // ── CORE-CTX-002 诊断:FORGEAX_COMPACT_WINDOW 配得太小(会致每轮静默硬停)已被 watermarks
  //   忽略回落真实窗口;此处装配期 warn 一次,让用户知道配置未生效。
  {
    const wo = describeWindowOverride(lookupModelContext(model));
    if (wo.rejected) {
      process.stderr.write(
        `[forgeax-core] FORGEAX_COMPACT_WINDOW=${wo.requested} 低于有效下限 ${wo.floor}(reserve+基础提示+blocking),` +
          `已忽略并回落模型真实窗口(避免每轮 blocking_limit 硬停)。\n`,
      );
    }
  }

  function makeAgent(context: AgentContext, bus: HostContext['bus']): CoreAgent {
    return new CoreAgent({
      context,
      bus,
      globalCacheEnabled: true,
      // CLI/TUI 独立形态自管权限:开 core 内置受保护路径检查,保护本机 .git/.forgeax/shell-rc。
      enableSafetyCheck: true,
      // rules / mode / askUser 经 CoreAgentOptions 喂(派发时实时读,§0-A)。
      rules,
      mode,
      askUser: (perm, use) => (askUser ? askUser(perm, use) : Promise.resolve(false)),
      // team(FORGEAX_TEAM):挂 coordinator inbox 收 peer 的 SendMessage(经既有 inbox 接缝;
      //   非 team → undefined,零变化)。每轮顶部 drain（agent.ts:758），peer 回报作合成 user 轮入上下文。
      ...(host.coordinatorInbox ? { inbox: host.coordinatorInbox } : {}),
      // ★ ISSUE-1:统一走 Compaction V2(替换 legacy makeProviderCompaction)。
      //   D-01:压后重挂最近读文件(recentReadPaths 由 loop 自取内部 read-tracker)。
      compactionV2: {
        summarize: makeProviderCompactSummarize(context.provider, context.config.model),
        rehydrate: makeRehydrateInjection(context.toolContext),
      },
      microCompact: (msgs: ProviderMessage[]) => microCompact(msgs, { now: Date.now() }),
      // CORE-CTX-005:大结果落盘钩子(host/sessionDir 领地)。
      persistToolResult,
      contextWindow: contextWindowForModel(context.config.model),
    });
  }

  /** 构造 MCP 巡检入参(无配置 → undefined,命令据此给「未配置」反馈)。与 host-context 同源。 */
  function mcpOpts(): InspectMcpOptions | undefined {
    if (!opts.mcpConfigPath) return undefined;
    return {
      config: JSON.parse(readFileSync(opts.mcpConfigPath, 'utf8')),
      env: process.env,
      deps: { stdioFactory: makeStdioMcpFactory(), tokenProvider: makeEnvTokenProvider(opts.mcpTokenMap) },
    };
  }

  /** 读 hooks 配置(顶层即 settings 或 `{hooks:{...}}` 包裹;与 host-context.readHooksSettings 同口径)。 */
  function readHooksSettings(): Record<string, unknown> | undefined {
    if (!opts.hooksConfigPath) return undefined;
    const j = JSON.parse(readFileSync(opts.hooksConfigPath, 'utf8')) as { hooks?: Record<string, unknown> } & Record<string, unknown>;
    return (j.hooks ?? j) as Record<string, unknown>;
  }

  const driver: AgentDriver = {
    get model() {
      return model;
    },

    get sessionId() {
      return sessionId;
    },

    async driveTurn(prompt: string, onEvent: (e: AgentEvent) => void, images?: ImageAttachment[], msgId?: string): Promise<void> {
      // 多模态:有图 → payload/convo 走 content block 数组([text?, image...]);无图 → 纯字符串(零变化)。
      const userContent = buildUserContent(prompt, images);
      // 长活复用:同一进程内复用一个 agent。CoreAgent **不跨 run 持有历史**(每次 run 从
      //   input.history 重建),故续接由 driver 维护的 convo 每轮 thread 进去(§T2 硬化)。
      //   rules 引用不变是前提(§0-B),故复用安全。
      if (!agent) agent = makeAgent(host.context, host.bus);
      const runAgent = agent;
      inFlightAgent = runAgent;
      // 回退点 reseed 优先于常规 convo:rewind/resume 选中后用重建历史替换本轮历史并对齐 convo。
      // ⚠️ seed = **本轮之前**的历史快照(slice,不能引用 convo 本体——下面要往 convo 追加本轮)。
      //   CoreAgent.run 把 messages 拼成 [..seed(=input.history), {user: 本轮 prompt}],故 seed 不含本轮。
      if (pendingHistory) convo = pendingHistory.slice();
      pendingHistory = null;
      const seed = convo.slice();
      let assistantText = '';
      try {
        for await (const ev of runAgent.run({
          input: { type: 'user', payload: userContent, ts: 0 },
          ...(seed.length ? { history: seed } : {}),
          // H-02:把回退锚点 msgId 透传进 loop → 写入 WAL 的 user_prompt.submit,
          //   使 /resume 重建历史时能还原 msgId 供文件回退。
          ...(msgId ? { msgId } : {}),
        })) {
        // 累计 usage:stream 透传的 provider assistant 事件带真 usage(types.ts:115)。
        //   ⚠️ 用「逐项相加」而非 mergeUsage——后者语义是同一消息内 input/cache **覆盖**取最新
        //   (防 message_delta 的 0 冲掉真值),用于轮内合并;跨轮/跨请求的计费总额须累加,
        //   每个 provider 请求(每轮、每个工具循环迭代)的 input 都各自计费。
        if (ev.type === 'stream') {
          const sev = ev.event as {
            type?: string;
            usage?: Partial<Usage>;
            delta?: { text?: string; thinking?: string; partial_json?: string };
          };
          // 上下文占用随请求刷新(对齐 cc),计费累计随 assistant 收尾累加(/cost):
          //   - message_start:本请求的 prompt 大小已知(usage 带 input/cache),刷新 ctxPromptTokens
          //     (非累计,取代上一请求值);重置在飞 output 估算。
          //   - content_block_delta:累计已流出字符,供 getContextTokens 的 chars/4 估算平滑涨。
          //   - assistant:本消息收尾——usageAcc 逐项累加(计费);ctxPromptTokens 按 final usage 校准;
          //     重置 output 估算,故静默时状态栏 == 纯 input+cache(cc 的上下文占用口径)。
          if (sev?.type === 'message_start') {
            if (sev.usage) ctxPromptTokens = ctxTokensOf(sev.usage);
            liveOutChars = 0;
          } else if (sev?.type === 'content_block_delta') {
            const d = sev.delta;
            if (d) liveOutChars += (d.text ?? d.thinking ?? d.partial_json ?? '').length;
          } else if (sev?.type === 'assistant' && sev.usage) {
            const u = sev.usage;
            usageAcc = {
              inputTokens: usageAcc.inputTokens + (u.inputTokens ?? 0),
              outputTokens: usageAcc.outputTokens + (u.outputTokens ?? 0),
              cacheCreationInputTokens: usageAcc.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
              cacheReadInputTokens: usageAcc.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
            };
            ctxPromptTokens = ctxTokensOf(u);
            liveOutChars = 0;
          }
        } else if (ev.type === 'assistant') {
          // 收集 assistant 文本轮,turn 结束后并入 convo(供下一轮续接)。
          const content = (ev.message?.payload as { content?: Array<{ type: string; text?: string }> })?.content;
          if (Array.isArray(content)) {
            assistantText += content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('');
          }
        }
          onEvent(ev);
        }
        // turn 收尾:把本轮 user + assistant 文本并入 convo,供下一轮续接(本轮 user 此刻才入,
        //   避免与上面 input.payload 重复)。
        convo.push({ role: 'user', content: userContent });
        if (assistantText) convo.push({ role: 'assistant', content: assistantText });
        // ⚠️ 不在此 await drainAutoMemory:答案流式结束 = turn 在用户眼里就完成了,driveTurn
        //   立即 resolve → 上层 busy 立刻翻 false,不让后台记忆抽取(真模型下又一次数秒 LLM
        //   调用)把 UI 锁在 busy、再延迟触发一次重绘(矮终端/CJK 下易残影)。抽取已由
        //   agent.run 内 fire-and-forget 启动并在跑;落盘由 dispose() 退出前统一 await。
      } finally {
        // 权限模式回读:ExitPlanMode 在轮内经人类闸恢复 prePlanMode 时只改活 agent,
        //   driver 的 mode 若不回读会漂移停在 plan(/status、指示条、setModel 重建全跟着错)。
        //   从本轮捕获的 runAgent 读(异步 setModel 重建可能已把可变 agent 置空/换新)。
        mode = runAgent.getMode();
        if (inFlightAgent === runAgent) inFlightAgent = null;
      }
    },

    abort(reason?: string): void {
      (inFlightAgent ?? agent)?.abort(reason);
    },

    toolMeta(name: string): { canonical: string; displayName: string; isReadOnly: boolean; isMcp: boolean } {
      // 在 driver 持有的已装配 tools 上用别名感知匹配解析(host 在 setModel 后重建,
      //   故每次惰性读 host.context.config.tools,不快照)。命中 → canonical=tool.name;
      //   未命中(MCP/plugin/未知)→ 原名回 + isMcp 据 `mcp__` 前缀启发(地基方案 §3梁① / R2)。
      const tool = findTool(host.context.config.tools, name);
      if (!tool) {
        return { canonical: name, displayName: name, isReadOnly: false, isMcp: name.startsWith('mcp__') };
      }
      // displayName:renderToolUseMessage 需 input(toolMeta 仅有名)→ 退而用真名;
      //   isReadOnly 是 (input)=>bool 谓词,无 input 时以空对象探测(fail→false,纯展示元信息)。
      let isReadOnly = false;
      try {
        isReadOnly = tool.isReadOnly({} as never);
      } catch {
        isReadOnly = false;
      }
      return {
        canonical: tool.name,
        displayName: tool.name,
        isReadOnly,
        isMcp: tool.isMcp ?? tool.name.startsWith('mcp__'),
      };
    },

    setModel(id: string): void {
      // 整 context 重建(§0-D):新 provider/Task/compaction/window。旧装配 dispose。
      //   注:同步签名,实际重建异步发生;下一轮 driveTurn 用新 agent。
      const prev = host;
      model = id;
      // 落盘持久化:写 .forgeax/settings.json 的 model 键,下次启动读回。
      //   best-effort、绝不抛——失败也不影响本次切换。
      updateUserSettings({ model: id });
      void buildHostContext({ ...toHostArgs(opts, id, sessionId) }, opts.providerOverride).then(async (next) => {
        host = next;
        installAskQuestion(host); // 新 toolContext 须重挂提问接缝(否则切模型后 AskUserQuestion 失联)
        installTaskWake(host); // T4.5:新 hub 须重挂唤醒接缝(否则切模型后后台完成不再唤醒)
        agent = null; // 下一轮 driveTurn 用新 context 重建
        // dispose 旧装配的子进程(mcp/plugin/hooks)。
        for (const d of prev.disposers) {
          try {
            await d();
          } catch {
            /* ignore */
          }
        }
      });
    },

    setAskUser(fn: AskUserFn): void {
      askUser = fn;
    },

    setAskQuestion(fn: AskQuestionFn): void {
      askQuestion = fn;
    },

    setTaskNotificationActivity(fn: ((completed?: PendingTaskNotification) => void) | undefined): void {
      taskActivity = fn;
    },

    drainTaskNotifications() {
      // 惰性读当前 host(setModel 重建后自动指向新 hub),与 toolMeta 读 host.context 同口径。
      return host.taskNotifications.drain();
    },

    backgroundTaskCounts() {
      return { shells: host.taskNotifications.runningShells, agents: host.taskNotifications.runningAgents };
    },

    allowAlways(toolName: string): void {
      // 修①别名 bug:传入的可能是模型发来的别名(如 `Bash`/`Write`),但引擎 ⑦ 按
      //   canonical 真名(`bash`/`write_file`)匹配规则,且 matchRule 不吃别名。故这里
      //   先经 findTool 解析回真名再存,否则规则永远命不中 → 每次仍弹卡。
      const tool = findTool(host.context.config.tools, toolName);
      const canonical = tool?.name ?? toolName;
      // 就地 push(§0-B):同一 rules 引用,下一次派发引擎 ⑦ 判 allow。整工具规则
      //   (content===undefined)匹配该工具全部输入。
      rules.allow.push({ toolName: canonical, behavior: 'allow', source: 'tui-allow-always' });
      // 修②持久化:落项目文件 <cwd>/.forgeax/permissions.json,重启/新会话读回。
      //   只落用户来源的授予(tui「总是允许」+ 上次读回的项目规则),强制 persist.ts
      //   头注声明的「仅用户授予」契约——即便将来有内置/策略规则混进 rules.allow 也不外泄。
      saveAllowRules(
        process.cwd(),
        rules.allow.filter((r) => r.source === 'tui-allow-always' || r.source === 'project-permissions'),
      );
    },

    setMode(m: PermissionMode): void {
      mode = m;
      // 已在飞的 agent 也即时切(下一轮 dispatch 读 currentMode);新 agent 经 makeAgent 喂初值。
      agent?.setMode(m);
    },

    getMode(): PermissionMode {
      // 有活 agent 时以它为准(执行语义真相;吸收 ExitPlanMode 轮内恢复),否则回 driver 保存值。
      return agent?.getMode() ?? mode;
    },

    // ── 命令补齐批次(025)能力实现 ──────────────────────────────────────────────
    getUsage() {
      // 会话累计计费(/cost):纯 usageAcc(逐 assistant 收尾累加,各 token 类型分项,各按单价计)。
      return summarizeUsage(usageAcc, model);
    },

    getContextStats() {
      // 当前上下文占用(/context):最近一次请求的 input+cacheCreation+cacheRead;无则 convo 估算兜底。
      return contextStats(ctxPromptTokens > 0 ? ctxPromptTokens : convo, model);
    },

    getContextTokens() {
      // 状态栏数字:当前上下文窗口占用 + 在飞 output 估算(chars/4)。静默时估算为 0 → 纯 input+cache,
      //   与 getContextStats / cc 状态栏同口径;生成期间叠加估算让数字平滑涨(随流实时)。
      return ctxPromptTokens + Math.ceil(liveOutChars / 4);
    },

    async listMcp() {
      const o = mcpOpts();
      if (!o) return { servers: [], configErrors: [] };
      return inspectMcpServers(o);
    },

    getPermissionRules() {
      return getPermissionRules(rules, agent?.getMode() ?? mode);
    },

    listSessions() {
      return listSessions(opts.sessionsDir);
    },

    async resume(id: string): Promise<boolean> {
      const hist = await foldSessionById(id, opts.sessionsDir);
      if (!hist || !hist.length) return false;
      convo = hist.slice();
      agent = null;
      pendingHistory = hist.slice();
      return true;
    },

    async resumeSession(id: string): Promise<UiMessage[] | null> {
      // 单次读全量 WAL → 双投影:① foldFromStore 重建 LLM 历史(reseed 下一轮,与 resume 同口径);
      //   ② walEventsToUiMessages 重建可渲染 transcript(供 Repl 回灌、替换当前会话)。
      const events = await readSessionEvents(id, opts.sessionsDir);
      if (!events.length) return null; // 无此会话 / 空 WAL
      const hist = foldFromStore(events);
      if (hist.length) {
        convo = hist.slice();
        pendingHistory = hist.slice();
        agent = null; // 下一轮 driveTurn 用恢复历史 reseed
      }
      // H-02:新 WAL 的 user 轮已带 msgId;旧 WAL 无 → 用 checkpoints.jsonl 按 ordinal fallback
      //   回填(数量不一致则保守放弃),使历史轮的文件回退在 RewindPanel 里可用(hasCode)。
      const uiMsgs = relinkMsgIds(walEventsToUiMessages(events), checkpoints.list());
      // T1 一致性探针:盘上原始 WAL 的对话记录行数应 == 成功解析出的对话事件数;不一致 =
      //   有对话行被 loader 静默丢弃(WAL 截断/损坏)→ 重放历史不全 → warn(低成本回归护栏,
      //   不阻断续接,graceful)。console.warn 走 stderr,由 stderr-guard 缓冲、还屏后 flush,不污染 TUI 帧。
      const probe = checkResumeConsistency(readSessionRaw(id, opts.sessionsDir), events);
      if (!probe.ok) {
        console.warn(
          `[forgeax-core] resume 一致性探针:会话 ${id} 盘上对话记录行数=${probe.rawCount},` +
            `成功解析=${probe.parsedCount}(不一致 → WAL 可能被截断/损坏,历史回放不完整)。`,
        );
      }
      return uiMsgs;
    },

    listAgents() {
      const disk = loadAgentDefs([resolvePath(process.cwd(), '.forgeax/agents')]);
      return inspectAgents({ builtins: builtinSubagents, disk, allTools: host.context.config.tools });
    },

    listMemory() {
      const fs = host.context.toolContext.sandboxFs as SandboxFs;
      const dir = opts.memoryDir ?? resolvePath(process.cwd(), '.forgeax/memory');
      return listMemory(fs, dir);
    },

    listSkills() {
      // 用生效目录(给了 --skills 只用 flag,否则自动发现项目级+用户级),与装配口径一致。
      return listSkills(effectiveSkillDirs(opts.skillDirs));
    },

    listPlugins() {
      return listPlugins((opts.pluginDirs ?? []).map((d) => ({ source: 'session' as const, dir: d })));
    },

    listHooks() {
      return listHooks({ settings: readHooksSettings() as never });
    },

    getStatus() {
      return getStatus({
        model,
        cwd: String(host.context.toolContext.cwd ?? process.cwd()),
        sessionId,
        permissionMode: agent?.getMode() ?? mode,
        usage: usageAcc,
      });
    },

    async runDoctor() {
      // E-03:沙箱状态(host 侧解析)进 doctor —— /doctor 可见当前沙箱是否生效/可用。
      const sandbox = resolveSandboxStatus(sandboxRequested(opts.sandbox));
      return runDoctor({ provider: { provider: host.provider, model }, mcp: mcpOpts(), sandbox });
    },

    async triggerCompact(instructions?: string): Promise<{ compacted: boolean; usedLLM: boolean }> {
      // `/compact <侧重指令>` 透传:instructions 经 makeProviderCompactSummarize →
      // getCompactPrompt(scenario, instructions) 追加进压缩 prompt(不再静默丢弃)。
      //
      // 04.4(manual 压缩进 WAL):此前只 splice driver 内存态 convo、不发任何事件——
      // 违反「事件流是真相」(§6.1),/resume 的 fold 会丢这次压缩、回放出未压缩全史。
      // 现改为:在 **WAL fold 出的正史**(含工具轮,与 resume 同坐标系)上压,并把
      // PreCompact(manual)/CompactionApplied/PostCompact 发进 host.bus → connectStore
      // 落 events.jsonl,与 loop 自动压同口径(coveredFrom/coveredTo = 会话消息下标,
      // foldFromStore 会改写成 byEventId)。fold 不可用(store 缺/读失败)→ 回退旧行为:
      // 压 convo 但**不写 WAL**——convo 是无工具轮的文本级重建,坐标系不对齐,写了反而毒化 resume。
      const folded = await safeFold(host.store);
      const walBacked = !!folded && folded.length > 0;
      const history = walBacked ? folded : convo;
      if (!history.length) return { compacted: false, usedLLM: false };
      const busEv = (type: string, payload: unknown): void => {
        // WAL/hook 是加固,发事件异常绝不阻断压缩本身(与 rewind 的 fail-soft 口径一致)。
        try {
          host.bus.publish({ type, payload, ts: Date.now(), source: 'tui-compact' });
        } catch {
          /* ignore */
        }
      };
      try {
        const marks = computeWatermarksFromModel(lookupModelContext(model));
        const summarize = makeProviderCompactSummarize(host.provider, model, instructions);
        // PreCompact(manual,可阻断):对齐 loop 的 hook 语义(E-I5)——用户配置的
        //   PreCompact hook 对 /compact 同样生效。publish 异常 fail-soft(不阻断)。
        let blocked = false;
        try {
          const pre = host.bus.publish({
            type: CoreEventType.PreCompact,
            payload: { trigger: 'manual', tokenCount: estimateTokens(history) },
            ts: Date.now(),
            source: 'tui-compact',
          }) as { blocked?: boolean };
          blocked = pre.blocked === true;
        } catch {
          /* ignore */
        }
        if (blocked) {
          busEv(CoreEventType.CompactionSkipped, { reason: 'hook-blocked', trigger: 'manual' });
          return { compacted: false, usedLLM: false };
        }
        const res = await runManualCompact({ history, marks, summarize, now: Date.now() });
        const count = res.coveredTo - res.coveredFrom + 1;
        if (count > 0) {
          convo = [...history.slice(0, res.coveredFrom), res.replacement, ...history.slice(res.coveredTo + 1)];
          agent = null; // 下一轮用压缩后历史 reseed
          pendingHistory = convo.slice();
          if (walBacked) {
            busEv(CoreEventType.CompactionApplied, {
              coveredFrom: res.coveredFrom,
              coveredTo: res.coveredTo,
              replacement: res.replacement,
            });
            busEv(CoreEventType.PostCompact, {
              coveredFrom: res.coveredFrom,
              coveredTo: res.coveredTo,
              usedLLM: res.usedLLM,
            });
          }
        }
        return { compacted: count > 0, usedLLM: res.usedLLM };
      } catch (e) {
        // 历史不足以压缩(管线 throw "Not enough messages")→ 视作未压缩(skipped);
        // 其它异常(summarize 失败等)→ CompactionFailed。均不冒泡断 /compact 命令。
        const msg = e instanceof Error ? e.message : String(e);
        if (/not enough messages/i.test(msg)) {
          busEv(CoreEventType.CompactionSkipped, { reason: 'nothing-to-compact', trigger: 'manual' });
        } else {
          busEv(CoreEventType.CompactionFailed, { error: msg, trigger: 'manual' });
        }
        return { compacted: false, usedLLM: false };
      }
    },

    async runInit(force?: boolean) {
      // F3:/init 走 LLM 子流程(runInitProject → runSubagent),离线 / 代理挂起 / 模型错误时
      //   过去要么假成功(终态非 completed 也照报「已生成」)、要么卡死 UI。这里加两道兜底:
      //   ① 超时闸(AbortController + Promise.race)——超时即中断子流程并回 timeout,UI 绝不卡死;
      //   ② 终态/异常判定——子流程抛错或终态非 completed → 回 error(带原因),命令层降级提示。
      // 多轮扫盘可能耗时一两分钟;仅用于兜底真「挂起」,不误伤正常跑。可经 FORGEAX_INIT_TIMEOUT_MS
      //   覆盖(ops 逃生阀 + 测试注入短时限)。
      const envTimeout = Number(process.env.FORGEAX_INIT_TIMEOUT_MS);
      const INIT_TIMEOUT_MS = envTimeout > 0 ? envTimeout : 120_000;
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolveTimeout) => {
        timer = setTimeout(() => {
          try {
            ac.abort('init-timeout');
          } catch {
            /* ignore */
          }
          resolveTimeout('timeout');
        }, INIT_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.(); // 不因该定时器拖住进程退出
      });
      try {
        const initP = runInitProject({
          provider: host.provider,
          model,
          tools: host.context.config.tools,
          toolContext: host.context.toolContext,
          force,
          signal: ac.signal,
        });
        initP.catch(() => {}); // race 输方(超时先返)不产生 unhandledRejection;赢方仍由下面 await 观测
        const res = await Promise.race([initP, timeout]);
        if (res === 'timeout') return { ok: false as const, reason: 'timeout' as const };
        // 子流程跑完但终态非 completed(model_error / max_turns 等)= 未真正生成 → 降级。
        if (res.subagent.terminalReason !== 'completed') {
          return { ok: false as const, reason: 'error' as const, detail: res.subagent.terminalReason };
        }
        return { ok: true as const, ...res };
      } catch (err) {
        return { ok: false as const, reason: 'error' as const, detail: err instanceof Error ? err.message : String(err) };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    rewindHistory(history: ProviderMessage[]): void {
      // 重置 agent(清掉 stateful 内部历史)+ 暂存重建历史;下一轮 driveTurn 播种一次。
      agent = null;
      pendingHistory = history.length ? history : null;
    },

    clearHistory(): void {
      // /clear:把 driver 持有的 LLM 历史真正清空——convo 是下一轮 driveTurn 的 seed 源,
      //   不清它则 session.clear() 只抹了显示、provider 仍收到全部旧历史(bug 根因)。
      //   对齐 resume/rewind 的 reseed 套路:清 convo + 撤挂起 + 重置 agent。
      convo = [];
      pendingHistory = null;
      agent = null;
      // 上下文占用归零(/context + 状态栏据此显示空窗口)。
      ctxPromptTokens = 0;
      liveOutChars = 0;
      // ── F1:/clear 语义 = 「开一条新会话」(对齐 cc regenerateSessionId + executeSessionEndHooks('clear'))──
      //   ① 先对**旧**会话发 SessionEnd(reason='clear'):经 host.bus 同步跑用户配置的 SessionEnd hook,
      //      与 cc 一致(agent 每轮收尾也发 SessionEnd,这里补上「/clear 关旧会话」这一路)。fail-soft:
      //      坏 hook 不该阻断 /clear。
      const endingSession = sessionId ?? 'default';
      try {
        host.bus.publish({
          type: CoreEventType.SessionEnd,
          payload: { sessionId: endingSession, reason: 'clear' },
          ts: 0,
          source: 'tui-clear',
        });
      } catch {
        /* ignore：hook 执行异常不冒泡,/clear 必须成功 */
      }
      //   ② 换新 sessionId(getter / getStatus / 后续 setModel 重建即反映新身份)。
      sessionId = randomUUID();
      //   ③ 清累计计费 usageAcc(视作新会话,成本归零;连带解 D6——/clear 不再保留旧成本)。
      usageAcc = EMPTY_USAGE;
    },

    // ── 回退点 · 文件 + 对话双回退状态机 ──
    checkpointTurn(preferredMsgId?: string): string | null {
      // Repl 会先生成锚点并把 user 条目交给 Ink,让终端完成一帧后才带同一 id 回来拍快照。
      // 无 preferredMsgId 的直接调用(测试/其它 host)保持旧的「生成 + 拍摄」原子语义。
      const msgId = preferredMsgId ?? randomUUID();
      try {
        checkpoints.snapshotForMessage(msgId); // 内部 fail-soft,不抛
      } catch {
        return null;
      }
      return msgId;
    },

    listCheckpoints() {
      return checkpoints.list();
    },

    pendingRewind(): PendingRewindView | null {
      if (!activeBoundary) return null;
      const fp = checkpoints.pending();
      return {
        boundaryId: activeBoundary.boundaryId,
        keptDirty: fp?.keptDirty ?? [],
        hasOverwrite: !!fp?.overwrite,
        hasCode: activeBoundary.hasCode,
      };
    },

    previewRewind(msgId: string): DiffStats | null {
      const r = checkpoints.preview(msgId);
      return 'error' in r ? null : r;
    },

    async rewind(input): Promise<RewindOutcome> {
      // 回退前先打断在飞轮(对齐 cc),给事件一拍 flush。
      try {
        (inFlightAgent ?? agent)?.abort('rewind');
      } catch {
        /* ignore */
      }
      let filesChanged: string[] = [];
      let keptDirty: string[] = [];
      let boundaryId: string = randomUUID();
      // 文件侧:仅当该锚点有快照。
      if (input.hasCode) {
        const r = await checkpoints.rewind(input.msgId);
        if ('error' in r) return { error: r.error };
        filesChanged = r.filesChanged;
        keptDirty = r.keptDirty;
        boundaryId = r.boundaryId;
      }
      // 对话侧:存 pre 快照(messages 由 Repl 传入,convo driver 持有)→ reseed 到目标。
      activeBoundary = {
        boundaryId,
        preMessages: input.currentMessages.slice(),
        preConvo: convo.slice(),
        hasCode: input.hasCode,
      };
      agent = null;
      // H-01:先向 WAL append 一条 append-only rewind.applied(遮蔽被回退轮次)。经 host.bus →
      //   connectStore 落 events.jsonl(sessionId 恒有 → store 恒连),故 /resume 与 --resume 的
      //   fold 都排除这些轮次。rewindId 复用 boundaryId,cancel/Redo 时按它写 revoke。fail-soft:
      //   发事件异常绝不阻断回退本身(对话/文件回退已生效)。
      try {
        host.bus.publish({
          type: CoreEventType.RewindApplied,
          payload: { rewindId: boundaryId, keepUserTurns: input.keepUserTurns },
          ts: Date.now(),
          source: 'tui-rewind',
        });
      } catch {
        /* ignore:WAL 遮蔽是加固,失败不该冒泡断回退 */
      }
      // H-03:reseed 历史复用**与 resume 同一条 fold 路径**(foldSessionHistory→foldFromStore),
      //   吃上面刚写的 rewind.applied 遮蔽 → 产出「保留前缀」的**完整含工具轮** ProviderMessage[]
      //   (不再走 Repl.toHistory 的有损文本重建)。一举消灭双实现(SSOT)。fail-soft:读 store
      //   失败 → 空历史(下一轮从该点续,不误链)。多模态:把保留 user 轮的 images 覆盖回。
      const folded = (await safeFold(host.store)) ?? [];
      // reattachImages 按序只消费前 keepUserTurns 个 user 轮(fold 恰好 keep 个),传全量安全。
      const reseed = reattachImages(folded, input.currentMessages);
      convo = reseed.slice();
      pendingHistory = reseed.length ? reseed.slice() : null;
      return { boundaryId, filesChanged, keptDirty };
    },

    async cancelRewind() {
      if (!activeBoundary) return { error: 'no pending rewind' };
      const b = activeBoundary;
      let keptDirty: string[] = [];
      if (b.hasCode) {
        const r = await checkpoints.cancel(b.boundaryId);
        if ('error' in r) return { error: r.error };
        keptDirty = r.keptDirty;
      }
      // H-01:Redo(cancel)→ 向 WAL append rewind.revoked(按 rewindId=boundaryId 撤销遮蔽),
      //   被回退轮次在后续 resume 中恢复。append-only(原 rewind.applied 不删)。fail-soft。
      try {
        host.bus.publish({
          type: CoreEventType.RewindRevoked,
          payload: { rewindId: b.boundaryId },
          ts: Date.now(),
          source: 'tui-rewind',
        });
      } catch {
        /* ignore */
      }
      // 还原对话:agent 重置 + 下一轮重播种。H-03:reseed 复用 fold 路径——RewindRevoked 已写入
      //   → WAL 遮蔽解除 → fold 出**含工具轮**的完整 pre-rewind 历史(定格前不可能有新轮,故等价
      //   pre-rewind 全量)。读失败 → 退回内存 preConvo(文本级,graceful degradation)。
      agent = null;
      const restoredFold = await safeFold(host.store);
      const restored = restoredFold ? reattachImages(restoredFold, b.preMessages) : b.preConvo.slice();
      convo = restored.slice();
      pendingHistory = restored.length ? restored.slice() : null;
      const messages = b.preMessages.slice();
      activeBoundary = null;
      return { messages, keptDirty };
    },

    async overwriteDirty() {
      if (!activeBoundary?.hasCode) return { error: 'no file rewind in effect' };
      return checkpoints.overwriteDirty(activeBoundary.boundaryId);
    },

    async undoOverwrite() {
      if (!activeBoundary?.hasCode) return { error: 'no overwrite to undo' };
      return checkpoints.undoOverwrite(activeBoundary.boundaryId);
    },

    finalizeRewind(): void {
      if (!activeBoundary) return;
      if (activeBoundary.hasCode) checkpoints.finalizePending();
      activeBoundary = null;
    },

    async dispose(): Promise<void> {
      // 退出前等最近一轮的 auto-memory 抽取落盘(driveTurn 已不再行内 await,见上)。
      try {
        await agent?.drainAutoMemory();
      } catch {
        /* ignore */
      }
      for (const d of host.disposers) {
        try {
          await d();
        } catch {
          /* ignore */
        }
      }
    },
  };
  return driver;
}

/** 从会话 WAL fold 出完整历史(与 resume 同一路径,含工具轮 + 吃 rewind 遮蔽);读失败 → 空。
 *  H-03:rewind/Redo 的历史 reseed 复用它,不再各自有损重建。 */
async function safeFold(store: HostContext['store']): Promise<ProviderMessage[] | undefined> {
  try {
    return await foldSessionHistory(store);
  } catch {
    return undefined;
  }
}

/** 多模态不回归:WAL 的 user_prompt.submit 只存**文本** prompt(images 从不入 WAL,resume
 *  同样丢),故 fold 出的 user 文本轮无图。这里按序把保留 UiMessage 里的 images 覆盖回对应的
 *  fold user 文本轮,使回退后模型仍看到此前发过的图(与旧 toHistory 口径一致)。粘贴文本在
 *  提交前已展开。fold 与 UiMessage 的 user 轮同序且数量相等(遮蔽后 fold 恰好 keep 个)。 */
function reattachImages(folded: ProviderMessage[], keptUserMessages: UiMessage[]): ProviderMessage[] {
  const imgs = keptUserMessages
    .filter((m): m is Extract<UiMessage, { kind: 'user' }> => m.kind === 'user')
    .map((m) => m.images);
  let i = 0;
  return folded.map((m) => {
    // fold 出的 user **文本**轮:content 为 string(tool_result 轮 content 是数组,不配对)。
    if (m.role === 'user' && typeof m.content === 'string') {
      const im = imgs[i++];
      if (im && im.length) return { role: 'user', content: buildUserContent(m.content, im) };
    }
    return m;
  });
}

/** DriverOptions(+ 覆盖 model / 当前 sessionId)→ HostContextArgs。
 *  sessionId 显式透传当前可变值(而非 opts.sessionId 快照),使 /clear 换新 id 后再 setModel
 *  重建的 host(含 per-session WAL)也绑到新会话身份(F1)。 */
function toHostArgs(opts: DriverOptions, model: string, sessionId: string | undefined): HostContextArgs {
  return {
    model,
    demo: opts.demo,
    memoryDir: opts.memoryDir,
    skillDirs: opts.skillDirs,
    commandDirs: opts.commandDirs,
    mcpConfigPath: opts.mcpConfigPath,
    pluginDirs: opts.pluginDirs,
    hooksConfigPath: opts.hooksConfigPath,
    searchUrl: opts.searchUrl,
    sessionId,
    sessionsDir: opts.sessionsDir,
  };
}

/** driver 经 Context 暴露给屏幕(useAgent)。App 在树顶注入唯一实例。 */
const AgentContext = createContext<AgentDriver | null>(null);

export function AgentProvider(props: { driver: AgentDriver; children: React.ReactNode }): React.ReactElement {
  return <AgentContext.Provider value={props.driver}>{props.children}</AgentContext.Provider>;
}

export function useAgent(): AgentDriver {
  const v = useContext(AgentContext);
  if (!v) throw new Error('useAgent must be used within <AgentProvider>');
  return v;
}
