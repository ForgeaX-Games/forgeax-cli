#!/usr/bin/env node
/** forgeax cursor-agent 权限 hook(stdin/stdout,046 楔子3;承 2026-06 server 旧实现)。
 *
 *  接线:cursor-profile 在 `<workspace>/.cursor/hooks.json` 写**静态**
 *  `beforeShellExecution` / `beforeMCPExecution` 条目(cursor 无 `--hooks <path>`
 *  flag → 文件内容跨 turn 不变)。上下文经 cursor-agent 进程 env 继承
 *  (FORGEAX_SERVER_URL/FORGEAX_SID/FORGEAX_AGENT,cursor-kernel spawn 注入);
 *  argv 仅可选兜底传 PORT(⚠️ 实测 2026-06-16:cursor 无 shell 直 exec hook 命令,
 *  `VAR=val` 前缀与含 `://` 的参数都会打断解析 → 只能传裸端口号)。
 *
 *  协议(实测 cursor-agent 2026.06.15 / 复测 2026.07.09):
 *    stdin  — { command?, cwd, session_id, conversation_id, tool_name?, tool_input?, hook_event_name, ... }
 *    stdout — { permission: "allow" | "deny", agent_message? } + exit 0
 *    (exit 2 亦 deny;其余非零 fail-open —— 所以本脚本永远 exit 0 + 显式输出。)
 *
 *  行为:
 *   1) 无 forgeax 上下文(env 无 SID)→ **零输出退出**:用户在同一工作区自己跑
 *      cursor-agent 时不干预(不替用户 allow、也不把人闸死)。
 *   2) 灾难性命令(裸 root/home 抹除等)→ 本地硬 deny,不弹卡(与 settings deny 互为
 *      belt-and-braces:server 不可达时这层仍在)。
 *   3) 其余 → 同步回调 forgeax 决策端点 `/:sid/hook-gate`(settings.permissions 规则;
 *      ask 由端点弹 Studio 审批卡阻塞到用户点击):deny→deny;allow/none→allow
 *      (none = 未命中规则,cursor 内核基线本就是 `--force` 全放行,维持原语义);
 *      mcp__fxt__… / mcp__forgeax__…(host-routed)→ allow 直放(它们在 /:sid/kernel-tool
 *      的 trust-gate 把闸,不双卡)。
 *
 *  fail-closed:端点传输错误/超时 → deny(拿不到规则不能证明没有 deny 规则)。
 */

const argvPort = (process.argv[2] || '').trim();
const envUrl = (process.env.FORGEAX_SERVER_URL || '').trim().replace(/\/$/, '');
const SERVER_URL = envUrl || (argvPort ? `http://127.0.0.1:${argvPort}` : '');
const SID = (process.env.FORGEAX_SID || '').trim();
const AGENT = (process.env.FORGEAX_AGENT || '').trim() || 'forge';

// 灾难性操作:直接拒,不弹卡。只匹配**裸** root/home 抹除——`rm -rf /`、`rm -rf /*`、
// `rm -rf ~`(`/`/`~` 即整个目标:后随空白/`*`/串尾)。具体绝对路径(如
// `rm -rf /Users/you/proj/a.txt`)**不算**灾难性,交给规则/审批卡。
const CATASTROPHIC = /\b(dd|mkfs\w*|shred)\b|\brm\s+-rf\s+[/~](\s|\*|$)|\bsudo\s+rm\b/;

function emit(permission, agentMessage) {
  const out = { permission };
  if (agentMessage) out.agent_message = agentMessage;
  process.stdout.write(JSON.stringify(out) + '\n');
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
  // 1) 无 forgeax 上下文 → 不干预(用户自己的 cursor 运行,零行为变化)。
  if (!SERVER_URL || !SID) return;

  let payload = {};
  try { payload = JSON.parse((await readStdin()).trim() || '{}'); } catch { payload = {}; }

  const event = payload.hook_event_name || '';
  const isMcp = event === 'beforeMCPExecution';
  const toolName = isMcp ? (typeof payload.tool_name === 'string' && payload.tool_name ? payload.tool_name : 'mcp') : 'Bash';
  const command = typeof payload.command === 'string' ? payload.command : '';

  // host-routed 工具在 /:sid/kernel-tool 的 trust-gate 把闸 → 这里直放,不双卡。
  if (isMcp && (toolName.startsWith('mcp__fxt__') || toolName.startsWith('mcp__forgeax__') || toolName.startsWith('fxt__'))) {
    emit('allow');
    return;
  }

  // 2) 灾难性命令:本地硬 deny(server 不可达时这层兜底仍在)。
  if (command && CATASTROPHIC.test(command)) {
    emit('deny', 'forgeax: 该命令被安全策略直接拒绝(灾难性操作)');
    return;
  }

  // 3) 规则决策(ask 由端点弹卡阻塞)。
  const input = payload.tool_input ?? (command ? { command, cwd: payload.cwd } : {});
  try {
    const res = await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(SID)}/hook-gate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kernel: 'cursor', agent: AGENT, toolName, input }),
      signal: AbortSignal.timeout(9.5 * 60_000),
    });
    if (!res.ok) {
      emit('deny', `forgeax hook-gate HTTP ${res.status} (fail-closed)`);
      return;
    }
    const j = await res.json();
    const decision = j && typeof j.decision === 'string' ? j.decision : 'none';
    if (decision === 'deny') emit('deny', (j && j.reason) || 'forgeax: denied by settings.permissions');
    else emit('allow'); // allow / none:cursor 基线 --force 本就全放行。
  } catch (e) {
    emit('deny', `forgeax hook-gate unreachable: ${e?.message ?? e} (fail-closed)`);
  }
})();
