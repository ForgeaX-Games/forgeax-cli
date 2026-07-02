/**
 * cbc-profile — **所有 a peer agent CLI-Code-isms 的归口**(adaptor profile)。
 *
 * a peer agent CLI Code(二进制 `codebuddy`,别名 `cbc`)是 the reference agent CLI 的近同源分叉:
 * stream-json 线格式、`--mcp-config` / `--allowedTools` / `--session-id|-r` /
 * `--system-prompt-file` / `--append-system-prompt` / `--permission-mode` /
 * `--strict-mcp-config` / `--setting-sources` / `--max-turns` / `--fallback-model`
 * 全部对齐 cc。**因此本 profile 复用 cc-profile 的稳定件**(线事件映射、权限闸
 * registry、permission-mode 枚举翻译),只重写「cbc 真正不同」的三处:
 *
 *  1. **缺 `--permission-prompt-tool`** —— cbc(2.57)无此 flag。headless 权限闭环
 *     退化为纯 `--permission-mode` + `--allowedTools`(host-tool 已显式放行);
 *     不再下发 forgeax permission MCP server(它只经 `--permission-prompt-tool` 消费)。
 *  2. **缺 `--append-system-prompt-file`** —— cbc 只有 inline `--append-system-prompt`
 *     与 `--system-prompt-file`(replace)。故 append 模式走 inline,replace 走 file。
 *  3. **缺 `--max-budget-usd`** —— cbc 只有 `--max-turns`,预算 USD 闸略过。
 *  4. **始终 `--strict-mcp-config`**(cc 仅 imported 时)—— cbc 默认加载用户个人全局
 *     `~/.codebuddy` MCP server(tapd/bkm-log 等远程 server),初始化会卡死 cbc 输出流
 *     (30s no-data 超时);forgeax agent 工具已由 fxt 显式声明,故只用 fxt、忽略全局。
 *     见 {@link buildCbcHermeticArgs}。
 *
 * 另外 session 落盘目录是 `~/.codebuddy/projects/<enc>/<sid>.jsonl`,且编码**保留点号**
 * (cc 把点号也替成 `-`,cbc 不替)——见 {@link cbcSessionExists}。
 *
 * 日后整包外迁到 `packages/kernel-adaptors/codebuddy` 时,搬「本文件 + cbc-kernel.ts」。
 */
import type { TurnRequest } from '@forgeax/agent-runtime';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';
// 复用 cc-profile 的稳定件(cbc 与 cc 完全一致):线事件→KernelEvent 映射、
// permission-mode 枚举翻译、跨进程权限闸 registry。单一来源,避免 drift。
import {
  toCcPermissionMode,
  type CcPermissionMode,
} from './cc-profile';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';

/** cbc `--permission-mode` 取值枚举(与 cc 同:default/acceptEdits/plan/bypassPermissions)。 */
export type CbcPermissionMode = CcPermissionMode;

/** 中立 PermissionMode → cbc `--permission-mode`(枚举与 cc 一致,直接复用翻译)。 */
export const toCbcPermissionMode = toCcPermissionMode;

/**
 * 模型 id 方言翻译:forgeax 用**连字符**版本号(`claude-opus-4-8`,可带 `[1m]`),
 * 而 cbc 只认**点号**版本号(`claude-opus-4.8` / 长上下文 `claude-opus-4.8-1m`)。
 * 不翻译会被 cbc 以 `400 model [claude-opus-4-8] service info not found` 拒掉 →
 * 整轮 `error_during_execution`(这是 UI 上「发消息卡住/报错」的真因)。
 *   - `claude-opus-4-8`      → `claude-opus-4.8`
 *   - `claude-opus-4-8[1m]`  → `claude-opus-4.8-1m`
 *   - 非 claude(gpt-5.5 / gemini-3.1-pro …)cbc 本就用点号/原样,直接透传。
 * 返回 undefined ⇒ 不下发 `--model`,cbc 用账户默认(亦可用)。
 */
export function toCbcModel(m?: string): string | undefined {
  const t = m?.trim();
  if (!t) return undefined;
  const oneM = /\[1m\]/i.test(t) || /-1m$/i.test(t);
  let base = t.replace(/\[1m\]/gi, '').replace(/-1m$/i, '').trim();
  // claude 家族:把版本号里的 `<digit>-<digit>` 连字符改成点号(只第一处版本段)。
  if (/^claude-/i.test(base)) base = base.replace(/(\d)-(\d)/, '$1.$2');
  return oneM ? `${base}-1m` : base;
}

/** 默认 permission-mode:headless cbc 无 permission-prompt-tool,沿用 cc 基线 acceptEdits
 *  (自动放行编辑;host-tool 经 `--allowedTools` 显式放行,不卡审批)。 */
const DEFAULT_CBC_PERMISSION_MODE: CbcPermissionMode = 'acceptEdits';

/** 是否已有该 thread 的 cbc on-disk session 文件(决定 resume vs 新建,重启安全)。
 *  cbc 编码:去掉前导 `/`、把 `/` 换 `-`、**保留点号**(与 cc 的 `[/.]→-` 不同)。 */
export function cbcSessionExists(cwd: string, tid: string): boolean {
  try {
    const encoded = cwd.replace(/^\/+/, '').replace(/\//g, '-');
    return existsSync(resolvePath(homedir(), '.codebuddy', 'projects', encoded, `${tid}.jsonl`));
  } catch {
    return false;
  }
}

/** session 续接:UUID threadId 首次 `--session-id`,后续(本进程起过/磁盘已有)`-r`。 */
export function buildCbcSessionArgs(
  tid: string | undefined,
  projectRoot: string,
  startedThreadIds: ReadonlySet<string>,
): { args: string[]; threadId?: string } {
  const t = tid?.trim();
  if (!t || !/^[0-9a-f-]{36}$/i.test(t)) return { args: [] };
  if (startedThreadIds.has(t) || cbcSessionExists(projectRoot, t)) {
    return { args: ['--resume', t], threadId: t };
  }
  return { args: ['--session-id', t], threadId: t };
}

/**
 * systemPrompt 注入 argv:
 *   - replace → `--system-prompt-file <path>`(完全替换内核默认 prompt)
 *   - append/缺省 → cbc 无 `--append-system-prompt-file`,故走 inline `--append-system-prompt <text>`
 * replace 走 file 是因 charter 可能很长(argv 长度上限);写文件失败 → 降级 inline。
 *
 * **Windows 例外(append 模式)**:cbc 在 Windows 经 `codebuddy.cmd` 启动 → 走 cmd.exe,
 * 命令行硬上限 ~8191 字符。forgeax 的 charter(+persona)通常 ~20KB+,inline
 * `--append-system-prompt <text>` 必然溢出 → cbc 退出码 1、stderr「命令行太长」。
 * cbc 又**没有** `--append-system-prompt-file`(只有 `--system-prompt-file`,见 `--help`),
 * 故 Windows 上 append 只能改走 `--system-prompt-file`(=replace 语义):用 charter 作为
 * 完整 system prompt、不再追加在 cbc 内置之后。tool 定义仍由 API 注入,charter 本身是
 * 完整操作手册,可独立成 prompt。POSIX(含 macOS)的 ARG_MAX ~256KB–2MB,inline 不溢出,
 * **保持原 append 行为不变**。 */
function buildCbcSystemPromptArgs(text: string, mode: 'append' | 'replace', key: string): string[] {
  const writeToFile = (): string[] | null => {
    try {
      const path = resolvePath(tmpdir(), `forgeax-cbc-sysprompt-${key}.txt`);
      writeFileSync(path, text);
      return ['--system-prompt-file', path];
    } catch {
      return null;
    }
  };
  if (mode === 'replace') {
    // replace 写盘失败 → cbc 无其它替换通道,退回 inline append(诚实降级,不静默丢身份)。
    return writeToFile() ?? ['--append-system-prompt', text];
  }
  // append on Windows → cmd.exe 命令行上限,大 charter inline 会溢出 → 改走 file(replace 语义)。
  if (process.platform === 'win32') {
    const fileArgs = writeToFile();
    if (fileArgs) return fileArgs;
  }
  return ['--append-system-prompt', text];
}

/** 工具面策略 argv(中立 toolPolicy → cbc `--tools` / `--disallowedTools`,与 cc 一致)。 */
function buildCbcToolPolicyArgs(policy: TurnRequest['toolPolicy']): string[] {
  if (!policy) return [];
  const out: string[] = [];
  const allow = policy.allow?.filter((t) => typeof t === 'string' && t.trim());
  if (allow && allow.length) out.push('--tools', allow.join(','));
  const deny = policy.deny?.filter((t) => typeof t === 'string' && t.trim());
  if (deny && deny.length) out.push('--disallowedTools', ...deny);
  return out;
}

/** 预算硬闸 argv:cbc 只有 `--max-turns`(无 `--max-budget-usd`)。 */
function buildCbcBudgetArgs(budget: TurnRequest['budget']): string[] {
  return typeof budget?.maxTurns === 'number' && budget.maxTurns > 0
    ? ['--max-turns', String(budget.maxTurns)]
    : [];
}

/** 模型级联回退 argv:`--fallback-model a,b`(与 cc 一致,opaque 透传)。 */
function buildCbcFallbackArgs(models: TurnRequest['fallbackModels']): string[] {
  const list = models?.filter((m) => typeof m === 'string' && m.trim());
  return list && list.length ? ['--fallback-model', list.join(',')] : [];
}

/**
 * 隔离 argv。
 *
 * **`--strict-mcp-config` 对 cbc 始终启用**(与 cc 不同):cbc 默认会加载用户**个人全局**
 * `~/.codebuddy/.mcp.json` 里的 MCP server(tapd / bkm-log / qq-mail / context7 等)——这些
 * 是用户自己的 cbc 工具,与 forgeax 游戏开发无关,且多为**远程/需鉴权**的 server,初始化会
 * 阻塞 cbc 的输出流,实测触发 `error_during_execution: no data received for 30000ms`(UI 上
 * 表现为「FORGE thinking · 30s」卡死)。forgeax agent 的工具已由编排层 composeTurnRequest
 * 经 fxt `--mcp-config` **显式声明**,故 cbc 只该用 fxt、忽略用户全局 MCP。无 fxt 工具时
 * `--strict-mcp-config` 等于「零 MCP」,亦正确。
 *
 * `--setting-sources ''`(切断 operator 的 user/project settings + CLAUDE.md + hooks)仅
 * `imported`(不可信 pack)叠加;`own`/`builtin`(forge)保留以继承必要的项目配置。
 */
function buildCbcHermeticArgs(trustTier: TurnRequest['trustTier']): string[] {
  const out = ['--strict-mcp-config'];
  if (trustTier === 'imported') out.push('--setting-sources', '');
  return out;
}

/**
 * 组合 MCP 配置 + 放行 flags(cbc 版):**不含** forgeax permission server ——
 * cbc 无 `--permission-prompt-tool`,该 server 无从消费,故省略;权限退化为
 * `--permission-mode` + 下方 `--allowedTools`(host-tool 显式放行)。
 * 仅当编排层声明了工具时,下发 fxt 工具 server + `--allowedTools`。
 */
export function buildCbcMcpArgs(req: TurnRequest, permSid: string): string[] {
  // 关掉 cbc 的感知工具(query_world / capture_frame):cbc 基线上下文 ~56k(cc 仅 ~2.8k)
  // 且 MCP 工具被 ToolSearch 延迟加载,agent 反射式调 query_world 再等不可用的预览,会把
  // 多次 model 往返叠成 60-90s「卡死」感。cbc 去掉感知后单轮闲聊 ~1-2 次往返即收尾;
  // cc / forgeax-core 基线轻,保留全套感知(见 forgeax-tools-server.mjs 的 env 闸)。
  const PERCEPTION = new Set(['query_world', 'capture_frame']);
  const tools = req.tools.filter((t) => !PERCEPTION.has(t.name));
  if (tools.length === 0) return [];

  const env: Record<string, string> = {
    FORGEAX_PROJECT_ROOT: defaultProjectRoot(),
    FORGEAX_SOUL_AGENT: req.session.agentId?.trim() || 'default',
    FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
    FORGEAX_SID: req.hostSessionId?.trim() || permSid,
    FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
    // 让 fxt server 也从 tools/list 里剔除感知工具(双保险:模型既看不到也调不动)。
    FORGEAX_DISABLE_PERCEPTION: '1',
  };

  // host-tool 桥:非内置工具经 MCP→HTTP 回调宿主执行(内置工具在 mcp server 内本地处理)。
  const BUILTIN_FXT = new Set(['echo', 'list_games', 'memory_search', 'remember', 'query_world', 'capture_frame']);
  const bridged = tools.filter((t) => !BUILTIN_FXT.has(t.name));
  if (bridged.length > 0) {
    try {
      const specsPath = resolvePath(tmpdir(), `forgeax-cbc-tools-${permSid || req.session.agentId || 'x'}.json`);
      writeFileSync(specsPath, JSON.stringify(bridged));
      env.FORGEAX_TOOL_SPECS_FILE = specsPath;
    } catch {
      /* specs 写失败 → 只暴露内置工具(降级,不崩) */
    }
  }

  const mcpServers = {
    fxt: {
      command: process.execPath,
      args: [resolvePath(import.meta.dirname, 'mcp/forgeax-tools-server.mjs')],
      env,
    },
  };

  try {
    const cfgPath = resolvePath(tmpdir(), `forgeax-cbc-mcp-${permSid || req.session.agentId || 'x'}.json`);
    writeFileSync(cfgPath, JSON.stringify({ mcpServers }));
    // 编排层显式放行声明的工具 → headless 不卡审批(= 权限归编排层)。感知工具已剔除。
    return ['--mcp-config', cfgPath, '--allowedTools', ...tools.map((t) => `mcp__fxt__${t.name}`)];
  } catch {
    return [];
  }
}

/**
 * 从中立 TurnRequest 拼 `codebuddy -p` argv(cbc 方言)。
 * 结构对齐 cc-profile 的 buildCcArgs,差异仅在上述三处(MCP/systemPrompt/budget)。
 */
export function buildCbcArgs(
  req: TurnRequest,
  _projectRoot: string,
  sessionArgs: string[],
  permissionMode: CbcPermissionMode = DEFAULT_CBC_PERMISSION_MODE,
): string[] {
  const sp = req.systemPrompt;
  const systemPrompt = sp.persona?.trim()
    ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
    : sp.charter;

  const tid = req.session.threadId?.trim();
  const mcpArgs = buildCbcMcpArgs(req, tid || '');
  const toolPolicyArgs = buildCbcToolPolicyArgs(req.toolPolicy);
  // 始终 --strict-mcp-config(忽略用户全局 ~/.codebuddy MCP,防 30s 流超时卡死);imported 再叠 --setting-sources ''。
  const hermeticArgs = buildCbcHermeticArgs(req.trustTier);
  const budgetArgs = buildCbcBudgetArgs(req.budget);
  const fallbackArgs = buildCbcFallbackArgs(req.fallbackModels);

  const spKey = req.hostSessionId?.trim() || tid || req.session.agentId?.trim() || 'x';
  const systemPromptArgs = buildCbcSystemPromptArgs(systemPrompt, sp.mode ?? 'append', spKey);

  const message = sp.dynamicSuffix?.trim()
    ? `${req.input.text}\n\n${sp.dynamicSuffix.trim()}`
    : req.input.text;

  return [
    '-p',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', permissionMode,
    ...hermeticArgs,
    ...mcpArgs,
    ...toolPolicyArgs,
    ...budgetArgs,
    ...fallbackArgs,
    ...((): string[] => { const m = toCbcModel(req.model); return m ? ['--model', m] : []; })(),
    ...sessionArgs,
    ...systemPromptArgs,
    message,
  ];
}

// 线事件映射(stream-json → KernelEvent)cbc 与 cc 完全一致:从 cc-profile 复用,
// 单一来源避免 drift。re-export 给 cbc-kernel 用,保持「kernel 只 import 自己的 profile」。
export { chatEventToKernel, wireStopToKernel } from './cc-profile';
