/**
 * codex-profile — **所有 Codex-isms 的归口**(adaptor profile)。
 *
 * 设计 R4(B2):内核 spine 必须中立。Codex 专属词汇(`exec`/`exec resume` argv、
 * `approval_policy`/`sandbox_mode` 放行模式、systemPrompt 注入方式、JSONL→KernelEvent
 * 映射)一律锁在「本文件 + codex-mapper.ts」里,`codex-kernel.ts` 只剩薄脊梁。
 * 日后整对外迁到 `packages/kernel-adaptors/codex` 时,搬的就是这三件,spine 上的中立
 * 契约(@forgeax/agent-runtime)不动。
 *
 * 锁在这里的 Codex-isms:
 *  - {@link buildCodexArgs}  `codex exec [--json] / exec resume <tid> / --skip-git-repo-check /
 *                             -c approval_policy / -s|-c sandbox_mode / -m <model>` + prompt 组装
 *  - {@link CODEX_APPROVAL_POLICY} / {@link CODEX_SANDBOX_MODE} 放行模式常量
 *  - JSONL→KernelEvent 映射:re-export 自 codex-mapper.ts(本身已是隔离的 codex-ism)
 *
 * Codex 执行面与 CC 的关键差异(供薄脊梁理解):
 *  - 驱动:`codex exec --json [prompt]`,首轮 thread.started.thread_id 记下,
 *    后续 `codex exec resume <thread_id>` 续接(resume 子命令不接 `-s/--sandbox`,
 *    sandbox 走 `-c sandbox_mode=...`)。
 *  - systemPrompt 无 flag → 把 charter+persona 作「指令」前置进 prompt(headless 安全,
 *    不碰仓内 AGENTS.md)。
 *  - headless 放行:`--skip-git-repo-check` + `-c approval_policy=never` +
 *    `-s workspace-write`(首轮)/ `-c sandbox_mode=workspace-write`(resume)。
 *  - 用量:只有 token(turn.completed.usage),无 $ cost → turn.usage.costUsd 留空。
 *  - 无 per-tool 权限回调(走 sandbox/approval 模式)→ requestPermission 不接。
 */
import type { TurnRequest } from '@forgeax/agent-runtime';

// JSONL→KernelEvent 映射本身就是 codex-ism;经 profile 统一再出口(spine 不直接 import mapper)。
export {
  createCodexMapperState,
  flushCodexMapper,
  mapCodexEvent,
  type CodexMapperState,
  type CodexRawEvent,
} from './codex-mapper';

/** headless 放行:不卡审批(per-tool 权限交给 sandbox)。 */
export const CODEX_APPROVAL_POLICY = 'never' as const;
/** headless sandbox:工作区可写(首轮 `-s`,resume 经 `-c sandbox_mode=`)。 */
export const CODEX_SANDBOX_MODE = 'workspace-write' as const;

/**
 * 从中立 TurnRequest 拼 `codex exec [--json] ...` argv。
 * `codexThreadId` 非空 → resume 子命令(由薄脊梁从 thread.started 记下后回传)。
 * systemPrompt(charter/persona)+ dynamicSuffix 由编排层 composeTurnRequest 提供。
 */
export function buildCodexArgs(req: TurnRequest, codexThreadId: string | undefined): string[] {
  // 诚实标注(no-op):中立 `systemPrompt.mode` 与 `req.toolPolicy` 在 codex headless **无落点**——
  // codex 无 `--system-prompt(-file)` flag(指令只能前置进 prompt,见下),也无 per-tool 放行/
  // 拒绝闸(headless 固定 approval_policy=never + sandbox_mode)。故 mode/toolPolicy 在此被忽略,
  // 不静默假装支持(与本文件 sandbox/approval 的 no-op 风格一致)。CC 专属能力见 cc-profile。
  //
  // systemPrompt 安全注入:codex 无 system-prompt flag,且写项目 AGENTS.md 会**覆盖仓内已有
  // AGENTS.md** → 改为把 charter+persona 作为「指令」前置进 prompt(headless 安全,不碰文件)。
  // dynamicSuffix(当轮记忆/感知)以 user 后缀拼在任务后。
  const sp = req.systemPrompt;
  const instructions = sp.persona?.trim()
    ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
    : sp.charter;
  const task = sp.dynamicSuffix?.trim()
    ? `${req.input.text}\n\n${sp.dynamicSuffix.trim()}`
    : req.input.text;
  const message = instructions?.trim()
    ? `# Instructions\n\n${instructions.trim()}\n\n# Task\n\n${task}`
    : task;

  // headless 放行:跳过 git 检查 + 不卡审批。
  const common = [
    '--json',
    '--skip-git-repo-check',
    '-c',
    `approval_policy="${CODEX_APPROVAL_POLICY}"`,
    ...(req.model ? ['-m', req.model] : []),
  ];

  if (codexThreadId) {
    // resume 子命令:不接 `-s/--sandbox`,sandbox 走 `-c sandbox_mode=`。
    return [
      'exec',
      'resume',
      codexThreadId,
      ...common,
      '-c',
      `sandbox_mode="${CODEX_SANDBOX_MODE}"`,
      message,
    ];
  }

  return ['exec', ...common, '-s', CODEX_SANDBOX_MODE, message];
}
