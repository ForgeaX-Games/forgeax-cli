/**
 * 信任闸(T-D 三档 allow/ask/deny)—— host-tool 桥回调 endpoint 的权限唯一闸口。
 *
 * 规格演进:
 *   - 一期:二档(own=full / imported=硬 deny 危险集)。
 *   - 二期:per-capability —— 工具名 → `Capability` → 按 trustTier 查策略表。
 *   - **三期(本次)**:引入 **`ask` 档**(交互式审批)。危险操作不再"静默放行/静默拒绝",
 *     而是弹权限卡问用户(由 host 选择点 host-tool-bridge / `:sid/kernel-tool` 落地,
 *     复用 permission-registry 往返;命中本会话 remember 则免卡)。
 *
 * 能力策略(三档):
 *   - `own`(builtin/forge):读/写/编辑/委派/**exec/network 直放**(写代码 + 跑 shell/curl
 *     是 Forge 主循环,本机用户主动发起,不打断);**只有 `{credential, delete}` → `ask`**
 *     (读密钥/token/env、显式删除工具需确认)。破坏性操作另由 charter prompt 约束。
 *   - `imported`(marketplace/用户导入):**只**读/委派 **直放**;`credential` **硬 deny**(绝不给不可信
 *     pack 真凭据);`{exec, network}` → `ask`;`{write, delete}` 走 R2-08 游戏目录作用域:
 *     **目录内 → `ask`、目录外 → `deny`**;**其余一切(含未命名分类 `other`)→ fail-closed `deny`**
 *     —— 不可信 pack 上叫不出名字的工具没资格静默放行(R2-09)。
 *
 * R2-08 写/删作用域:目标路径解析进当前激活游戏目录 `.forgeax/games/<slug>/` 之内才在沙箱内;
 * 拿不到路径/projectRoot ⇒ fail-closed(deny)。
 *
 * 权威 = agent 的 trustTier(由 R6 `loadAgentRecord` 按**加载路径**定,非 pack 自报);
 * endpoint 自行求 trustTier,**不信子进程上报**。fail-closed:未知/不确定 → 更严(deny/imported)。
 *
 * 向后兼容:`TrustDecision.allow` 保留(`true` 当且仅当 `outcome==='allow'`);旧调用方只看
 * `.allow` 时,`ask`/`deny` 都落到 `allow:false`(fail-closed),不会误放行。新调用方读
 * `.outcome` 区分三档以触发弹卡。
 */
import { resolve, sep } from 'node:path';
import type { TrustTier } from '@forgeax/agent-runtime';

/** 工具能力分类。`delete` 从 `write` 拆出(own 写直放、但删文件要确认)。 */
export type Capability = 'read' | 'write' | 'delete' | 'exec' | 'network' | 'credential' | 'delegate' | 'other';

/** 闸口三档结局。 */
export type GateOutcome = 'allow' | 'ask' | 'deny';

/** 各能力的判定子串(小写、子串匹配)。顺序敏感:危险能力
 *  (credential/exec/network/delegate/delete)先于 write/read 判定,
 *  这样 `get_secret` 命中 credential 而非 read、`delete_file` 命中 delete 而非 write。 */
const CAPABILITY_SUBSTRINGS: ReadonlyArray<readonly [Capability, readonly string[]]> = [
  ['credential', ['secret', 'credential', 'api_key', 'apikey', 'token', 'env']],
  [
    'exec',
    ['bash', 'shell', 'sh', 'exec', 'run_command', 'runcommand', 'command', 'spawn', 'process', 'terminal', 'eval'],
  ],
  ['network', ['fetch', 'http', 'curl', 'request', 'webhook']],
  ['delegate', ['delegate_to_subagent', 'list_subagents', 'list_agents']],
  ['delete', ['delete', 'rmdir', 'unlink', 'remove', 'destroy']],
  ['write', ['write', 'edit', 'multi_edit', 'apply_patch', 'rm', 'create', 'mkdir', 'move', 'rename']],
  ['read', ['read', 'glob', 'grep', 'list', 'get', 'search', 'inspect', 'status', 'view', 'cat']],
];

/** 把工具名分类到一个 `Capability`(小写子串匹配,顺序敏感)。未命中 → other。 */
export function classifyTool(toolName: string): Capability {
  const n = toolName.toLowerCase();
  for (const [cap, subs] of CAPABILITY_SUBSTRINGS) {
    if (subs.some((s) => n.includes(s))) return cap;
  }
  return 'other';
}

/** per-tier「弹卡确认」能力集(可放行,但要问用户)。
 *  own(你自己的 Forge/内置 agent,按可信路径加载):只对**真正危险**的 `credential`(读
 *    密钥/token/env)与 `delete`(显式删除工具)弹卡;`exec`(shell)/`network`(curl/fetch)
 *    **直放不打断** —— 本机、用户主动发起的建游戏流程里 shell/curl(如 build-verify 打本机
 *    forgeax API)是高频且非危险操作,逐条弹卡反而把整轮反复掐停。破坏性操作由 charter
 *    「禁删目录/rm -rf/清空 .forgeax」prompt 约束 + delete/credential 这两道卡兜底。
 *  imported(marketplace/用户导入,不可信):exec/network 仍须弹卡确认。 */
const TIER_ASK: Record<TrustTier, ReadonlySet<Capability>> = {
  own: new Set<Capability>(['credential', 'delete']),
  imported: new Set<Capability>(['exec', 'network']),
};

/** per-tier「硬拒」能力集(不可放行)。own 无硬拒;imported 永不交真凭据。 */
const TIER_DENY: Record<TrustTier, ReadonlySet<Capability>> = {
  own: new Set<Capability>(),
  imported: new Set<Capability>(['credential']),
};

/** per-tier「直放」能力集(经前面各档过滤后仍可静默放行的能力)。
 *  own:自己的可信 agent,除 ask 集外其余(读/写/编辑/exec/network/委派/other)全直放 → `null` 表通配。
 *  imported:不可信 pack,**只**显式信任 `read`/`delegate`;凡不在此集、又未被前面分支处理的
 *    能力(尤其 `other` 这类叫不出名字的工具)→ **弹卡交人判断(ask)**,而非静默放行(R2-09:
 *    不可信工具默认不直放)。选 ask 不选 deny:deny 无回退路径(无发卡 / 无 remember / 无 per-tool
 *    allowlist,唯一"解"是把整包升 own,代价过大),ask 把否决权交还用户且支持本会话 remember
 *    (§8 人为最终权威 / §9 优雅降级)。凭据(硬 deny)与作用域外写删(deny)等真危险已在前档拦死。
 *    `delegate` 原语实际由 ALWAYS_ALLOW 提前短路,列于此处仅为「读表即知 imported 信任面」的 SSOT。 */
const TIER_ALLOW: Record<TrustTier, ReadonlySet<Capability> | null> = {
  own: null,
  imported: new Set<Capability>(['read', 'delegate']),
};

/** 走 R2-08 游戏目录作用域判定的能力(imported 专属:目录内→ask,目录外→deny)。 */
const SCOPED_CAPS: ReadonlySet<Capability> = new Set<Capability>(['write', 'delete']);

/** 委派/编排原语:始终放行(即便 imported)——它们是编排面,本身不触达危险能力,
 *  危险面由**被委派子 agent 自己的** trustTier 在其调用时再行限流。显式 allowlist 也
 *  防止将来调能力策略时误伤。 */
const ALWAYS_ALLOW = new Set(['delegate_to_subagent', 'list_subagents', 'list_agents']);

export interface TrustDecision {
  /** 向后兼容:`true` 当且仅当 `outcome==='allow'`。旧调用方只看此字段时 ask/deny 均 fail-closed。 */
  allow: boolean;
  /** 三档结局:allow=直放 / ask=弹卡确认 / deny=硬拒。 */
  outcome: GateOutcome;
  /** 命中的能力(供权限卡展示 + 本会话 remember 键)。 */
  capability?: Capability;
  reason?: string;
}

/** 构造决策(`allow` 由 `outcome` 派生,保证两者一致)。 */
function decide(outcome: GateOutcome, capability?: Capability, reason?: string): TrustDecision {
  return { allow: outcome === 'allow', outcome, ...(capability ? { capability } : {}), ...(reason ? { reason } : {}) };
}

/** 写作用域判定的上下文(R2-08)。`args` = 工具入参(从中提取目标路径);
 *  `projectRoot` = 工作区根(games/** 解析基准);`activeGame` = 当前激活游戏 slug。
 *  全可选——拿不到任何一个就无法证明写在沙箱内 ⇒ fail-closed(deny)。 */
export interface TrustContext {
  args?: unknown;
  projectRoot?: string;
  /** 当前激活游戏 slug;省略 ⇒ 允许写入任意 `.forgeax/games/<slug>/`(任一游戏)。 */
  activeGame?: string;
}

/** 闸口判定(三档):allowlist > 硬 deny > imported write/delete 作用域(内 ask / 外 deny)
 *  > tier ask 集 > per-tier 直放集(own 通配 / imported 仅 {read,delegate});其余(imported 未知能力)
 *  → ask 交人判断(不静默放行、也不静默拒,§8/§9)。 */
export function checkKernelTool(
  trustTier: TrustTier | undefined,
  toolName: string,
  ctx: TrustContext = {},
): TrustDecision {
  if (ALWAYS_ALLOW.has(toolName)) return decide('allow');
  // 缺 trustTier → fail-closed 当 imported 处理(不信默认 own)。
  const tier: TrustTier = trustTier ?? 'imported';
  const cap = classifyTool(toolName);

  // 1) 硬拒(imported credential)——不可放行。
  if (TIER_DENY[tier].has(cap)) {
    return decide('deny', cap, `tool "${toolName}" denied for ${tier} pack (capability "${cap}")`);
  }

  // 2) imported 的 write/delete:R2-08 游戏目录作用域 —— 目录内 → ask(确认),目录外 → deny。
  if (tier === 'imported' && SCOPED_CAPS.has(cap)) {
    const scoped = writeAllowedInGameScope(ctx);
    if (scoped.allow) return decide('ask', cap, `confirm ${cap} in active game dir: ${toolName}`);
    return decide('deny', cap, scoped.reason ?? `tool "${toolName}" denied for ${tier} pack (${cap} outside games/**)`);
  }

  // 3) 弹卡确认集(own 危险 {exec,network,credential,delete};imported {exec,network})。
  if (TIER_ASK[tier].has(cap)) {
    return decide('ask', cap, `confirm ${cap}: ${toolName}`);
  }

  // 4) per-tier 直放集:own=通配(null)直放;imported 只直放显式信任的 {read, delegate}。
  const allowSet = TIER_ALLOW[tier];
  if (allowSet === null || allowSet.has(cap)) return decide('allow', cap);
  // 不在直放集、又未被前面 1)-3) 处理的能力(imported 的 `other` 等叫不出名字的工具):
  //   **不静默放行、也不静默 deny**,而是弹卡交人判断(ask)。理由见 TIER_ALLOW 注释:
  //   deny 无回退路径(代价是整包升 own),ask 保留用户否决权 + 本会话 remember(§8/§9)。
  //   ask 的 allow 字段仍为 false → 旧只看 .allow 的调用方依旧不会误自动放行(fail-closed 姿态不变)。
  return decide('ask', cap, `confirm untrusted ${cap} tool: ${toolName}`);
}

/** 工具入参里可能携带目标路径的字段(按惯例)。 */
const PATH_ARG_KEYS = ['path', 'file', 'filePath', 'file_path', 'filename', 'target', 'dir', 'directory'];

/** 从工具入参里提取目标路径(首个命中的字符串字段)。 */
function extractPath(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const obj = args as Record<string, unknown>;
  for (const k of PATH_ARG_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** R2-08 写/删作用域:仅当目标路径解析进 `<projectRoot>/.forgeax/games/<slug>/` 内才算"在沙箱内"。
 *  缺 projectRoot 或拿不到路径 ⇒ fail-closed(无法证明在沙箱内)。返回内部 in-scope 判定,
 *  由 `checkKernelTool` 翻成 ask(内)/ deny(外)。 */
function writeAllowedInGameScope(ctx: TrustContext): { allow: boolean; reason?: string } {
  const { projectRoot, activeGame } = ctx;
  if (!projectRoot) return { allow: false, reason: 'write denied: no project root to scope against (fail-closed)' };
  const target = extractPath(ctx.args);
  if (!target) return { allow: false, reason: 'write denied: no target path in args to scope (fail-closed)' };

  const abs = resolve(projectRoot, target);
  const gamesRoot = resolve(projectRoot, '.forgeax', 'games');
  // 限定到具体激活游戏(若已知),否则限定到 games 根下任一游戏。
  const scopeDir = activeGame ? resolve(gamesRoot, activeGame) : gamesRoot;
  if (isInside(abs, scopeDir)) return { allow: true };
  return { allow: false, reason: `write denied: path "${target}" is outside the active game dir` };
}

/** `child` 是否在 `parent` 目录内(含相等);用规范化路径 + 分隔符前缀防 `games-evil` 穿越。 */
function isInside(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}
