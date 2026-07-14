/**
 * CursorKernel — 本机已装的 `cursor-agent` CLI(headless `-p --output-format
 * stream-json`)适配成中立 `AgentKernel`,与 ClaudeCodeKernel / CodexKernel 并列的
 * 第三个内核实现。
 *
 * **薄脊梁(spine)**:本文件只剩 cursor 执行面的「流程骨架」—— spawn / ndjson →
 * KernelEvent 的搬运 / 会话续接 / 取消。**所有 cursor-isms(argv、systemPrompt
 * 注入、ndjson→KernelEvent 映射)都锁在 `cursor-profile.ts`(+ `cursor-mapper.ts`)**。
 * 日后整对外迁到 `packages/kernel-adaptors/cursor` 时搬那两件,spine 上的中立契约不动。
 *
 * **会话续接 = 从首轮自带的 session_id 续接(不再额外 `create-chat` 预铸)**:
 * cursor 在首轮 turn 的 `system.init` 事件里**自带** minted `session_id`(mapper 已
 * 捕进 `state.sessionId`)。首轮直接发 turn(无 `--resume`,cursor 隐式新建 chat 并
 * 回报 id),turn 结束后把该 id 记进 `threadToCursor`,后续轮 `--resume` 续接。这省掉
 * 了每条 thread 首条消息约 2s 的冗余 `create-chat` 冷启动 spawn(它纯属重复——turn 流
 * 本就携带同一个 id),并修复了「预铸 id 让 `isFirstTurn` 恒 false → charter/persona
 * 从不注入」的隐性 bug。
 *
 * 「组装一轮」(systemPrompt/charter/persona)由编排层 `composeTurnRequest` 提供;
 * 本内核只负责 cursor 执行面。从 server 旧 cli-provider `providers/cursor-agent.ts`
 * 移植(那是 CliProvider 模型;此处改 AgentKernel),复用 `spawnJsonl`(自动 merge
 * process.env)—— 与旧 provider 一致走直接 spawn(非 sidecar)。
 *
 * 基线(headless · 不接 SDK):无优雅 mid-turn;`cancel`/`interrupt` = 杀进程。
 * per-tool 审批只有 Hooks 一个注入点 → 本首版按 `--force` 平滑基线跑,审批卡 hook
 * (forgeax-cursor-hooks + cursor-permission-hook.mjs + 权限注册表接线)作为后续单独
 * 接入(见 task 2e),故 requestPermission 暂不接(no-op,与 codex 同风格,不静默假装)。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { spawnJsonl, scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import { runCapture } from '../lib/node-spawn';
import { defaultProjectRoot } from '@forgeax/platform-io';
import {
  buildCursorArgs,
  createCursorMapperState,
  CURSOR_DRIVER_LABEL,
  CURSOR_FALLBACK_MODELS,
  ensureCursorHooksConfig,
  flushCursorMapper,
  mapCursorEvent,
  probeCursorModels,
  type CursorRawEvent,
} from './cursor-profile';
import { buildCursorHomeWithoutUserMcp, disposeCursorHome } from './cursor-home';

export class CursorKernel implements AgentKernel {
  // id MUST match the UI's providerOverride for cursor (interface uses
  // 'cursor-agent' — see interface/src/lib/cli-providers.ts), so resolveKernel
  // ('cursor-agent') reaches this kernel.
  readonly id = 'cursor-agent';
  readonly displayName = CURSOR_DRIVER_LABEL;
  readonly fallbackModels = CURSOR_FALLBACK_MODELS;

  /** 真实模型目录:`cursor-agent --list-models`(见 cursor-profile)。
   *  失败 → 编排层降级 last-known → fallbackModels。 */
  async listModels(): Promise<KernelModelCatalog> {
    return { models: await probeCursorModels(), source: 'kernel' };
  }

  readonly capabilities: KernelCapabilities = {
    // cursor `--stream-partial-output` 的 assistant 文本是 token 级流式。
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  /** threadId → cursor 的 chat id(首轮从 `system.init` 回填,用于 --resume)。 */
  private readonly threadToCursor = new Map<string, string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'CURSOR_CLI_PATH',
      defaultBinary: 'cursor-agent',
    }));
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CursorKernel.inflight.set(req.callId, ac);

    // tid + mapper state 提到 try 外:首轮无 chat id,turn 结束后要从 state.sessionId
    // (cursor 在 system.init 里铸出的 id)回填 threadToCursor 供下一轮 --resume —— 回填
    // 放在 finally,确保即使 turn 中途出错、只要已收到 system.init 也能续接。
    const tid = req.session.threadId?.trim();
    const state = createCursorMapperState();
    // 加速(opt-in,默认关):仅当 FORGEAX_CURSOR_ISOLATE_MCP=1 时,用镜像 HOME 屏蔽用户个人
    // 全局 `~/.cursor/mcp.json`(那些远程 MCP server 每轮握手 ~5s,与游戏开发无关)。默认/失败/
    // Windows 返回 undefined → 退回真实 HOME(原有逻辑不变)。turn 结束 finally 清理。
    let isoHome: string | undefined;
    try {
      const binary = await this.binary();
      const projectRoot = defaultProjectRoot();
      isoHome = buildCursorHomeWithoutUserMcp();

      // settings.permissions 拦截面(046 楔子3 = task 2e):工作区静态 .cursor/hooks.json
      // (beforeShellExecution/beforeMCPExecution → forgeax /:sid/hook-gate)。上下文经
      // per-turn spawn env 注入;用户自跑 cursor 无 FORGEAX env → hook 零干预。
      const hooksActive = ensureCursorHooksConfig(projectRoot);
      const forgeaxHookEnv: Record<string, string> = hooksActive
        ? {
            FORGEAX_SERVER_URL: `http://127.0.0.1:${process.env.FORGEAX_SERVER_PORT ?? '18900'}`,
            FORGEAX_SID: req.hostSessionId?.trim() || tid || '',
            FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
          }
        : {};

      // cursor auth：CURSOR_API_KEY 透传(无则靠 `cursor-agent login`);imported pack 凭据地板：scrub。
      let env: Record<string, string> = { ...forgeaxHookEnv };
      if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
      if (isoHome) env.HOME = isoHome;
      let envOverride: Record<string, string | undefined> | undefined;
      if (req.trustTier === 'imported') {
        envOverride = { ...scrubbedSecretEnv(), ...forgeaxHookEnv };
        // scrub 后仍保留 cursor 自己的 key（非模型 key），否则无可用鉴权路径。
        if (process.env.CURSOR_API_KEY) envOverride = { ...envOverride, CURSOR_API_KEY: process.env.CURSOR_API_KEY };
        if (isoHome) envOverride = { ...envOverride, HOME: isoHome };
        env = {};
      }

      // 会话连续:本 thread 之前跑过 → 用记下的 cursor chat id `--resume`;首轮则
      // cursorChatId=undefined(无 `--resume`,且 buildCursorArgs 据此前置 charter/persona)。
      // 不再额外 spawn `create-chat` 预铸 id —— turn 自带的 system.init 已携带同一 id。
      const cursorChatId = tid ? this.threadToCursor.get(tid) : undefined;

      // prompt 走 stdin(不进 argv):cursor `-p` 无位置参数时从 stdin 读 prompt。
      // 这样首轮的超长 charter+persona+task 不再撑爆 Windows cmd.exe 的 ~8191 命令
      // 行上限(否则 GBK「命令行太长。」+ exit 1)。stdin 是管道、不受长度限制,全平台一致。
      const { args, message } = buildCursorArgs(req, cursorChatId);
      const { lines, exit } = spawnJsonl<CursorRawEvent>({
        cmd: binary,
        args,
        env,
        cwd: projectRoot,
        signal: ac.signal,
        stdin: message,
        ...(envOverride ? { envOverride } : {}),
      });

      try {
        for await (const raw of lines) {
          for (const ev of mapCursorEvent(raw, state)) yield ev;
        }
      } catch (streamErr) {
        if (!state.doneEmitted) {
          yield { kind: 'turn.usage' };
          yield {
            kind: 'error',
            error: { code: 'protocol', message: `cursor-agent stream error: ${(streamErr as Error).message}` },
          };
          yield { kind: 'turn.done', reason: 'error' };
          state.doneEmitted = true;
        }
        return;
      }

      const exitInfo = await exit;
      // 兜底:进程退出但 mapper 从未发过终态。
      if (!state.doneEmitted) {
        if (exitInfo.code !== 0) {
          const stderrTail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').trim();
          yield { kind: 'turn.usage' };
          yield {
            kind: 'error',
            error: { code: 'protocol', message: `cursor-agent exited ${exitInfo.code}${stderrTail ? ': ' + stderrTail : ''}` },
          };
          yield { kind: 'turn.done', reason: 'error' };
          state.doneEmitted = true;
        } else {
          for (const ev of flushCursorMapper(state)) yield ev;
        }
      }
    } finally {
      // 回填 cursor 在 system.init 里铸出的 chat id → 本 thread 下一轮 `--resume` 续接。
      // 只在首次(尚无映射)写入,后续轮 resume 的同一 id 无需重写。
      if (tid && state.sessionId && !this.threadToCursor.has(tid)) {
        this.threadToCursor.set(tid, state.sessionId);
      }
      // 清理镜像 HOME(只删 symlink,绝不动真实 target)。
      disposeCursorHome(isoHome);
      if (req.callId) CursorKernel.inflight.delete(req.callId);
    }
  }

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      CursorKernel.inflight.get(callId)?.abort();
    };
    return {
      // no-op(诚实标注):cursor headless 的权限语义 = spawn 时固定的 `--force` 平滑基线;
      // per-tool 审批只有 Hooks 注入点(本首版未接,见 task 2e),无 mid-turn control 通道改
      // 放行模式 → 中立 PermissionMode 在 cursor 上暂无落点。保持 no-op,不静默假装。
      async setPermissionMode(): Promise<void> {},
      async setModel(): Promise<void> {},
      interrupt: kill,
      cancel: kill,
    };
  }

  async probe(): Promise<KernelHealth> {
    try {
      const binary = await this.binary();
      const { stdout, code } = await runCapture(binary, ['--version']);
      const out = stdout.trim().split('\n')[0] ?? '';
      // cursor 支持 `cursor-agent login`(无需 API key)→ 缺 CURSOR_API_KEY 非致命,
      // 只要 binary 在即 ok(与 codex login 流程一致)。
      return code === 0
        ? { ok: true, kernelId: this.id, detail: out || 'cursor-agent ready' }
        : { ok: false, kernelId: this.id, detail: `cursor-agent --version exit ${code}` };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        ok: false,
        kernelId: this.id,
        detail: /ENOENT|not found/i.test(msg)
          ? 'cursor-agent binary not on PATH (install: https://cursor.com/cli)'
          : msg,
      };
    }
  }
}
