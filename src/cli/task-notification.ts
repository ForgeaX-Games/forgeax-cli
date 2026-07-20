/**
 * T4 · 后台完成 → 对话主动回注(`<task_notification>`)—— 纯 HOST 层接线。
 *
 * 问题:后台 bash(`bash run_in_background`)/后台子 agent(`Task run_in_background`)
 * 跑完后**不主动告知**对话,模型必须自己 poll `bash_output` 才知道结果。本模块在
 * **宿主侧**(src/cli/)把「完成」转成下一轮 prompt 的 system-reminder,`src/agent/`
 * **一行不改**。
 *
 * 两端走法(见 WORK-ORDERS.md T4):
 *  - **观察侧(两路)**:
 *    ① 后台 bash 的完成信号在宿主**自己注入的** `BackgroundSpawnFn`
 *       (`makeNodeBackgroundSpawn()`)的 chunk 流里 —— 看到 `exit` chunk 即入队。
 *       `BackgroundShellRegistry` 本身没有完成回调,所以观察点在 spawn 接缝,不在注册表。
 *    ② 后台子 agent 走 `BackgroundTasks.onDone` —— settle 时入队。
 *  - **注入侧(T4,被动兜底)**:宿主在 `UserPromptSubmit` 事件上订阅一个
 *    subscriber,把 pending 队列组装成 `<task_notification>` 文本经 `ctl.modify` 挂到
 *    事件回执的 `additionalContext` 上 → loop 现成收进 `hookContextReminders`
 *    (agent.ts:705-706),渲染成下一轮 dynamic system-reminder(cacheScope=null,不 bust
 *    prompt cache),与 auto-memory / hook additionalContext 同机制。
 *  - **唤醒侧(T4.5,主动)**:`setWakeListener` + `drain` —— TUI(Repl)注册回调,
 *    enqueue 时收到信号,若轮串行器 idle(无在飞轮/无排队/无浮层/用户没打字)则 drain
 *    合成一轮自动续接;忙/让位时通知留 pending,仍由 T4 注入兜底。两路共享同一 pending,
 *    互不双投。idle 判定与递归护栏全在宿主侧,hub 保持纯队列。
 *
 * 去重/节流:每个后台任务只入队一次(bash 靠 spawn 包装里的 `done` 位;subagent 靠
 * settle 只发一次);并发完成合并成一条 `<task_notification>` 按序注入,入队即出队
 * (UserPromptSubmit 一次 drain 全部并清空)。
 *
 * Boundary: 仅 core-local 相对 import(HOST 层)。
 */
import type { BackgroundSpawnFn } from '../capability/builtin-tools/shell-registry';
import type { BackgroundDone } from '../agent/background';
import type { SubagentResult } from '../agent/subagent';
import type { EventBusAPI, Unsubscribe, CoreEvent } from '../events/types';
import { CoreEventType } from '../events/events';

/** 单条后台完成通知。 */
export interface PendingTaskNotification {
  /** 渲染用短标签(bash = 命令;subagent = description)。 */
  label: string;
  /** 结果摘要一句(bash = `exit code N`;subagent = `done (reason)` / `failed: …`)。 */
  status: string;
  /** 可选:有界输出尾(bash = stdout/stderr 末段;subagent = 结果文本末段)。 */
  outputTail?: string;
}

/** label 截断上限(防超长命令撑爆 reminder)。 */
const LABEL_MAX = 200;
/** 输出尾累积/渲染上限(字符)。 */
const TAIL_MAX = 1500;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 后台完成通知中枢:攒 pending 队列,提供两路观察接缝 + 一个注入订阅者。
 *
 * 一个 host session 一个实例(`buildHostContext` 建、挂进 disposers 清理订阅)。
 */
export class TaskNotificationHub {
  private readonly pending: PendingTaskNotification[] = [];
  /** T4.5 活动接缝:enqueue(带完成项)与后台 shell/agent 起/停(不带)时通知宿主——
   *  TUI 据此即时上屏完成 notice、刷新「后台运行中」计数、并在 idle 时合成唤醒轮。 */
  private activityListener?: (completed?: PendingTaskNotification) => void;
  /** 运行中的后台 shell 数(spawn 起 +1,首个 exit chunk -1;状态栏计数标签用)。 */
  private running = 0;
  /** 运行中的后台子 agent 数(BackgroundTasks 登记 +1,settle -1;状态栏计数标签用)。 */
  private runningAgentCount = 0;

  /** 当前 pending 数(测试/observability 用)。 */
  get size(): number {
    return this.pending.length;
  }

  /** 运行中的后台 shell 数(TUI 状态栏常驻指示用)。 */
  get runningShells(): number {
    return this.running;
  }

  /** 运行中的后台子 agent 数(TUI 状态栏常驻指示用)。 */
  get runningAgents(): number {
    return this.runningAgentCount;
  }

  /** 入队一条完成通知。入队后携该项回调活动接缝(fail-soft:listener 异常不影响入队)。 */
  enqueue(n: PendingTaskNotification): void {
    const item = { ...n, label: truncate(n.label, LABEL_MAX) };
    this.pending.push(item);
    this.notify(item);
  }

  /**
   * T4.5:注册/注销活动回调(undefined 注销)。带 completed = 一条任务刚完成入队;
   * 不带 = 后台 shell 起/停(计数变化)。hub 只报事实,不判宿主闲忙——idle 判定、
   * 让位、递归护栏全在宿主(Repl)侧,hub 保持纯队列。
   */
  setActivityListener(fn?: (completed?: PendingTaskNotification) => void): void {
    this.activityListener = fn;
  }

  /** T4.5:一次取空 pending(唤醒路径消费)。与 subscribe 的 UserPromptSubmit drain 共享
   *  同一 pending —— 任一路取走后另一路自然为空,不双投。 */
  drain(): PendingTaskNotification[] {
    return this.pending.splice(0, this.pending.length);
  }

  private notify(completed?: PendingTaskNotification): void {
    try {
      this.activityListener?.(completed);
    } catch {
      /* ignore:活动上报是加固,失败不影响队列本身与 T4 被动注入兜底 */
    }
  }

  /**
   * 观察侧①:包装宿主注入的 `BackgroundSpawnFn`(后台 bash)。
   *
   * 透传全部 chunk 给原 `onChunk`(不改后台 bash 语义),同时旁路累积有界输出尾,
   * 见到**首个** `exit` chunk 时入队一条完成通知(`done` 位去重:一次 spawn 只入队一次)。
   */
  wrapBackgroundSpawn(inner: BackgroundSpawnFn): BackgroundSpawnFn {
    return (cmd, args, opts, onChunk) => {
      // shell-registry 以 `sh -c <command>` 起进程 → 取末段为可读命令;非 sh 直接拼 argv。
      const command = cmd === 'sh' && args.length >= 2 ? args[args.length - 1] : [cmd, ...args].join(' ');
      let done = false;
      let tail = '';
      // 运行计数 +1 并上报(状态栏「后台 N」即时可见,不等完成)。
      this.running += 1;
      this.notify();
      return inner(cmd, args, opts, (chunk) => {
        if (chunk.stream === 'stdout' || chunk.stream === 'stderr') {
          tail = (tail + chunk.data).slice(-TAIL_MAX);
        } else if (chunk.stream === 'exit' && !done) {
          done = true;
          this.running = Math.max(0, this.running - 1);
          const t = tail.trim();
          this.enqueue({
            label: command,
            status: `exit code ${chunk.data}`,
            ...(t ? { outputTail: t } : {}),
          });
        }
        onChunk(chunk);
      });
    };
  }

  /**
   * 观察侧②:`BackgroundTasks` 适配(后台子 agent)。
   *
   * `onStart` 挂登记接缝(运行计数 +1 并上报,与 shell 的 spawn 对称);`onDone` 挂
   * settle 接缝(计数 -1,入队完成/失败通知)。挂给
   * `new BackgroundTasks<SubagentResult>({ onStart, onDone })`。
   */
  onSubagentStart = (): void => {
    this.runningAgentCount += 1;
    this.notify();
  };

  onSubagentDone = (d: BackgroundDone<SubagentResult>): void => {
    this.runningAgentCount = Math.max(0, this.runningAgentCount - 1);
    const label = d.label ?? `subagent ${d.id}`;
    if (d.error !== undefined) {
      this.enqueue({ label, status: `failed: ${errMsg(d.error)}` });
      return;
    }
    const r = d.result;
    const text = typeof r?.text === 'string' ? r.text.trim() : '';
    this.enqueue({
      label,
      status: r ? `done (${r.terminalReason})` : 'done',
      ...(text ? { outputTail: text.slice(-TAIL_MAX) } : {}),
    });
  };

  /**
   * 注入侧:在 `UserPromptSubmit` 上订阅,drain pending → `ctl.modify` 挂
   * `additionalContext`(追加,不 clobber 既有 hook 的 additionalContext)。
   *
   * loop(agent.ts:702-706)从 publish 回执读出 additionalContext,注成下一轮
   * `<system-reminder>` 可见 → 模型据此续接。返回 Unsubscribe(挂 disposers)。
   */
  subscribe(bus: EventBusAPI): Unsubscribe {
    return bus.subscribe(CoreEventType.UserPromptSubmit, (event, ctl) => {
      if (this.pending.length === 0) return;
      const drained = this.drain();
      const block = renderTaskNotification(drained);
      const prev = (event as { additionalContext?: string }).additionalContext;
      // additionalContext 不是 CoreEvent 的静态字段(与 from-settings.ts 的 hook 决议同路),
      //   用交叉类型给 modify 补上;loop 的 readHookExtra 从回执读它。追加以不覆盖既有 hook。
      const patch: Partial<CoreEvent> & { additionalContext?: string } = {
        additionalContext: prev ? `${prev}\n${block}` : block,
      };
      ctl.modify(patch);
    });
  }
}

/** 把 pending 组装成一段 `<task_notification>` 文本(多条并发完成合并、按入队序)。 */
export function renderTaskNotification(items: PendingTaskNotification[]): string {
  const lines = items.map((n) => {
    let s = `Background task \`${n.label}\` completed (${n.status}).`;
    if (n.outputTail) s += `\nRecent output:\n${truncate(n.outputTail, TAIL_MAX)}`;
    return s;
  });
  return `<task_notification>\n${lines.join('\n\n')}\n</task_notification>`;
}
