#!/usr/bin/env node
/** forgeax 外部内核统一权限 hook(cc + codex 共用,stdin/stdout,046 楔子3)。
 *
 *  接线:
 *   - claude-code:cc-profile 每 turn 生成 `--settings` 临时文件,PreToolUse hook 的
 *     command = `"<execPath>" "<本脚本>" <port> <sid> <agent> claude-code`(argv 携带
 *     全部上下文;cc 经 shell 起 hook,但 argv 比 env 前缀跨平台)。
 *   - codex:codex-profile 在 <workspace>/.codex/hooks.json 写**静态** PreToolUse hook
 *     (codex 无 per-invocation hooks flag),command 不带 argv;上下文经 codex 进程
 *     env 继承(FORGEAX_SERVER_URL/FORGEAX_SID/FORGEAX_AGENT/FORGEAX_KERNEL,由
 *     codex-kernel spawn 时注入)。
 *
 *  协议(两家同源,2026-07-14 双双实测):
 *    stdin  — 一个 JSON:{ tool_name, tool_input, hook_event_name, permission_mode?, ... }
 *    stdout — {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *              "permissionDecision":"allow"|"deny","permissionDecisionReason":...}}
 *    零输出 + exit 0 = 不干预(内核走自己的默认权限流)。
 *
 *  决策不在本地:同步 HTTP 回调 forgeax 决策端点 `/:sid/hook-gate`(settings.permissions
 *  规则求值;ask 由端点弹 Studio 审批卡并阻塞到用户点击)。本脚本只做三件事:
 *   1) 无 forgeax 上下文(port/sid 都拿不到)→ **零输出退出**:用户在同一工作区自己跑
 *      cc/codex 时本 hook 完全不干预(codex 的静态 hooks.json 会被用户进程加载到)。
 *   2) 跳过 mcp__fxt__* / mcp__forgeax__*(host-routed 工具在 /:sid/kernel-tool 的
 *      trust-gate 把闸,不双卡;permission 管道自己更不能被自己闸)。
 *   3) plan 模式(stdin permission_mode==='plan')下 **绝不发 allow**(cc 的 hook allow
 *      会绕过 plan 只读闸;deny 仍放行输出——deny bypass-immune)。
 *
 *  fail-closed:端点可达但拒 → deny;**传输错误/超时 → deny**(拿不到规则就不能证明
 *  没有 deny 规则;spawn 我们的 server 死了内核也活不久,宁可响亮失败)。
 */

const argvPort = (process.argv[2] || '').trim();
const argvSid = (process.argv[3] || '').trim();
const argvAgent = (process.argv[4] || '').trim();
const argvKernel = (process.argv[5] || '').trim();

const envUrl = (process.env.FORGEAX_SERVER_URL || '').trim().replace(/\/$/, '');
const SERVER_URL = argvPort ? `http://127.0.0.1:${argvPort}` : envUrl;
const SID = argvSid || (process.env.FORGEAX_SID || '').trim();
const AGENT = argvAgent || (process.env.FORGEAX_AGENT || '').trim() || 'forge';
const KERNEL = argvKernel || (process.env.FORGEAX_KERNEL || '').trim() || 'unknown';

function emitDecision(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    }) + '\n',
  );
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });
}

(async () => {
  // 1) 无 forgeax 上下文 → 不干预(用户自己的 cc/codex 运行,零行为变化)。
  if (!SERVER_URL || !SID) return;

  let payload = {};
  try { payload = JSON.parse((await readStdin()).trim() || '{}'); } catch { payload = {}; }
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!toolName) return;
  // 2) host-routed / 权限管道自身 → 不双闸。
  if (toolName.startsWith('mcp__fxt__') || toolName.startsWith('mcp__forgeax__')) return;

  const planMode = payload.permission_mode === 'plan';

  let decision;
  let reason;
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(SID)}/hook-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kernel: KERNEL, agent: AGENT, toolName, input: payload.tool_input ?? {} }),
      // 端点的 ask 会阻塞等审批卡(server 侧 10min 超时);本地留 30s 余量先超。
      signal: AbortSignal.timeout(9.5 * 60_000),
    });
    if (!res.ok) {
      emitDecision('deny', `forgeax hook-gate HTTP ${res.status} (fail-closed)`);
      return;
    }
    const j = await res.json();
    decision = j && typeof j.decision === 'string' ? j.decision : 'none';
    reason = j && typeof j.reason === 'string' ? j.reason : undefined;
  } catch (e) {
    emitDecision('deny', `forgeax hook-gate unreachable: ${e?.message ?? e} (fail-closed)`);
    return;
  }

  if (decision === 'deny') emitDecision('deny', reason || 'denied by forgeax settings.permissions');
  else if (decision === 'allow' && !planMode) emitDecision('allow', reason);
  // 'none'(未命中规则)/ plan 模式下的 allow → 零输出:内核默认权限流接管。
})();
