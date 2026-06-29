/** 内核工具调用审计追踪 —— append-only JSONL。
 *
 *  每次 bridge tool 调用（无论放行还是拒绝）都向**该 session 数据目录**下的
 *  `<session-root>/kernel-tool-audit.jsonl` 追加一行 JSON —— 经 path-manager
 *  解析(与 ledger / global-events 同根,落 `~/.forgeax/sessions/<sid>/`),与会话
 *  数据共置,而非 instance-local repo 根。
 *
 *  设计约束：
 *  - **不写 args**（可能体积大 / 包含敏感内容）。
 *  - **永不抛出**：审计失败只静默吞掉，不影响主流程。
 *  - 目录不存在时递归创建。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getPathManager } from '../fs/path-manager';

export interface ToolAuditEntry {
  sid: string;
  agent: string;
  tool: string;
  trustTier: string;
  allow: boolean;
  ok?: boolean;
  error?: string;
  durationMs: number;
  ts: number;
}

export function appendToolAudit(entry: ToolAuditEntry): void {
  try {
    const dir = getPathManager().session(entry.sid).root();
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'kernel-tool-audit.jsonl');
    appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch {
    // 审计绝不影响主流程 —— 吞掉所有异常
  }
}
