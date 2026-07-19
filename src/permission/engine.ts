/**
 * Permission engine (PERM) — 固定决策顺序的把闸。
 *
 * 固定决策顺序的权限把闸(本契约无 classifier/auto-mode/headless
 * 那一层,只取规则+工具+模式+safetyCheck 的核心把闸):
 *
 *   ① deny rule        → deny
 *   ② ask rule         → ask
 *   ③ tool.checkPermissions → 若 deny 直接 deny(catch:异常 fail-closed)
 *   ④ tool.requiresUserInteraction?  —— 本 C2 契约无此字段,留 hook 占位(跳过)
 *   ⑤ safetyCheck(.git/ / .forgeax/ / shell config 路径)→ ask(**bypass 免疫**)
 *   ⑥ bypass mode      → allow
 *   ⑦ always-allow rule→ allow
 *   ⑧ passthrough      → 转 ask
 *
 * CWE-22 路径硬化(validateTargetPath,T3)横切在两处:file 工具目标路径
 *   - **deny**(NUL/控制字符 / write-glob,永不合法)置于 ① 之前,规则也压不过;
 *   - **强制 ask**(写规范化后逃出 cwd)与 ⑤ safetyCheck 同层(bypass/acceptEdits/allow
 *     免疫),但排在 ①deny/②ask/③tool-deny 之后 —— 真 deny 仍先行。
 *
 * fail-closed:任何异常/不确定 → 更严(deny/ask)。非 deny/ask/allow 的越界值
 * 当 passthrough 处理(最终落到 ask)。
 *
 * 规则子集模式只跑 ①②⑤——给「hook allow 不绕过 settings deny/ask、也不绕过
 * safetyCheck」用(纯规则把闸路径)。
 *
 * Boundary: 只 import C2 契约 + node:。
 */
import type {
  AgentTool,
  PermissionBehavior,
  PermissionResult,
  ToolContext,
} from '../capability/types';
import { relative as pathRelative, resolve as pathResolve } from 'node:path';
import { matchRule, normalizeRules, type PermissionRule, type PermissionRuleSet } from './rules';
import { validateTargetPath, type PathVerdict } from './path-validation';

/**
 * 按工具的 **name + aliases** 逐一匹配规则(alias 归一)。用户按 CC 习惯写
 * `Bash(rm *)` / `Write`,而 core 工具真实 name 是 `bash` / `write_file`(alias 才是
 * `Bash` / `Write`)。只按 tool.name 匹配会让声明式 deny/ask 形同虚设(E-02)。
 */
function matchToolRule<I>(
  rules: ReadonlyArray<PermissionRule>,
  tool: AgentTool<I>,
  input: unknown,
): PermissionRule | undefined {
  const names = [tool.name, ...(tool.aliases ?? [])];
  for (const n of names) {
    const m = matchRule(rules, n, input);
    if (m) return m;
  }
  return undefined;
}

/** 权限模式(工具权限上下文 mode 的相关子集 + plan/acceptEdits)。
 *  - default          :标准 8 步把闸。
 *  - acceptEdits      :edit/write 系工具自动放行(safetyCheck 仍先行);其余走 default。
 *  - plan             :只读强制——非只读工具(ExitPlanMode 例外)直接 deny。
 *  - bypassPermissions:绕闸(deny rule / safetyCheck 仍免疫)。 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** engine 决策上下文外的运行选项(模式 + 规则)。host 注入。 */
export interface PermissionOptions {
  mode?: PermissionMode;
  /** 是否启用 core 内置的受保护路径 safetyCheck(.git/.forgeax/shell-rc)。
   *  **默认 false** —— core 不默认做路径限制,权限策略归 host(serve/Studio 靠 host
   *  侧 checkKernelTool 把闸)。CLI 独立形态可显式开,保护本机敏感目录。 */
  enableSafetyCheck?: boolean;
}

const SAFETY_CHECK_REASON =
  'This path is protected and requires explicit approval even in bypass mode.';

/** 受保护路径片段:`.git/` / `.forgeax/` / shell rc / 敏感配置(写前安全检查
 *  集合)。命中即 ask 且 bypass 免疫。`.gitconfig` / `.mcp.json` 与 shell rc 同层
 *  (srt 禁写清单邻域,SSOT);`.git/hooks/` 已被 `.git` 段覆盖。 */
const PROTECTED_FILE_BASENAMES = new Set<string>([
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  '.config/fish/config.fish',
  'config.fish',
  '.gitconfig',
  '.mcp.json',
]);

/** 从工具 input 抽出可能写入的目标路径(用于 safetyCheck)。 */
function extractTargetPath(input: unknown): string | undefined {
  if (input == null || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const candidate = obj.file_path ?? obj.path ?? obj.filePath ?? obj.notebook_path;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * target 解析后是否落在 cwd 内(E-06 acceptEdits 边界)。纯字符串层(node:path.resolve
 * 不触磁盘):相对路径按 cwd 解析,`..` 逃逸 / 绝对越界 → 落在 cwd 外。symlink 不解析
 * (保守:与 safetyCheck 同款不触盘,注明局限)。cwd 自身(rel==='')视为内。 */
function isWithinCwd(target: string, cwd: string): boolean {
  const rel = pathRelative(pathResolve(cwd), pathResolve(cwd, target));
  return rel === '' || !rel.startsWith('..');
}

/** 路径是否落在受保护目录/文件。纯字符串判定(不触磁盘):
 *  - 含 `/.git/` 或以 `.git/` 开头或正是 `.git`;
 *  - 含 `/.forgeax/` 或以 `.forgeax/` 开头或正是 `.forgeax`;
 *  - basename 命中 shell 配置文件。 */
/** 受保护目录段(任意路径深度命中即保护)。SSOT:safetyCheck 与 OS 沙箱
 *  (cli/sandbox-terminal.ts)共用,避免两处各自硬编码 `.git`/`.forgeax`。 */
export const PROTECTED_DIR_SEGMENTS = ['.git', '.forgeax'] as const;

export function isProtectedPath(path: string): boolean {
  const norm = path.replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  if (PROTECTED_DIR_SEGMENTS.some((s) => segments.includes(s))) return true;
  const base = segments.length > 0 ? segments[segments.length - 1] : norm;
  if (PROTECTED_FILE_BASENAMES.has(base)) return true;
  // fish 的嵌套形式 .config/fish/config.fish
  if (norm.endsWith('.config/fish/config.fish')) return true;
  return false;
}

/** ⑤ safetyCheck:命中受保护路径 → ask(bypass 免疫)。否则 undefined。 */
function safetyCheck(input: unknown): PermissionResult | undefined {
  const target = extractTargetPath(input);
  if (target === undefined) return undefined;
  if (isProtectedPath(target)) {
    return {
      behavior: 'ask',
      message: SAFETY_CHECK_REASON,
      decisionReason: { type: 'safetyCheck', path: target },
    };
  }
  return undefined;
}

// ─── plan / acceptEdits 模式辅助 ─────────────────────────────────────────────

/** ExitPlanMode 工具名/别名集合(plan 模式下唯一可调的非只读工具——但其声明 isReadOnly
 *  =true,这里仅作显式豁免兜底,防别名命名差异)。 */
const EXIT_PLAN_TOOL_NAMES = new Set<string>(['ExitPlanMode', 'exit_plan_mode']);

/** edit/write 系工具名集合(acceptEdits 自动放行)。含 builtin name + 别名。 */
const EDIT_TOOL_NAMES = new Set<string>([
  'write_file',
  'edit_file',
  'notebook_edit',
  'Write',
  'Edit',
  'NotebookEdit',
  'MultiEdit',
]);

/** 安全读取 tool.isReadOnly(input):抛错 → false(非只读 → plan 下被 deny,fail-closed)。 */
export function safeReadOnly<I>(tool: AgentTool<I>, input: I): boolean {
  try {
    return tool.isReadOnly(input) === true;
  } catch {
    return false;
  }
}

/** 是否 ExitPlanMode 工具(按 name / alias 匹配)。 */
export function isExitPlanTool(name: string): boolean {
  return EXIT_PLAN_TOOL_NAMES.has(name);
}

/** 是否 edit/write 系工具:按 name 命中 EDIT_TOOL_NAMES,或工具自声明 isDestructive(input)===true。
 *  isDestructive 抛错 → 视作非 edit(保守,不自动放行)。 */
export function isEditTool<I>(tool: AgentTool<I>, input: I): boolean {
  if (EDIT_TOOL_NAMES.has(tool.name)) return true;
  if (tool.aliases?.some((a) => EDIT_TOOL_NAMES.has(a))) return true;
  if (tool.isDestructive) {
    try {
      return tool.isDestructive(input) === true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * CWE-22 硬化(T3):对 file 工具目标路径做两档校验。非 file 工具(抽不出路径)→
 * undefined。op 由 edit 工具判定为 `write`(cwd confine + write-glob),其余 `read`
 * (仅查控制字符)。cwd 取 ctx.cwd(host 注入),缺省 process.cwd()。纯函数,不触盘
 * 于常态(见 path-validation.ts)。
 */
function pathHardeningVerdict<I>(tool: AgentTool<I>, input: I, ctx: ToolContext): PathVerdict | undefined {
  const target = extractTargetPath(input);
  if (target === undefined) return undefined;
  const op = isEditTool(tool, input) ? 'write' : 'read';
  const cwdRaw = (ctx as { cwd?: unknown }).cwd;
  const cwd = typeof cwdRaw === 'string' ? cwdRaw : process.cwd();
  return validateTargetPath(target, op, cwd);
}

/** validateTargetPath verdict → PermissionResult(deny/ask 共用形状,decisionReason
 *  带 pathValidation 判别 + scope,便于 host 观测与 e2e 断言)。 */
function pathVerdictToResult(v: Extract<PathVerdict, { verdict: 'deny' | 'ask' }>): PermissionResult {
  return {
    behavior: v.verdict === 'deny' ? 'deny' : 'ask',
    message: v.reason,
    decisionReason: { type: 'pathValidation', scope: v.scope },
  };
}

function denyByRule(toolName: string, ruleSource?: string): PermissionResult {
  return {
    behavior: 'deny',
    message: `Permission to use ${toolName} has been denied.`,
    decisionReason: { type: 'rule', ruleBehavior: 'deny', source: ruleSource },
  };
}

function askByRule(toolName: string, ruleSource?: string): PermissionResult {
  return {
    behavior: 'ask',
    message: `Permission rule requires approval for this ${toolName} command.`,
    decisionReason: { type: 'rule', ruleBehavior: 'ask', source: ruleSource },
  };
}

function getUpdatedInputOrFallback(result: PermissionResult | undefined, input: unknown): unknown {
  return result?.updatedInput ?? input;
}

/**
 * 只跑规则子集 ①②⑤(deny rule / ask rule / safetyCheck)+ ③ 的 deny 分支。
 * 用于「hook allow 不绕过 settings deny/ask/safetyCheck」:返回 deny/ask =
 * 有规则反对,null = 规则层无异议(调用方可放行)。
 *
 * 不跑 bypass / always-allow / passthrough→ask(纯规则把闸)。
 * fail-closed:tool.checkPermissions 抛错 → 吞掉(规则层只关心 deny),由
 * 完整 hasPermissionsToUseTool 在 ③ 兜底。
 */
export async function checkRuleBasedPermissions<I>(
  tool: AgentTool<I>,
  input: I,
  ctx: ToolContext,
  rules?: Partial<PermissionRuleSet> | null,
  enableSafetyCheck = false,
): Promise<PermissionResult | null> {
  const ruleSet = normalizeRules(rules);

  // ⓿ CWE-22 path hardening — deny(NUL/控制字符/write-glob)先于所有规则(永不合法)。
  const pathV = pathHardeningVerdict(tool, input, ctx);
  if (pathV?.verdict === 'deny') return pathVerdictToResult(pathV);

  // ① deny rule
  const deny = matchToolRule(ruleSet.deny, tool, input);
  if (deny) return denyByRule(tool.name, deny.source);

  // ② ask rule
  const ask = matchToolRule(ruleSet.ask, tool, input);
  if (ask) return askByRule(tool.name, ask.source);

  // ③ tool.checkPermissions —— 只取 deny 分支(content-specific deny)
  let toolResult: PermissionResult | undefined;
  try {
    toolResult = await tool.checkPermissions(input, ctx);
  } catch {
    // 规则子集层吞异常(deny 优先级已过);完整把闸会再 fail-closed。
    toolResult = undefined;
  }
  if (toolResult?.behavior === 'deny') return toolResult;

  // ⑤ safetyCheck(bypass 免疫;**仅 enableSafetyCheck 开时跑,默认关** —— core 不默认限路径)
  if (enableSafetyCheck) {
    const safety = safetyCheck(input);
    if (safety) return safety;
  }

  // ⓿b CWE-22 强制 ask(写逃出 cwd)——即便走 hook-allow 子集也不放行,routes 到 askUser。
  if (pathV?.verdict === 'ask') return pathVerdictToResult(pathV);

  // 规则层无异议
  return null;
}

/**
 * 完整把闸:固定决策顺序 ①…⑧。返回最终 PermissionResult。
 *
 * fail-closed 不变量:
 *   - tool.checkPermissions 抛错 → 不放行,降级为 ask(更严)。
 *   - 越界 behavior(非 allow/deny/ask)→ 当 passthrough → ask。
 */
export async function hasPermissionsToUseTool<I>(
  tool: AgentTool<I>,
  input: I,
  ctx: ToolContext,
  rules?: Partial<PermissionRuleSet> | null,
  options?: PermissionOptions,
): Promise<PermissionResult> {
  const ruleSet = normalizeRules(rules);
  const mode: PermissionMode = options?.mode ?? 'default';

  // ⓿ CWE-22 path hardening(T3):file 工具目标路径两档校验。
  //   - deny(NUL/控制字符/write-glob)先于 ① deny rule —— 永不合法,规则也压不过。
  //   - ask(写逃出 cwd)holdback,注入在 ⑤ safetyCheck 同层(bypass/acceptEdits/allow 免疫)。
  const pathV = pathHardeningVerdict(tool, input, ctx);
  if (pathV?.verdict === 'deny') return pathVerdictToResult(pathV);

  // ① deny rule → deny
  const deny = matchToolRule(ruleSet.deny, tool, input);
  if (deny) return denyByRule(tool.name, deny.source);

  // ② ask rule → ask
  const ask = matchToolRule(ruleSet.ask, tool, input);
  if (ask) return askByRule(tool.name, ask.source);

  // ②.5 plan 模式:只读强制——非只读工具(ExitPlanMode 例外)直接 deny。
  //   置于 ask rule 之后、tool.checkPermissions 之前:deny rule(①)仍先行,故显式
  //   deny 在 plan 下依然优先;fail-closed(safeReadOnly 抛错 → 非只读 → deny)。
  if (mode === 'plan' && !isExitPlanTool(tool.name) && !safeReadOnly(tool, input)) {
    return {
      behavior: 'deny',
      message: 'In plan mode, only read-only tools are allowed.',
      decisionReason: { type: 'mode', mode: 'plan' },
    };
  }

  // ③ tool.checkPermissions
  let toolResult: PermissionResult;
  try {
    toolResult = await tool.checkPermissions(input, ctx);
  } catch (e) {
    // fail-closed:工具校验抛错 → 不放行,转 ask(让用户裁决)。
    return {
      behavior: 'ask',
      message: `Permission check for ${tool.name} failed; manual approval required.`,
      decisionReason: {
        type: 'other',
        reason: e instanceof Error ? e.message : String(e),
      },
    };
  }
  // 防御:工具返回非法形状 → 当 passthrough(最终 ask)。
  if (!toolResult || typeof toolResult.behavior !== 'string') {
    toolResult = { behavior: 'passthrough' };
  }
  //  ③ deny 直接 deny
  if (toolResult.behavior === 'deny') return toolResult;

  // ④ tool.requiresUserInteraction?  —— 本 C2 契约无此字段。留 hook 占位:
  //    若未来契约补回,此处应在 ask 时直接返回(bypass 免疫)。当前跳过。

  // content-specific ask rule(由 tool.checkPermissions 给出,带 rule/ask 来源)
  // —— 这类 ask 在 bypass 下仍生效。
  if (
    toolResult.behavior === 'ask' &&
    toolResult.decisionReason?.type === 'rule' &&
    (toolResult.decisionReason as { ruleBehavior?: string }).ruleBehavior === 'ask'
  ) {
    return toolResult;
  }

  // ⑤ safetyCheck → ask(bypass 免疫)。工具自身的 safetyCheck-ask 也在此免疫(不受开关影响,
  //    那是工具自决,非 core 硬编码黑名单)。
  if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type === 'safetyCheck') {
    return toolResult;
  }
  // core 内置受保护路径检查 **默认关**(enableSafetyCheck 显式开才跑);默认权限策略归 host。
  if (options?.enableSafetyCheck) {
    const safety = safetyCheck(input);
    if (safety) return safety;
  }

  // ⓿b CWE-22 强制 ask(写逃出 cwd)——与 safetyCheck 同层:排在 acceptEdits/bypass/allow
  //   之前,即便 settings 配了 `allow:["Write"]` / acceptEdits / bypass 也压不掉,保留用户
  //   批准通道(写 /tmp 合法,已在 validateTargetPath 内豁免 os.tmpdir())。
  if (pathV?.verdict === 'ask') return pathVerdictToResult(pathV);

  // ⑤.5 acceptEdits 模式:edit/write 系工具自动放行,但**仅限 cwd 内**(E-06)。
  //   safetyCheck 已先行(受保护路径仍 ask);目标落在 cwd 外(绝对越界 / `..` 逃逸)
  //   或抽不出路径 → 不自动放行,回落 default(继续往下 → 最终 ask)。心智对齐
  //   「自动接受**本项目**的编辑」。cwd 取 ctx.cwd(host 注入),缺省 process.cwd()。
  if (mode === 'acceptEdits' && isEditTool(tool, input)) {
    const target = extractTargetPath(input);
    const cwdRaw = (ctx as { cwd?: unknown }).cwd;
    const cwd = typeof cwdRaw === 'string' ? cwdRaw : process.cwd();
    if (target !== undefined && isWithinCwd(target, cwd)) {
      return {
        behavior: 'allow',
        updatedInput: getUpdatedInputOrFallback(toolResult, input),
        decisionReason: { type: 'mode', mode: 'acceptEdits', scope: 'in-cwd' },
      };
    }
    // cwd 外 / 无法抽出路径:acceptEdits 的自动放行**不覆盖项目外的写**——显式 ask
    //   (edit 工具自身 checkPermissions 多为 allow,若在此回落会被 ⑧ 直接放行,失去边界)。
    return {
      behavior: 'ask',
      message: `acceptEdits auto-approves edits only inside the working directory; "${tool.name}" targets a path outside it — approval required.`,
      decisionReason: { type: 'mode', mode: 'acceptEdits', scope: 'out-of-cwd' },
    };
  }

  // ⑥ bypass mode → allow(到这里 deny / ask-rule / safetyCheck 都已放过)
  if (mode === 'bypassPermissions') {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolResult, input),
      decisionReason: { type: 'mode', mode },
    };
  }

  // ⑦ always-allow rule → allow
  const allow = matchToolRule(ruleSet.allow, tool, input);
  if (allow) {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolResult, input),
      decisionReason: { type: 'rule', ruleBehavior: 'allow', source: allow.source },
    };
  }

  // ⑧ passthrough(或任何遗留越界值)→ 转 ask;allow 原样放行。
  if (toolResult.behavior === 'allow') {
    return {
      behavior: 'allow',
      updatedInput: getUpdatedInputOrFallback(toolResult, input),
      decisionReason: toolResult.decisionReason ?? { type: 'tool' },
    };
  }
  if (toolResult.behavior === 'ask') {
    return toolResult;
  }
  // passthrough / 越界 → ask
  return {
    behavior: 'ask',
    message:
      toolResult.message ??
      `The agent requested permission to use ${tool.name}, but it has not been granted.`,
    decisionReason: toolResult.decisionReason ?? { type: 'passthrough' },
  };
}

export type { PermissionBehavior, PermissionResult };
