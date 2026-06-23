/**
 * CursorKernel — 本机已装的 `cursor-agent` CLI(headless `-p --output-format
 * stream-json`)适配成中立 `AgentKernel`,与 ClaudeCodeKernel / CodexKernel 并列的
 * 第三个内核实现。
 *
 * **薄脊梁(spine)**:本文件只剩 cursor 执行面的「流程骨架」—— 首轮 `create-chat`
 * 拿 chat id(供 --resume) / spawn / ndjson → KernelEvent 的搬运 / 取消。**所有
 * cursor-isms(argv、systemPrompt 注入、ndjson→KernelEvent 映射)都锁在
 * `cursor-profile.ts`(+ `cursor-mapper.ts`)**。日后整对外迁到
 * `packages/kernel-adaptors/cursor` 时搬那两件,spine 上的中立契约不动。
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
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { spawnJsonl, scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import { defaultProjectRoot } from '../api/lib/safe-path';
import {
  buildCursorArgs,
  createCursorMapperState,
  flushCursorMapper,
  mapCursorEvent,
  type CursorRawEvent,
} from './cursor-profile';

export class CursorKernel implements AgentKernel {
  // id MUST match the UI's providerOverride for cursor (interface uses
  // 'cursor-agent' — see interface/src/lib/cli-providers.ts), so resolveKernel
  // ('cursor-agent') reaches this kernel.
  readonly id = 'cursor-agent';
  readonly capabilities: KernelCapabilities = {
    // cursor `--stream-partial-output` 的 assistant 文本是 token 级流式。
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
  };

  private binaryPromise?: Promise<string>;
  /** threadId → cursor 的 chat id(create-chat 后记下,用于 --resume)。 */
  private readonly threadToCursor = new Map<string, string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'CURSOR_CLI_PATH',
      defaultBinary: 'cursor-agent',
    }));
  }

  /** `cursor-agent create-chat` → 新 chat id(单独一行的 UUID)。失败返回
   *  undefined,调用方退回无会话(--resume 缺省)单轮。 */
  private async createChat(binary: string, env: Record<string, string>, cwd: string): Promise<string | undefined> {
    try {
      const proc = Bun.spawn({
        cmd: [binary, 'create-chat'],
        cwd,
        env: { ...process.env, ...env },
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const t = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 15_000);
      const out = (await new Response(proc.stdout).text()).trim();
      const code = await proc.exited;
      clearTimeout(t);
      if (code !== 0) return undefined;
      const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      return m?.[0];
    } catch {
      return undefined;
    }
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CursorKernel.inflight.set(req.callId, ac);

    try {
      const binary = await this.binary();
      const projectRoot = defaultProjectRoot();

      // cursor auth：CURSOR_API_KEY 透传(无则靠 `cursor-agent login`);imported pack 凭据地板：scrub。
      let env: Record<string, string> = {};
      if (process.env.CURSOR_API_KEY) env.CURSOR_API_KEY = process.env.CURSOR_API_KEY;
      let envOverride: Record<string, string | undefined> | undefined;
      if (req.trustTier === 'imported') {
        envOverride = scrubbedSecretEnv();
        // scrub 后仍保留 cursor 自己的 key（非模型 key），否则无可用鉴权路径。
        if (process.env.CURSOR_API_KEY) envOverride = { ...envOverride, CURSOR_API_KEY: process.env.CURSOR_API_KEY };
        env = {};
      }

      // 会话连续：首轮 create-chat 拿 cursor chat id 并记下；后续轮 --resume 复用。
      const tid = req.session.threadId?.trim();
      let cursorChatId = tid ? this.threadToCursor.get(tid) : undefined;
      if (!cursorChatId) {
        cursorChatId = await this.createChat(binary, env, projectRoot);
        if (cursorChatId && tid) this.threadToCursor.set(tid, cursorChatId);
      }

      const args = buildCursorArgs(req, cursorChatId);
      const { lines, exit } = spawnJsonl<CursorRawEvent>({
        cmd: binary,
        args,
        env,
        cwd: projectRoot,
        signal: ac.signal,
        ...(envOverride ? { envOverride } : {}),
      });

      const state = createCursorMapperState();
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
      const proc = Bun.spawn({ cmd: [binary, '--version'], stdout: 'pipe', stderr: 'ignore' });
      const out = (await new Response(proc.stdout).text()).trim().split('\n')[0] ?? '';
      const code = await proc.exited;
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
