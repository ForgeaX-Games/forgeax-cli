/**
 * approval.ts —— /remote-control 的「确认转发」纯函数层(格式化 + 解析)。
 *
 * 远端控制开启后,凡需用户确认的交互(权限审批 askUser / 结构化提问 askQuestion)都要
 * 让远端用户也能回答(channel permission relay 模式):
 *   - 出站:把 pending 权限/提问渲染成手机可读的文本(短 id + 摘要 + 回复格式说明);
 *   - 入站:把远端文本回复解析成结构化决策(y/n/a + id → 权限;id + 序号/自填 → 提问)。
 * 解析结果由 Repl 灌回**与本地浮层同一条** resolve 路径(PermissionQueue.decide /
 * QuestionQueue.confirm)——先决者胜,SSOT 不分叉。
 *
 * id 直接复用 provider 生成的 pending id(`perm-N` / `q-N`),展示为 `pN` / `qN`;
 * 回复只匹配**当前队首**,带 id 是为了拒掉迟到的旧回复(stale reply → 已失效提示,
 * 不落入聊天轮,避免「y p1」被当成对模型说的话)。
 *
 * Boundary(HOST 层):仅 core 相对 import,无 react/ink。
 */
import type { PendingPermission, PendingQuestion, PermissionDecision } from '../contracts';

// ─── 短 id(展示/回复用)────────────────────────────────────────────────────

/** `perm-3` → `p3`;`q-2` → `q2`(provider 的 id 形状是稳定契约,直接派生)。 */
export function shortApprovalId(pendingId: string): string {
  return pendingId.replace(/^perm-/, 'p').replace(/^q-/, 'q');
}

// ─── 出站:pending → 手机可读文本 ────────────────────────────────────────────

function summarize(v: unknown, max = 200): string {
  if (v == null) return '';
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 权限审批 → 远端提示文本。canonical = 已过 toolMeta 解析的真名(bash/write_file…)。 */
export function formatPermissionPrompt(pp: PendingPermission, canonical: string): string {
  const sid = shortApprovalId(pp.id);
  const input = pp.use.input as Record<string, unknown> | undefined;
  let detail: string;
  if (canonical === 'bash') {
    detail = `$ ${summarize((input as { command?: string })?.command ?? '')}`;
  } else if (canonical === 'write_file' || canonical === 'edit_file') {
    const path = (input as { file_path?: string; path?: string })?.file_path ?? (input as { path?: string })?.path ?? '';
    detail = `写入 ${path}`;
  } else {
    detail = summarize(input);
  }
  const lines = [
    `⚠️ 权限请求 ${sid}:允许 ${pp.use.name}?`,
    detail,
    pp.perm.message ? summarize(pp.perm.message) : '',
    `回复「y ${sid}」允许一次 /「a ${sid}」总是允许 /「n ${sid}」拒绝`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** 结构化提问(当前题)→ 远端提示文本。cursor 推进后再次调用发下一题。 */
export function formatQuestionPrompt(q: PendingQuestion): string {
  const sid = shortApprovalId(q.id);
  const item = q.items[q.cursor];
  if (!item) return '';
  const progress = q.items.length > 1 ? `(第 ${q.cursor + 1}/${q.items.length} 题)` : '';
  const lines = [
    `❓ 提问 ${sid}${progress}[${item.header}]`,
    item.question,
    ...item.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${summarize(o.description, 60)}` : ''}`),
    item.multiSelect
      ? `回复「${sid} 序号」选择(多选空格分隔,如「${sid} 1 3」);或「${sid} 其它文本」自填`
      : `回复「${sid} 序号」选择(如「${sid} 1」);或「${sid} 其它文本」自填`,
  ];
  return lines.join('\n');
}

// ─── 入站:远端文本 → 结构化决策 ────────────────────────────────────────────

/** 权限决策回复:y/yes/允许/是 + pN;a/always/总是 + pN;n/no/拒绝/否 + pN。 */
const PERM_RE = /^\s*(y|yes|允许|是|a|always|总是|总是允许|n|no|拒绝|否)\s+(p\d+)\s*$/i;
/** 提问回复:qN + 其余(序号列表或自填文本)。 */
const QUESTION_RE = /^\s*(q\d+)\s+(.+)$/is;

export type ApprovalReply =
  | { kind: 'permission'; shortId: string; decision: PermissionDecision }
  | { kind: 'question'; shortId: string; optionNums?: number[]; otherText?: string };

/** 解析远端回复;非确认格式返回 null(落回普通聊天轮)。 */
export function parseApprovalReply(text: string): ApprovalReply | null {
  const pm = PERM_RE.exec(text);
  if (pm) {
    const verb = pm[1]!.toLowerCase();
    const decision: PermissionDecision =
      verb === 'a' || verb === 'always' || verb === '总是' || verb === '总是允许'
        ? 'allow-always'
        : verb === 'n' || verb === 'no' || verb === '拒绝' || verb === '否'
          ? 'deny'
          : 'allow-once';
    return { kind: 'permission', shortId: pm[2]!.toLowerCase(), decision };
  }
  const qm = QUESTION_RE.exec(text);
  if (qm) {
    const shortId = qm[1]!.toLowerCase();
    const rest = qm[2]!.trim();
    // 全是序号(空格/逗号分隔)→ 选项选择;否则整段作自填文本。
    if (/^\d+([\s,،]+\d+)*$/.test(rest)) {
      const nums = rest.split(/[\s,،]+/).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
      return { kind: 'question', shortId, optionNums: nums };
    }
    return { kind: 'question', shortId, otherText: rest };
  }
  return null;
}

/** 文本「看起来像确认回复」但没匹配上任何在挂确认(迟到/typo)→ 用于回「已失效」而非入聊天轮。 */
export function looksLikeApprovalReply(text: string): boolean {
  return PERM_RE.test(text) || QUESTION_RE.test(text);
}

/** 决策的人类可读标签(本地 transcript 标注 + 远端回执共用)。 */
export function decisionLabel(d: PermissionDecision): string {
  return d === 'allow-always' ? '总是允许' : d === 'deny' ? '拒绝' : '允许一次';
}

// ─── 回发长度保护 ───────────────────────────────────────────────────────────

/** 微信单条文本消息的安全长度(字符;iLink 上限未公开文档化,取保守值防整条被拒收)。 */
export const REPLY_CHUNK_CHARS = 1800;
/** 单轮回复最多发几条(超出截断加尾注,防超长回复刷屏/触发限频)。 */
export const REPLY_MAX_CHUNKS = 4;

/** 把长回复切成若干条(优先在换行处断);超过 maxChunks 截断并加尾注。 */
export function chunkReply(
  text: string,
  chunkSize = REPLY_CHUNK_CHARS,
  maxChunks = REPLY_MAX_CHUNKS,
): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= chunkSize) {
      chunks.push(rest);
      rest = '';
      break;
    }
    // 在窗口后半段找换行断点,避免切断句子;找不到就硬切。
    const window = rest.slice(0, chunkSize);
    const nl = window.lastIndexOf('\n');
    const cut = nl > chunkSize / 2 ? nl : chunkSize;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) {
    chunks[chunks.length - 1] += `\n…(共 ${text.length} 字,已截断)`;
  }
  return chunks;
}
