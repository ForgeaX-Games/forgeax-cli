/**
 * ClaudeCodeKernel — the reference agent CLI(headless)适配成中立 `AgentKernel`。
 *
 * **薄脊梁(spine)**:本文件只剩 CC 执行面的「流程骨架」——spawn / session resume /
 * stream-json → KernelEvent 的搬运 / 取消。**所有 Claude-Code-isms(argv flags、
 * permission-mode 枚举、MCP-isms、wire→KernelEvent 映射、stop-reason 映射)都锁在
 * `cc-profile.ts`**(adaptor profile)。日后整对外迁到 `packages/kernel-adaptors/
 * claude-code` 时,搬「本文件 + cc-profile.ts」,spine 上的中立契约不动。
 *
 * 「组装一轮」(systemPrompt/charter/persona/model)由编排层 `composeTurnRequest`
 * 提供;内核只负责执行面。旧 `cli-providers` 路径原地保留作 fallback(FORGEAX_KERNEL=cli)。
 *
 * 复用共享件:`spawnJsonl`(自动 merge process.env)、`mapClaudeEvent`(raw→ChatEvent)。
 *
 * 基线(headless · 不接 SDK):无优雅 mid-turn;`cancel`/`interrupt` = 杀进程。
 */
import type {
  AgentKernel,
  KernelCapabilities,
  KernelEvent,
  KernelHealth,
  KernelModelCatalog,
  PermissionMode,
  TurnHandle,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { runCapture } from '../lib/node-spawn';
import { spawnJsonl, scrubbedSecretEnv } from '../cli-providers/shared/subprocess-jsonl';
import { issueToken, revokeToken } from './cred-proxy';
import { sidecarSpawnJsonl, materializeEnv, stripModelKeys } from './sidecar-spawn';
import { ensureSidecar } from './sidecar-singleton';
import { sidecarEnabled } from './kernel-mode';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import {
  createClaudeMapperState,
  flushClaudeMapper,
  mapClaudeEvent,
  type ClaudeRawEvent,
} from '../cli-providers/shared/claude-code-mapper';
import { defaultProjectRoot } from '@forgeax/platform-io';
import {
  buildCcArgs,
  buildSessionArgs,
  chatEventToKernel,
  CLAUDE_CODE_DRIVER_LABEL,
  CLAUDE_CODE_FALLBACK_MODELS,
  probeStreamJsonModels,
  registerTurnGate,
  releaseTurnGate,
  toCcPermissionMode,
  type CcPermissionMode,
} from './cc-profile';

export class ClaudeCodeKernel implements AgentKernel {
  readonly id = 'claude-code';
  readonly displayName = CLAUDE_CODE_DRIVER_LABEL;
  readonly fallbackModels = CLAUDE_CODE_FALLBACK_MODELS;

  /** 真实模型目录:stream-json 控制面 initialize 的 `models` —— 与 TUI `/model`
   *  同一份(按订阅现算)。失败 → 编排层降级 last-known → fallbackModels。 */
  async listModels(): Promise<KernelModelCatalog> {
    const models = await probeStreamJsonModels(await this.binary());
    return { models, source: 'kernel' };
  }

  readonly capabilities: KernelCapabilities = {
    streaming: true,
    thinking: true,
    toolCalls: true,
    midTurnInject: false,
    // cc 自带 extractMemories fork,但无法用分层 policy 驱动它 → 对编排层不可驱动,标 false(走冷兜底)。
    forkExtract: false,
  };

  private binaryPromise?: Promise<string>;
  /** threadId 已起过 session → 后续 --resume(与旧 provider 对称)。 */
  private readonly startedThreadIds = new Set<string>();
  /** callId → 在飞 turn 的 AbortController(供 openHandle().cancel 杀进程)。 */
  private static readonly inflight = new Map<string, AbortController>();

  private binary(): Promise<string> {
    return (this.binaryPromise ??= resolveBinary({
      envVarName: 'ANTHROPIC_CLI_PATH',
      defaultBinary: 'claude',
    }));
  }

  async *runTurn(req: TurnRequest, signal: AbortSignal): AsyncIterable<KernelEvent> {
    // 内部 AbortController:外部 signal 或 openHandle(callId).cancel 任一触发都中断。
    const ac = new AbortController();
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
    if (req.callId) ClaudeCodeKernel.inflight.set(req.callId, ac);

    // 权限闸(B-4):若编排层提供了中立 `requestPermission`,把它登记进 in-process gate
    // registry(键=真实 sid),供权限回执端优先于「弹卡」直接咨询。详见 cc-profile 注释。
    const gateSid = req.hostSessionId?.trim() || req.session.threadId?.trim() || '';
    const gateRegistered = req.requestPermission ? registerTurnGate(gateSid, req.requestPermission) : false;

    let credToken: string | undefined;
    try {
      const binary = await this.binary();
      const projectRoot = defaultProjectRoot();
      const args = this.buildArgs(req, projectRoot);

      // 凭据地板:imported → scrub 非必要宿主密钥。模型 key 处理分两路:
      //  - sidecar 路径(FORGEAX_SIDECAR=on):凭据由 **sidecar cred-vault** 发 scoped token,
      //    本进程**不跑** in-process cred-proxy,且把真模型 key 从 env 剔除(不经 socket 外发);
      //    sidecar 注入 scoped。
      //  - 非 sidecar(默认):server 进程内 cred-proxy 发 nonce(C0-a 过渡)。
      const useSidecar = sidecarEnabled();
      let envOverride: Record<string, string | undefined> | undefined;
      if (req.trustTier === 'imported') {
        envOverride = scrubbedSecretEnv();
        if (!useSidecar) {
          const issued = await issueToken('anthropic');
          if (issued) {
            credToken = issued.token;
            envOverride = { ...envOverride, ANTHROPIC_API_KEY: issued.token, ANTHROPIC_BASE_URL: issued.baseUrl };
          }
        }
      }
      const sidecarBaseId = req.callId || req.hostSessionId || req.session.threadId || req.session.agentId || 'kernel';
      const { lines, exit } = useSidecar
        ? sidecarSpawnJsonl<ClaudeRawEvent>(await ensureSidecar(), {
            sessionId: sidecarBaseId,
            agentId: req.session.agentId || 'forge',
            trustTier: req.trustTier ?? 'own',
            callId: sidecarBaseId,
            ...(req.budget ? { budget: req.budget } : {}),
            // credential='sidecar-managed' → sidecar 发 scoped token 注入;此处剔除真模型 key 不外发。
            kernel: { kind: 'claude-code', credential: 'sidecar-managed', cmd: binary, args, cwd: projectRoot, env: stripModelKeys(materializeEnv(envOverride)) },
          }, ac.signal)
        : spawnJsonl<ClaudeRawEvent>({
            cmd: binary,
            args,
            cwd: projectRoot,
            signal: ac.signal,
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
        yield* chatEventToKernel({ type: 'error', message: `claude-code stream error: ${(streamErr as Error).message}` });
        return;
      }

      const exitInfo = await exit;
      if (!state.doneEmitted) {
        if (signal.aborted) {
          // 取消语义(R4-05):杀进程导致 exitInfo.code !== 0,但这是「用户/编排层
          // 主动中断」而非真崩溃 —— 必须收口为 turn.done{cancelled},而非 error。
          // 经 cc profile 的 done 路径(stopReason:'cancelled' → wireStopToKernel
          // → 'cancelled')复用同一终态构造,保持 DRY、不手搓 raw 事件形状。
          // flushClaudeMapper 自身置 doneEmitted,无需在此重复。
          for (const ev of flushClaudeMapper(state, 'cancelled')) yield* chatEventToKernel(ev);
        } else if (exitInfo.code !== 0) {
          const tail = exitInfo.stderr.split('\n').filter(Boolean).slice(-3).join(' | ').trim();
          yield* chatEventToKernel({ type: 'error', message: `claude exited ${exitInfo.code}${tail ? ': ' + tail : ''}` });
        } else {
          for (const ev of flushClaudeMapper(state)) yield* chatEventToKernel(ev);
        }
      }
    } finally {
      if (credToken) revokeToken(credToken);
      if (req.callId) ClaudeCodeKernel.inflight.delete(req.callId);
      if (gateRegistered) releaseTurnGate(gateSid);
    }
  }

  /** 从中立 TurnRequest 拼 `claude -p` argv —— 委托给 cc-profile(所有 CC-isms 在那)。
   *  permissionMode 取自 openHandle().setPermissionMode 设过的值(经中立模式翻译),
   *  缺省 → cc-profile 的默认(headless acceptEdits)。 */
  private buildArgs(req: TurnRequest, projectRoot: string): string[] {
    const tid = req.session.threadId?.trim();
    const session = buildSessionArgs(tid, projectRoot, this.startedThreadIds);
    if (session.threadId) this.startedThreadIds.add(session.threadId);
    const pendingMode = req.callId ? ClaudeCodeKernel.pendingPermissionMode.get(req.callId) : undefined;
    return buildCcArgs(req, projectRoot, session.args, pendingMode);
  }

  /** callId → 下一轮 spawn 要用的 CC permission-mode(由 setPermissionMode 翻译填入)。
   *  headless `claude -p` 无法 mid-turn 改 permission-mode(没有 SDK control 通道),
   *  故 setPermissionMode 只能影响**下一轮** spawn 的 argv —— 见 openHandle 注释。 */
  private static readonly pendingPermissionMode = new Map<string, CcPermissionMode>();

  openHandle(callId: string): TurnHandle {
    const kill = async (): Promise<void> => {
      ClaudeCodeKernel.inflight.get(callId)?.abort();
    };
    return {
      async setPermissionMode(mode: PermissionMode): Promise<void> {
        // headless `claude -p` 是一次性 spawn,**无 mid-turn control 通道**(那是 CC
        // SDK 的能力,headless 没有)→ 不能改正在飞的这一轮。我们做能做的:把中立模式
        // 经 cc-profile 翻成 CC 枚举存下,**下一轮**该 callId 的 spawn argv 即生效
        // (`--permission-mode <translated>`)。这是 headless 形态的真实上限,不静默假装。
        ClaudeCodeKernel.pendingPermissionMode.set(callId, toCcPermissionMode(mode));
      },
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
      const hasKey = Boolean(process.env.ANTHROPIC_API_KEY) || existsSync(resolvePath(homedir(), '.claude.json'));
      return code === 0 && hasKey
        ? { ok: true, kernelId: this.id, detail: out || 'claude ready' }
        : { ok: false, kernelId: this.id, detail: !hasKey ? 'ANTHROPIC_API_KEY/login missing' : `claude --version exit ${code}` };
    } catch (e) {
      return { ok: false, kernelId: this.id, detail: (e as Error).message };
    }
  }
}
