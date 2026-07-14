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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// ─── 模型目录(Codex-isms) ───────────────────────────────────────────
// 真实通道 = `codex app-server` JSON-RPC `model/list`(TUI /model 同源),
// 实现在 {@link CodexKernel.listModels}(app-server client 生命周期在内核侧)。
// 下方静态表只是回退链最后一层兜底(app-server 起不来 + 无 last-known 时)。

export const CODEX_DRIVER_LABEL = 'codex · subscription runtime · no local cost';

export const CODEX_FALLBACK_MODELS = [
  'gpt-5.2',
  'gpt-5.1-codex-max-medium',
  'gpt-5.4-mini-medium',
  'gpt-5-mini',
];

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

// ─── settings.permissions 拦截面(046 楔子3) ─────────────────────────
// codex 无 per-invocation hooks flag → 在 `<workspace>/.codex/hooks.json` 写**静态**
// PreToolUse hook(kernel-permission-hook.mjs 同步回调 forgeax `/:sid/hook-gate`:
// settings 规则求值,ask 弹 Studio 审批卡阻塞)。上下文(server/sid/agent)经 codex
// 进程 env 继承(codex-kernel spawn 注入 FORGEAX_*);用户在同一工作区自己跑 codex
// 时 hook 读不到 FORGEAX env → 零输出零干预。
// 实测 2026-07-14(codex-cli 0.143.0):工作区 hooks.json + `--dangerously-bypass-hook-trust`
// 在 headless `exec` 下 PreToolUse 真触发、deny 强制("Command blocked by PreToolUse hook")。
// ⚠️ 已知缺口(诚实标注,上游 openai/codex#16732):PreToolUse 对 `apply_patch` 文件
// 编辑 / 多数 MCP 调用触发不可靠 —— **文件编辑规则可能漏**;sandbox_mode=workspace-write
// 仍是 codex 的写入基线闸,规则面对 Bash 类可靠。

/** hooks.json 归属标记:命中才允许覆盖(不吃掉用户自己的 hooks.json)。 */
const CODEX_HOOKS_MARKER = 'kernel-permission-hook.mjs';

/**
 * 确保 `<projectRoot>/.codex/hooks.json` 是 forgeax 权限 hook 配置(幂等覆盖)。
 * 返回是否生效:已有**非 forgeax** 的 hooks.json → 不覆盖、返回 false(诚实降级:
 * 该工作区无规则拦截面,调用方不加 bypass-trust flag);写失败同样 false。
 */
export function ensureCodexHooksConfig(projectRoot: string): boolean {
  try {
    const dir = resolvePath(projectRoot, '.codex');
    const path = resolvePath(dir, 'hooks.json');
    const script = resolvePath(import.meta.dirname, 'hooks/kernel-permission-hook.mjs');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const next = JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 600 }] }] } },
      null,
      2,
    );
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (!raw.includes(CODEX_HOOKS_MARKER)) return false; // 用户自己的 hooks.json,不动
      if (raw === next) return true; // 幂等:内容已是最新
    } else {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(path, next);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从中立 TurnRequest 拼 `codex exec [--json] ...` argv。
 * `codexThreadId` 非空 → resume 子命令(由薄脊梁从 thread.started 记下后回传)。
 * systemPrompt(charter/persona)+ dynamicSuffix 由编排层 composeTurnRequest 提供。
 * `hooksActive` = ensureCodexHooksConfig 写入成功 → 附 `--dangerously-bypass-hook-trust`
 * (只信任我们自己刚写的 hook;用户自带 hooks.json 时不加,交 codex 自己的 trust 流程)。
 */
export function buildCodexArgs(req: TurnRequest, codexThreadId: string | undefined, hooksActive = false): string[] {
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

  // headless 放行:跳过 git 检查 + 不卡审批。hooksActive 时附 bypass-hook-trust
  // (headless 无人机交互确认 hook 信任;hook 是我们自己写的,信任由构造保证)。
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...(hooksActive ? ['--dangerously-bypass-hook-trust'] : []),
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
