/**
 * cc-profile — **所有 Claude-Code-isms 的归口**(adaptor profile)。
 *
 * 设计 R4(B2):内核 spine 必须中立——CC 专属词汇(argv flags、permission-mode
 * 枚举、stop-reason 映射、MCP-isms、stream-json wire→KernelEvent 映射)一律锁在
 * 本文件里,`claude-code-kernel.ts` 只剩一根薄脊梁去调用它们。日后整包外迁到
 * `packages/kernel-adaptors/claude-code` 时,搬的就是「本文件 + claude-code-kernel.ts」
 * 这一对,spine 上的中立类型(@forgeax/agent-runtime)不动。
 *
 * 锁在这里的 CC-isms:
 *  - {@link buildCcArgs}      `-p / --output-format stream-json / --permission-mode /
 *                              --session-id|--resume / --model / --append-system-prompt`
 *  - {@link buildMcpArgs}     `--mcp-config / --permission-prompt-tool / --allowedTools`
 *  - {@link toCcPermissionMode} 中立 PermissionMode → CC 的 permission-mode 枚举
 *  - {@link chatEventToKernel} wire ChatEvent → 中立 KernelEvent
 *  - {@link wireStopToKernel}  CC stop-reason → 中立 TurnDoneReason
 *  - {@link ccSessionExists}   CC on-disk session 探测(决定 resume vs 新建)
 */
import type {
  KernelEvent,
  KernelModelInfo,
  PermissionCall,
  PermissionDecision,
  PermissionMode,
  TurnDoneReason,
  TurnRequest,
} from '@forgeax/agent-runtime';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import type { ChatEvent } from '../cli-providers/types';
import { defaultProjectRoot } from '@forgeax/platform-io';

const SERVER_PORT = process.env.FORGEAX_SERVER_PORT ?? '18900';

// ─── 模型目录(CC-isms) ──────────────────────────────────────────────
// 真实通道 = stream-json 控制协议:`<binary> -p --input-format stream-json
// --output-format stream-json --verbose` 起进程后发 `initialize` control_request,
// 响应里的 `models` 就是 TUI `/model` 展示的同一份列表(CLI 内部按订阅/企业配置/
// env 现算,无独立 list 子命令,SDK 的 getAvailableModels 也走这条)。零 LLM 调用。
// cbc 是 cc 近同源分叉,同协议直接复用({@link probeStreamJsonModels})。
// 下方静态表只是回退链最后一层兜底(探测 + last-known 都失败时)。

export const CLAUDE_CODE_DRIVER_LABEL = 'claude-code · subscription runtime · no local cost';

export const CLAUDE_CODE_FALLBACK_MODELS = [
  'opus',
  'sonnet',
  'claude-opus-4-8',
  'claude-sonnet-5',
  'claude-4.6-sonnet-medium',
];

/** initialize 响应里的单个模型条目。cc 用 `value/displayName/description`,
 *  cbc(分叉)用 `id/name` —— 两种拼写都接。 */
interface StreamJsonModelRow {
  id?: string;
  value?: string;
  name?: string;
  displayName?: string;
  description?: string;
}

/**
 * 经 stream-json 控制面向 CLI 要真实模型目录(cc 与 cbc 共用)。
 *
 * 安全:initialize 响应还带 `account`(内含登录 token)—— 本函数**只取
 * models 数组**,其余字段一律丢弃,绝不落盘/打日志(last-known 持久化的
 * 是本函数返回的裁剪结果,不含 account)。
 *
 * 生命周期:拿到响应或超时即 SIGTERM;stdin 保持打开(部分版本收到 EOF
 * 会在应答前退出,由 kill 统一收口)。
 */
export function probeStreamJsonModels(binary: string, timeoutMs = 15000): Promise<KernelModelInfo[]> {
  return new Promise((resolve, reject) => {
    const reqId = `fx-models-${Date.now().toString(36)}`;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err as Error);
      return;
    }

    let buf = '';
    let stderrTail = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `${binary} stream-json initialize timed out after ${timeoutMs}ms${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`,
      )));
    }, timeoutMs);

    child.on('error', (err) => finish(() => reject(err)));
    child.on('exit', (code) => {
      finish(() => reject(new Error(
        `${binary} exited (code=${code}) before answering initialize${stderrTail ? `: ${stderrTail.slice(-300)}` : ''}`,
      )));
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => { stderrTail = (stderrTail + c).slice(-2000); });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: StreamJsonModelRow[] }; error?: string } };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type !== 'control_response' || msg.response?.request_id !== reqId) continue;
        if (msg.response.subtype !== 'success') {
          finish(() => reject(new Error(`initialize control_response error: ${msg.response?.error ?? 'unknown'}`)));
          return;
        }
        const rows = Array.isArray(msg.response.response?.models) ? msg.response.response.models : [];
        const models: KernelModelInfo[] = rows
          .map((m) => {
            const id = (m.id ?? m.value ?? '').trim();
            if (!id) return null;
            const label = (m.name ?? m.displayName ?? '').trim();
            return { id, ...(label && label !== id ? { label } : {}) };
          })
          .filter((m): m is KernelModelInfo => m !== null);
        finish(() => resolve(models));
        return;
      }
    });

    child.stdin?.on('error', () => { /* EPIPE — finish 已统一收口 */ });
    child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: reqId, request: { subtype: 'initialize' } }) + '\n');
  });
}

// ─── per-turn permission gate registry(B-4) ────────────────────────────
//
// 现状(honest):headless CC 的权限闭环是**跨进程**的——spawn 出的
// `mcp/permission-server.mjs`(permission-prompt 工具)在 CLI 要权限时 HTTP 调
// `POST /:sid/permission-request`(在 `api/sessions.ts`),那里弹审批卡 + 阻塞等
// 用户点「允许/拒绝」。中立的 `TurnRequest.requestPermission` 闸**此前从未被消费**
// (compose-turn-request.ts 也没填它)。
//
// 这里把缺口补到「我这一侧能补的最深」:CC 内核 runTurn 时,若编排层提供了
// `req.requestPermission`,就经 {@link registerTurnGate} 把它登记进这个 in-process
// 单进程 Map(键=真实 sid)。跨文件那一步**已接线**:`/:sid/permission-request`
// 处理器(api/sessions.ts)进卡前先 {@link consultTurnGate} 咨询本闸——命中(allow/
// deny)直接回执,免去弹卡;未命中(无内核闸/非内核路径)再回落到现有「弹卡 + 阻塞」。
// 至此「编排层 checkTool/requestPermission 成为 CC 内核唯一闸」闭合。接线由
// `turn-gate.test.ts` 的回归守卫钉住(防再次被静默删)。
//
// 单进程 Bun 安全;一个 sid 同时只跑一轮 turn,故按 sid 键足够(与
// permission-registry 的 owner.sid 同口径)。

const _turnGates = new Map<
  string,
  (call: PermissionCall) => Promise<PermissionDecision>
>();

/** 登记本轮的中立权限闸(键=真实 sid)。返回是否真的登记了(sid 非空且有 gate)。 */
export function registerTurnGate(
  sid: string,
  gate: (call: PermissionCall) => Promise<PermissionDecision>,
): boolean {
  if (!sid) return false;
  _turnGates.set(sid, gate);
  return true;
}

/** 释放某 sid 的权限闸(turn 结束/中断时调用,幂等)。 */
export function releaseTurnGate(sid: string): void {
  if (sid) _turnGates.delete(sid);
}

/** 供权限回执端(api/sessions.ts 的 /:sid/permission-request)优先咨询的入口:
 *  命中则返回中立 {@link PermissionDecision},未命中返回 undefined(回落弹卡)。
 *  尚未在该 HTTP 端接线时本函数无人调用 = 现有行为不变(诚实标注的剩余深度)。 */
export async function consultTurnGate(
  sid: string,
  call: PermissionCall,
): Promise<PermissionDecision | undefined> {
  const gate = _turnGates.get(sid);
  if (!gate) return undefined;
  try {
    return await gate(call);
  } catch (e) {
    // fail closed:闸抛错 → deny(绝不静默放行)。
    return { behavior: 'deny', message: `permission gate error: ${(e as Error).message}` };
  }
}

/** CC headless 的 `--permission-mode` 取值枚举(CC-ism,只活在 profile 里)。 */
export type CcPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * 中立 {@link PermissionMode} → CC `--permission-mode` 枚举(B2:spine 不出现 CC 词汇)。
 *   gated        → 'default'           每个工具都走闸
 *   autoEdits    → 'acceptEdits'       自动放行编辑
 *   planning     → 'plan'              只规划不执行
 *   unrestricted → 'bypassPermissions' 绕过闸
 */
export function toCcPermissionMode(mode: PermissionMode): CcPermissionMode {
  switch (mode) {
    case 'gated':
      return 'default';
    case 'autoEdits':
      return 'acceptEdits';
    case 'planning':
      return 'plan';
    case 'unrestricted':
      return 'bypassPermissions';
  }
}

/** 默认 permission-mode:headless 下走 MCP permission-prompt(见 buildMcpArgs),
 *  其余工具沿用旧基线 acceptEdits(= 中立 'autoEdits')兜底。 */
const DEFAULT_CC_PERMISSION_MODE: CcPermissionMode = 'acceptEdits';

/** session 续接策略:UUID threadId 首次 `--session-id`,后续 `--resume`。
 *  返回 argv 片段 + 是否「已起过/磁盘已有」(供调用方记入 startedThreadIds)。 */
export function buildSessionArgs(
  tid: string | undefined,
  projectRoot: string,
  startedThreadIds: ReadonlySet<string>,
): { args: string[]; threadId?: string } {
  const t = tid?.trim();
  if (!t || !/^[0-9a-f-]{36}$/i.test(t)) return { args: [] };
  if (startedThreadIds.has(t) || ccSessionExists(projectRoot, t)) {
    return { args: ['--resume', t], threadId: t };
  }
  return { args: ['--session-id', t], threadId: t };
}

/**
 * systemPrompt 注入 argv:把组合好的 charter(+persona)**写临时文件**,按 `mode` 取 flag——
 *   - replace → `--system-prompt-file <path>`(完全替换内核默认 prompt)
 *   - append/缺省 → `--append-system-prompt-file <path>`(保留默认身份,追加)
 * 走 file 变体而非 inline 的理由:charter+分层记忆可能很长,inline 进 argv 有长度上限风险。
 * 临时文件写失败 → 降级回 inline `--append-system-prompt <text>`(不崩、不静默丢身份)。
 */
function buildSystemPromptArgs(text: string, mode: 'append' | 'replace', key: string): string[] {
  try {
    const path = resolvePath(tmpdir(), `forgeax-kernel-sysprompt-${key}.txt`);
    writeFileSync(path, text);
    return mode === 'replace'
      ? ['--system-prompt-file', path]
      : ['--append-system-prompt-file', path];
  } catch {
    // 降级:replace 也只能退回 append inline(headless 无其它替换通道),诚实标注。
    return ['--append-system-prompt', text];
  }
}

/**
 * 工具面策略 argv(中立 toolPolicy → CC `--tools` / `--disallowedTools`)。
 *   - allow → `--tools a,b,c`(限制**内置**工具的独占白名单;CC 收逗号分隔单值)
 *   - deny  → `--disallowedTools a b …`(从模型上下文移除;CC 变长数组)
 * 名字 opaque 透传(spine 不解释,见 contract)。缺省 ⇒ 返回空 ⇒ 今日行为不变。
 * 调用方必须把本片段放在**会被后续 `--flag` 终止**的位置(见 buildCcArgs 排序注释),
 * 否则变长 `--disallowedTools` 会吞掉尾随的位置参数 message。
 */
function buildToolPolicyArgs(policy: TurnRequest['toolPolicy']): string[] {
  if (!policy) return [];
  const out: string[] = [];
  const allow = policy.allow?.filter((t) => typeof t === 'string' && t.trim());
  if (allow && allow.length) out.push('--tools', allow.join(','));
  const deny = policy.deny?.filter((t) => typeof t === 'string' && t.trim());
  if (deny && deny.length) out.push('--disallowedTools', ...deny);
  return out;
}

/** 预算硬闸 argv:`--max-turns`(agentic 轮数上限)+ `--max-budget-usd`(本次 spawn 花费上限)。
 *  来自中立 `req.budget`(maxTurns/maxBudgetUsd)。缺省 ⇒ 空 ⇒ 无上限(今日行为)。
 *  注:这是 claude **原生**轮数/预算闸,与 sidecar cred-vault 的跨进程预算熔断(R3-05)互补。 */
function buildBudgetArgs(budget: TurnRequest['budget']): string[] {
  const out: string[] = [];
  if (typeof budget?.maxTurns === 'number' && budget.maxTurns > 0) out.push('--max-turns', String(budget.maxTurns));
  if (typeof budget?.maxBudgetUsd === 'number' && budget.maxBudgetUsd > 0) out.push('--max-budget-usd', String(budget.maxBudgetUsd));
  return out;
}

/** 模型级联回退 argv:`--fallback-model a,b`(主模型过载/退役时按序回退)。opaque 透传。 */
function buildFallbackArgs(models: TurnRequest['fallbackModels']): string[] {
  const list = models?.filter((m) => typeof m === 'string' && m.trim());
  return list && list.length ? ['--fallback-model', list.join(',')] : [];
}

/**
 * hermetic 隔离 argv —— **仅 `trustTier === 'imported'`**(不可信 pack)启用:
 *   - `--strict-mcp-config`   只用本进程 `--mcp-config`(forgeax perm/fxt),忽略 operator 全局/项目 MCP。
 *   - `--setting-sources ''`  不加载 operator 的 user/project/local settings、CLAUDE.md、hooks/skills/plugins。
 * 编排层已用 composeTurnRequest 全权组装身份+工具,imported claude 不该再继承宿主机配置(防漂移/泄漏)。
 * own/builtin(forge)**不启用**(可信 + 需要 operator 完整环境)→ 零回归。env-scrub + cred-proxy
 * 是凭据层,本片段补**配置层**,共同构成 imported 沙箱。`--setting-sources ''` 真二进制接受 = 加载零来源。
 */
function buildHermeticArgs(trustTier: TurnRequest['trustTier']): string[] {
  return trustTier === 'imported' ? ['--strict-mcp-config', '--setting-sources', ''] : [];
}

/**
 * settings.permissions 拦截面 argv(046 楔子3):把一个只含 `hooks.PreToolUse` 的
 * settings JSON 写临时文件,`--settings <path>` 注入 —— hook 命令同步回调 forgeax
 * 决策端点(`/:sid/hook-gate`,settings 规则求值;ask 弹 Studio 审批卡阻塞)。
 * 这补上 CC **内置**工具(Bash/Write/Edit…在 CC 子进程内自执行)的拦截缺口——
 * 尤其 acceptEdits 基线下文件编辑不过 permission-prompt 的盲区(墙B)。
 * 实测 2026-07-14:`--settings` 注入的 PreToolUse 在 headless `-p` 下真触发、deny 强制。
 *
 * 上下文全经 argv(port/sid/agent;跨平台,不依赖 shell env 前缀)。timeout 600s
 * (>= 端点弹卡的 10min server 侧超时的大头;hook 脚本自留 9.5min fetch 上限先超)。
 * 写失败 → 返回空(降级:无 hook 拦截面,tier 闸 + permission-prompt 基线仍在,不崩)。
 *
 * ⚠️ imported 的 `--setting-sources ''` 只裁 user/project/local 三源,`--settings`
 * flag 是独立源 —— 但两者叠加行为未实测,imported 路径按 best-effort 标注。
 */
function buildHookSettingsArgs(realSid: string, agentId: string, key: string): string[] {
  if (!realSid) return [];
  try {
    const script = resolvePath(import.meta.dirname, 'hooks/kernel-permission-hook.mjs');
    const cmd = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${SERVER_PORT} ${realSid} ${agentId} claude-code`;
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 600 }] }],
      },
    };
    const path = resolvePath(tmpdir(), `forgeax-kernel-hook-settings-${key}.json`);
    writeFileSync(path, JSON.stringify(settings));
    return ['--settings', path];
  } catch {
    return []; // 降级:无规则拦截面(诚实少一层,不假装有)。
  }
}

/**
 * 从中立 TurnRequest 拼 `claude -p` argv(systemPrompt 来自编排层 composeTurnRequest)。
 * `permissionMode` 缺省时用 {@link DEFAULT_CC_PERMISSION_MODE};传入则覆盖
 * (经 {@link toCcPermissionMode} 由中立模式翻译而来)。
 */
export function buildCcArgs(
  req: TurnRequest,
  projectRoot: string,
  sessionArgs: string[],
  permissionMode: CcPermissionMode = DEFAULT_CC_PERMISSION_MODE,
): string[] {
  const sp = req.systemPrompt;
  const systemPrompt = sp.persona?.trim()
    ? `${sp.charter}\n\n---\n\n## Persona\n\n${sp.persona.trim()}`
    : sp.charter;

  // MCP:权限闸(permission-prompt → forgeax MCP)+ 编排层声明的工具(fxt server)。
  const tid = req.session.threadId?.trim();
  const mcpArgs = buildMcpArgs(req, tid || '');

  // 工具面策略(--tools/--disallowedTools)。放在 mcpArgs 之后、systemPromptArgs 之前——
  // systemPromptArgs 必以 `--*-system-prompt*` flag 打头,稳妥终止变长 `--disallowedTools`,
  // 避免吞掉末尾位置参数 message。
  const toolPolicyArgs = buildToolPolicyArgs(req.toolPolicy);

  // hermetic 隔离(仅 imported)+ 预算硬闸 + 模型级联回退。
  const hermeticArgs = buildHermeticArgs(req.trustTier);
  const budgetArgs = buildBudgetArgs(req.budget);
  const fallbackArgs = buildFallbackArgs(req.fallbackModels);

  // systemPrompt 经临时文件(replace/append),写失败降级 inline。key 求稳定+不串台。
  const spKey = req.hostSessionId?.trim() || tid || req.session.agentId?.trim() || 'x';
  const systemPromptArgs = buildSystemPromptArgs(systemPrompt, sp.mode ?? 'append', spKey);

  // settings.permissions 拦截面(046 楔子3):PreToolUse hook 回调 forgeax 决策端点。
  const realSid = req.hostSessionId?.trim() || tid || '';
  const hookSettingsArgs = buildHookSettingsArgs(realSid, req.session.agentId?.trim() || 'forge', spKey);

  // 用户消息(dynamicSuffix 以 user 后缀注入,不进 system prompt)。
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
    ...hookSettingsArgs,
    ...mcpArgs,
    ...toolPolicyArgs,
    ...budgetArgs,
    ...fallbackArgs,
    ...(req.model ? ['--model', req.model] : []),
    ...sessionArgs,
    ...systemPromptArgs,
    message,
  ];
}

/** 是否已有该 thread 的 on-disk session 文件(决定 resume vs 新建,重启安全)。 */
export function ccSessionExists(cwd: string, tid: string): boolean {
  try {
    // CC encodes the project cwd into its on-disk dir name by replacing path
    // punctuation with '-'. Must cover Windows separators/drive too (`\` and
    // `:`), else e.g. `C:\Users\me\proj` → wrong dir, the probe misses an
    // existing session, and the next turn re-issues `--session-id` → CC errors
    // "Session ID … is already in use". Matches CC: `C:\Users\…` → `C--Users-…`.
    const encoded = cwd.replace(/[/\\.:]/g, '-');
    return existsSync(resolvePath(homedir(), '.claude', 'projects', encoded, `${tid}.jsonl`));
  } catch {
    return false;
  }
}

/** 组合 MCP 配置 + 权限/放行 flags:
 *   - permission server `forgeax`(有 sid 时)→ `--permission-prompt-tool mcp__forgeax__approve`
 *   - 工具 server `fxt`(编排层声明了工具时)→ `--allowedTools mcp__fxt__<tool>...`(权限归编排层)
 *  无任何 server → 返回空(靠 permission-mode 兜底)。 */
export function buildMcpArgs(req: TurnRequest, permSid: string): string[] {
  const mcpServers: Record<string, unknown> = {};
  const flags: string[] = [];

  if (permSid) {
    // 权限卡必须路由到**真实 sid**(UI 监听的 sid),而非合成的 threadId(permSid=uuidv5)——
    // 否则 /api/sessions/<uuid>/permission-request 命不中任何 session → 一律 deny,Bash 等需审批
    // 的工具在内核模式下全废(ship-gate 闸#2 parity 真缺口)。hostSessionId = compose 透传的真 sid。
    const realSid = req.hostSessionId?.trim() || permSid;
    mcpServers.forgeax = {
      command: process.execPath,
      args: [resolvePath(import.meta.dirname, '../cli-providers/mcp/permission-server.mjs')],
      env: {
        FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
        FORGEAX_SID: realSid,
        FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
      },
    };
    flags.push('--permission-prompt-tool', 'mcp__forgeax__approve');
  }

  if (req.tools.length > 0) {
    const env: Record<string, string> = {
      FORGEAX_PROJECT_ROOT: defaultProjectRoot(),
      // FORGEAX_SOUL_AGENT 让 memory_search 定位该 soul 的分层记忆库。
      FORGEAX_SOUL_AGENT: req.session.agentId?.trim() || 'default',
      // 回调基址 + 真实 sid + agentPath:**始终下发**——除 host-tool 桥外,内置感知
      // 工具(query_world/capture_frame)也要 HTTP 回打 /:sid/perception-query。
      // threadId 已是合成 UUID,故定位活 agent / session 用 hostSessionId。
      FORGEAX_SERVER_URL: `http://127.0.0.1:${SERVER_PORT}`,
      FORGEAX_SID: req.hostSessionId?.trim() || permSid,
      FORGEAX_AGENT: req.session.agentId?.trim() || 'forge',
    };

    // T-A host-tool 桥:非内置工具经 MCP→HTTP 回调宿主执行。把它们的规格写临时文件
    // 给 fxt server(内置工具 = echo/list_games/memory_search/remember/query_world/capture_frame
    // 在 mcp server 内本地处理,不走 host-tool 桥)。
    const BUILTIN_FXT = new Set(['echo', 'list_games', 'memory_search', 'remember', 'query_world', 'capture_frame']);
    const bridged = req.tools.filter((t) => !BUILTIN_FXT.has(t.name));
    if (bridged.length > 0) {
      try {
        const specsPath = resolvePath(tmpdir(), `forgeax-kernel-tools-${permSid || req.session.agentId || 'x'}.json`);
        writeFileSync(specsPath, JSON.stringify(bridged));
        env.FORGEAX_TOOL_SPECS_FILE = specsPath;
      } catch {
        /* specs 写失败 → 只暴露内置工具(降级,不崩) */
      }
    }

    mcpServers.fxt = {
      command: process.execPath,
      args: [resolvePath(import.meta.dirname, 'mcp/forgeax-tools-server.mjs')],
      env,
    };
    // 编排层显式放行声明的工具 → headless 不卡审批(= 权限归编排层)。
    // `--allowedTools <tools...>` 是变长:每个工具名作为独立 argv 展开。
    flags.push('--allowedTools', ...req.tools.map((t) => `mcp__fxt__${t.name}`));
  }

  if (Object.keys(mcpServers).length === 0) return [];
  try {
    const cfgPath = resolvePath(tmpdir(), `forgeax-kernel-mcp-${permSid || req.session.agentId || 'x'}.json`);
    writeFileSync(cfgPath, JSON.stringify({ mcpServers }));
    return ['--mcp-config', cfgPath, ...flags];
  } catch {
    return [];
  }
}

/** wire ChatEvent(claude stream-json 经 mapClaudeEvent 后)→ 中立 KernelEvent。 */
export function* chatEventToKernel(ev: ChatEvent): Generator<KernelEvent> {
  switch (ev.type) {
    case 'token':
      yield { kind: 'message.delta', role: 'assistant', text: ev.text };
      return;
    case 'thinking':
      yield { kind: 'thinking.delta', text: ev.text };
      return;
    case 'tool-call':
      yield { kind: 'tool.call', callId: ev.callId, name: ev.name, args: ev.args };
      return;
    case 'tool-call-delta':
      yield { kind: 'tool.call.delta', callId: ev.callId, name: ev.name, argsDelta: ev.argumentsDelta };
      return;
    case 'tool-result':
      yield { kind: 'tool.result', callId: ev.callId, ok: ev.ok, result: ev.result, error: ev.error };
      return;
    case 'done':
      yield {
        kind: 'turn.usage',
        inputTokens: ev.usage?.inputTokens,
        outputTokens: ev.usage?.outputTokens,
        cacheRead: ev.usage?.cacheReadTokens,
        cacheCreation: ev.usage?.cacheCreationTokens,
        costUsd: ev.cost,
        durationMs: ev.durationMs,
      };
      yield { kind: 'turn.done', reason: wireStopToKernel(ev.stopReason) };
      return;
    case 'error':
      yield { kind: 'turn.usage' };
      yield { kind: 'error', error: { code: 'protocol', message: ev.message } };
      yield { kind: 'turn.done', reason: 'error' };
      return;
    case 'stored-event':
      yield { kind: 'stored-event', payload: ev.storedEvent };
      return;
  }
}

/** CC stop-reason → 中立 TurnDoneReason。 */
export function wireStopToKernel(s: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled'): TurnDoneReason {
  switch (s) {
    case 'end_turn': return 'stop';
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'max_tokens';
    case 'cancelled': return 'cancelled';
  }
}
