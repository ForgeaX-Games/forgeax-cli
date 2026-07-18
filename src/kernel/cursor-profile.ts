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
 *  - 模型:Studio ModelPicker 在 cursor-agent 下读取 driver-scoped catalog
 *    (`cursor-agent --list-models`),选中值经中立 `TurnRequest.model` 传到 `--model`。
 *  - 用量:result.usage 只有 token,无 $ cost → turn.usage.costUsd 留空。
 *  - 无 per-tool 权限回调(走 --force / hooks)→ requestPermission 不接。
 */
import type { KernelModelInfo, TurnRequest } from '@forgeax/agent-runtime';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveBinary } from '../cli-providers/shared/resolve-binary';
import { runCapture } from '../lib/node-spawn';

// ─── 模型目录(cursor-isms) ──────────────────────────────────────────
// cursor 是四个 rented 内核里唯一有平坦 list 命令的(`cursor-agent
// --list-models`);spawn/解析都是 cursor-ism,归口本文件,由
// {@link CursorKernel.listModels} 消费(与 cc/cbc/codex 统一走 listModels)。

export const CURSOR_DRIVER_LABEL = 'cursor-agent · subscription runtime · no local cost';

/** 内核作者声明的静态兜底(探测 + last-known 都失败时的最后一层,非平台猜测)。 */
export const CURSOR_FALLBACK_MODELS = [
  'gpt-5.5-medium',
  'gpt-5.1-codex-max-medium',
  'claude-opus-4-8-thinking-high',
  'claude-sonnet-4-6-thinking',
];

/** `--list-models` stdout 行解析:剥 bullet/序号,取首 token + 可选
 *  ` - 描述` / `(current|default)` 注记,滤表头噪声词。描述作 label。 */
export function parseCursorModelList(stdout: string): KernelModelInfo[] {
  const seen = new Map<string, KernelModelInfo>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[*\-•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '');
    if (!line) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\s+-\s+(.*?))?(?:\s+\((?:current|default)\))?\s*$/i);
    const id = match?.[1]?.trim();
    if (!id) continue;
    if (/^(available|models?|model|current|default|name)$/i.test(id)) continue;
    if (seen.has(id)) continue;
    const label = match?.[2]?.trim();
    seen.set(id, { id, ...(label && label !== id ? { label } : {}) });
  }
  return [...seen.values()];
}

/** 真实获取:spawn `cursor-agent --list-models`(binary 解析与 chat 路径同源:
 *  CURSOR_CLI_PATH → PATH)。失败抛错,由编排层回退链降级。 */
export async function probeCursorModels(timeoutMs = 5000): Promise<KernelModelInfo[]> {
  const binary = await resolveBinary({
    envVarName: 'CURSOR_CLI_PATH',
    defaultBinary: 'cursor-agent',
  });
  const out = await runCapture(binary, ['--list-models'], { timeoutMs, captureStderr: true });
  if (out.code !== 0) {
    const detail = (out.stderr || out.stdout).trim();
    throw new Error(`cursor-agent --list-models exit ${out.code ?? 'spawn-failed'}${detail ? `: ${detail}` : ''}`);
  }
  const models = parseCursorModelList(out.stdout);
  if (models.length === 0) {
    throw new Error('cursor-agent --list-models returned no parseable model ids');
  }
  return models;
}

// ndjson→KernelEvent 映射本身就是 cursor-ism;经 profile 统一再出口(spine 不直接 import mapper)。
export {
  createCursorMapperState,
  flushCursorMapper,
  mapCursorEvent,
  type CursorMapperState,
  type CursorRawEvent,
} from './cursor-mapper';

// ─── settings.permissions 拦截面(046 楔子3 = 曾标注的 task 2e) ──────────
// cursor headless 只有两个内置模式:default(自动**拒**一切需审批操作,agent 废了)
// 或 `--force`(全放行 fail-open)。唯一 per-command 审批注入点 = Hooks:
// `<workspace>/.cursor/hooks.json` 的 `beforeShellExecution`/`beforeMCPExecution`
// 阻塞 hook,stdout `{permission:"allow"|"deny"}` 被尊重(实测 2026-06-16 于
// cursor-agent 2026.06.15,复测 2026-07-14 于 2026.07.09:deny 强制生效)。
// 所以维持 `--force` 平滑基线 + 叠加本 hook:cursor-permission-hook.mjs 同步回调
// forgeax `/:sid/hook-gate`(settings 规则求值;ask 弹 Studio 审批卡;none→allow
// 维持 --force 原语义)。cursor 无 `--hooks <path>` flag → 文件静态,上下文
// (FORGEAX_SERVER_URL/FORGEAX_SID/FORGEAX_AGENT)经 cursor-agent 进程 env 继承
// (per-turn spawn,注入安全);用户自跑 cursor 无 FORGEAX env → hook 零干预。
// ⚠️ cursor 无 shell 直 exec hook 命令:`VAR=` 前缀与含 `://` 参数都会打断解析
// (2026-06-16 实测)→ 命令串只含双引号路径,不带 env 前缀/URL 参数。

/** hooks.json 归属标记:命中才允许覆盖(不吃掉用户自己的 hooks.json)。 */
const CURSOR_HOOKS_MARKER = 'cursor-permission-hook.mjs';

/**
 * 确保 `<projectRoot>/.cursor/hooks.json` 是 forgeax 权限 hook 配置(幂等覆盖)。
 * 返回是否生效:已有**非 forgeax** 的 hooks.json → 不覆盖、返回 false(诚实降级:
 * 该工作区维持纯 --force 基线,无规则拦截面);写失败同样 false。
 */
export function ensureCursorHooksConfig(projectRoot: string): boolean {
  try {
    const dir = resolvePath(projectRoot, '.cursor');
    const path = resolvePath(dir, 'hooks.json');
    const script = resolvePath(import.meta.dirname, 'hooks/cursor-permission-hook.mjs');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
    const next = JSON.stringify(
      {
        version: 1,
        hooks: {
          beforeShellExecution: [{ command: cmd }],
          beforeMCPExecution: [{ command: cmd }],
        },
      },
      null,
      2,
    );
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (!raw.includes(CURSOR_HOOKS_MARKER)) return false; // 用户自己的 hooks.json,不动
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

  // 模型:ADR-0020 要求退役 CURSOR_MODEL env 特例,统一走 TurnRequest.model。
  const selectedModel = req.model?.trim() || '';

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
