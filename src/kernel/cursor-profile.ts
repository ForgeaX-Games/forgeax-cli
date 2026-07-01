/**
 * cursor-profile — **所有 cursor-isms 的归口**(adaptor profile)。
 *
 * 设计同 codex-profile:内核 spine 必须中立。cursor 专属词汇(`-p --output-format
 * stream-json --stream-partial-output --trust --force --approve-mcps --resume` argv、
 * systemPrompt 注入方式、ndjson→KernelEvent 映射)一律锁在「本文件 + cursor-mapper.ts」,
 * `cursor-kernel.ts` 只剩薄脊梁。日后整对外迁到 `packages/kernel-adaptors/cursor`
 * 时搬这两件,spine 上的中立契约(@forgeax/agent-runtime)不动。
 *
 * cursor 执行面与 CC/codex 的关键差异(供薄脊梁理解):
 *  - 驱动:`cursor-agent -p --output-format stream-json --stream-partial-output`;
 *    会话连续靠 cursor 自己的 chat id —— 首轮无 `--resume`(cursor 隐式新建 chat 并在
 *    `system.init` 里自带 id,脊梁回填),后续 `--resume <id>`。
 *  - systemPrompt 无 flag(无 --append-system-prompt)→ 把 charter+persona 作「指令」
 *    前置进**首轮**消息(后续轮经 --resume 继承)。
 *  - headless 放行:`--trust`(headless 必需)+ `--force`(平滑基线,= acceptEdits 类比);
 *    per-tool 审批闸只有 Hooks 一个注入点(见 server 旧实现的 forgeax-cursor-hooks),
 *    本 kernel 首版按 `--force` 基线跑,审批卡 hook 作为后续单独接入(见 task 2e)。
 *  - MCP:cursor 无 --mcp-config,读 `<cwd>/.cursor/mcp.json` → `--approve-mcps` headless 信任。
 *  - 模型:cursor 的模型目录非 Claude 形(opus-4-x),Studio ModelPicker 会被 cursor 拒;
 *    故与 codex 一样**忽略 req.model**,仅认显式 `CURSOR_MODEL` env。
 *  - 用量:result.usage 只有 token,无 $ cost → turn.usage.costUsd 留空。
 *  - 无 per-tool 权限回调(走 --force / hooks)→ requestPermission 不接。
 */
import type { TurnRequest } from '@forgeax/agent-runtime';

// ndjson→KernelEvent 映射本身就是 cursor-ism;经 profile 统一再出口(spine 不直接 import mapper)。
export {
  createCursorMapperState,
  flushCursorMapper,
  mapCursorEvent,
  type CursorMapperState,
  type CursorRawEvent,
} from './cursor-mapper';

/**
 * 从中立 TurnRequest 拼 `cursor-agent -p ...` 的调用面。
 * `cursorChatId` 非空 → resume(由脊梁从上一轮 `system.init` 回填);为空 = 首轮,
 * 把 systemPrompt(charter/persona)前置进消息。
 *
 * **prompt 走 stdin,不进 argv**:首轮把整段 charter+persona+task 拼进 `message`,
 * 体量动辄上万字符。Windows 上 `cursor-agent` 经 `cursor-agent.cmd` 批处理转发,
 * `cmd.exe` 命令行硬上限 ~8191 字符 —— 把 prompt 当 argv 位置参数会撑爆它,得到
 * GBK 报错「命令行太长。」+ exit 1(被 UTF-8 误解码成乱码)。故本函数只返回**短**
 * 的 flag/resume argv,把 `message` 交给脊梁经 `spawnJsonl({ stdin })` 喂入(cursor
 * `-p` 无位置参数时从 stdin 读 prompt)。stdin 是管道、不受命令行长度限制,全平台
 * 一致(POSIX argv 本就够大,改 stdin 同样安全且更干净)。
 */
export function buildCursorArgs(
  req: TurnRequest,
  cursorChatId: string | undefined,
): { args: string[]; message: string } {
  const isFirstTurn = !cursorChatId;

  // dynamicSuffix(当轮记忆/感知)以 user 后缀拼在任务后。
  const sp = req.systemPrompt;
  const task = sp.dynamicSuffix?.trim()
    ? `${req.input.text}\n\n${sp.dynamicSuffix.trim()}`
    : req.input.text;

  // systemPrompt 注入:cursor 无 --append-system-prompt。首轮把 charter+persona
  // 作「指令」前置;后续轮经 --resume 继承,不再前置。
  let message = task;
  if (isFirstTurn) {
    const instructions = sp.persona?.trim()
      ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
      : sp.charter;
    if (instructions?.trim()) {
      message = `# Instructions\n\n${instructions.trim()}\n\n# Task\n\n${task}`;
    }
  }

  // 模型:忽略 req.model(Claude 形目录 cursor 不认),仅认显式 CURSOR_MODEL env。
  const selectedModel = process.env.CURSOR_MODEL?.trim() || '';

  // prompt 不进 argv:经 stdin 喂入(见函数注释)。argv 只剩短小的 flag/resume。
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--stream-partial-output',
    // 信任工作区(headless 必需)+ force 平滑基线;危险操作的审批卡 hook 见 task 2e。
    '--trust',
    '--force',
    // 自动信任 .cursor/mcp.json 里的 MCP server(含 forgeax host-tools),headless 不弹信任框。
    '--approve-mcps',
    ...(selectedModel ? ['--model', selectedModel] : []),
    ...(cursorChatId ? ['--resume', cursorChatId] : []),
  ];
  return { args, message };
}
