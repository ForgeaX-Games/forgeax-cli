/**
 * CbcKernel — a peer agent CLI Code(headless `codebuddy -p`)适配成中立 `AgentKernel`。
 *
 * **薄脊梁(spine)**:本文件只剩 cbc 执行面的「流程骨架」——spawn / session resume /
 * stream-json → KernelEvent 的搬运 / 取消。**所有 a peer agent CLI-isms 锁在 `cbc-profile.ts`**。
 *
 * 与 {@link ClaudeCodeKernel} 的关系:cbc 是 the reference agent CLI 的近同源分叉,stream-json
 * 线格式一致,故**复用 `claude-code-mapper`**(raw→ChatEvent)。差异(缺
 * `--permission-prompt-tool` / `--append-system-prompt-file` / `--max-budget-usd`、
 * `~/.codebuddy` session 目录)全在 cbc-profile。
 *
 * 凭据:cbc **自管登录**(`~/.codebuddy/.credentials.json`,经 `codebuddy` 自身的
 * 登录流),不走 forgeax cred-vault / sidecar cred-proxy(那是为 Anthropic API key
 * 注入设计的,cbc 用自己的 base-url/凭据)。故本内核**只走直接 spawn 路径**——
 * 不接 sidecar。`imported` 信任档仍 scrub 宿主密钥(防泄漏给不可信 pack)。
 *
 * 基线(headless · 不接 SDK):无优雅 mid-turn;`cancel`/`interrupt` = 杀进程。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  PermissionMode,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { spawnJsonl, scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import {
  createClaudeMapperState,
  flushClaudeMapper,
  mapClaudeEvent,
  type ClaudeRawEvent,
} from '../cli-providers/shared/claude-code-mapper';
import { defaultProjectRoot } from '@forgeax/platform-io';
import {
  buildCbcArgs,
  buildCbcSessionArgs,
  chatEventToKernel,
  toCbcPermissionMode,
  type CbcPermissionMode,
} from './cbc-profile';

export class CbcKernel implements AgentKernel {
  readonly id = 'codebuddy';
  readonly capabilities: KernelCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
  };

  private binaryPromise?: Promise<string>;
  /** threadId 已起过 session → 后续 `--resume`(与 cc 对称)。 */
  private readonly startedThreadIds = new Set<string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();
  /** callId → 下一轮 spawn 要用的 permission-mode(headless 无 mid-turn 通道,只影响下一轮)。 */
  private static readonly pendingPermissionMode = new Map<string, CbcPermissionMode>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'CODEBUDDY_CLI_PATH',
      defaultBinary: 'codebuddy',
    }));
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) CbcKernel.inflight.set(req.callId, ac);

    try {
      const binary = await this.binary();
      const projectRoot = defaultProjectRoot();
      const args = this.buildArgs(req, projectRoot);

      // imported(不可信 pack)→ scrub 非必要宿主密钥(防泄漏);cbc 用自身凭据,
      // 不注入 forgeax 模型 token。own/builtin → 继承完整环境(可信)。
      const envOverride = req.trustTier === 'imported' ? scrubbedSecretEnv() : undefined;

      // cbc 的「无数据」看门狗默认 30s(`CODEBUDDY_STREAM_TIMEOUT_MS` / 首字节
      // `CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS`):大上下文下模型下一次响应的首字节常 >30s
      // (Forge 翻了一堆文件后 context 膨胀 + 经代理),cbc 会把整轮误判 abort 成
      // `error_during_execution: Stream timeout: no data received for 30000ms`(实测 8 次有 2 次)。
      // 调大到 3min(operator 可经 env 覆盖),把「误 abort」变回「正常等模型」。
      const cbcEnv: Record<string, string> = {
        CODEBUDDY_STREAM_TIMEOUT_MS: process.env.CODEBUDDY_STREAM_TIMEOUT_MS ?? '120000',
        CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS: process.env.CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS ?? '120000',
      };

      const { lines, exit } = spawnJsonl<ClaudeRawEvent>({
        cmd: binary,
        args,
        cwd: projectRoot,
        signal: ac.signal,
        env: cbcEnv,
        ...(envOverride ? { envOverride } : {}),
      });

      const state = createClaudeMapperState();
      try {
        for await (const raw of lines) {
          for (const ev of mapClaudeEvent(raw, state)) {
            yield* chatEventToKernel(ev);
          }
        }
      } catch (streamErr) {
        yield* chatEventToKernel({ type: 'error', message: `codebuddy stream error: ${(streamErr as Error).message}` });
        return;
      }

      const exitInfo = await exit;
      if (!state.doneEmitted) {
        if (exitInfo.code !== 0) {
          const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').trim();
          yield* chatEventToKernel({ type: 'error', message: `codebuddy exited ${exitInfo.code}${tail ? ': ' + tail : ''}` });
        } else {
          for (const ev of flushClaudeMapper(state)) yield* chatEventToKernel(ev);
        }
      }
    } finally {
      if (req.callId) CbcKernel.inflight.delete(req.callId);
    }
  }

  /** 从中立 TurnRequest 拼 `codebuddy -p` argv —— 委托给 cbc-profile。 */
  private buildArgs(req: TurnRequest, projectRoot: string): string[] {
    const tid = req.session.threadId?.trim();
    const session = buildCbcSessionArgs(tid, projectRoot, this.startedThreadIds);
    if (session.threadId) this.startedThreadIds.add(session.threadId);
    const pendingMode = req.callId ? CbcKernel.pendingPermissionMode.get(req.callId) : undefined;
    return buildCbcArgs(req, projectRoot, session.args, pendingMode);
  }

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      CbcKernel.inflight.get(callId)?.abort();
    };
    return {
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        // headless `codebuddy -p` 一次性 spawn,无 mid-turn control 通道 → 只能影响**下一轮**。
        CbcKernel.pendingPermissionMode.set(callId, toCbcPermissionMode(mode));
      },
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
      // cbc 自管登录:凭据落 ~/.codebuddy(.credentials.json / ~/.codebuddy.json)。
      const loggedIn =
        existsSync(resolvePath(homedir(), '.codebuddy', '.credentials.json')) ||
        existsSync(resolvePath(homedir(), '.codebuddy.json'));
      return code === 0 && loggedIn
        ? { ok: true, kernelId: this.id, detail: out || 'codebuddy ready' }
        : { ok: false, kernelId: this.id, detail: !loggedIn ? 'codebuddy login missing (run `codebuddy`)' : `codebuddy --version exit ${code}` };
    } catch (e) {
      return { ok: false, kernelId: this.id, detail: (e as Error).message };
    }
  }
}
