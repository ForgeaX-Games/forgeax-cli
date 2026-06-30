/** Blackboard 内置 key 常量集合（per-session 反应式 KV）。
 *
 *  这 4 个 key 是 runtime 内部消费的：
 *  - LAST_USER_INPUT_AT — micro-compaction idle-gap 闸门读这个判断"用户离开多久了"。
 *  - STATUS             — agent 状态机（"plan_mode" 之类），落 `agent.json::defaultStatus` 初值。
 *  - CURRENT_DIR        — agent CWD，shell cd 时由 sandbox 同步回来；初值 `agent.json::defaultDir`。
 *  - RUNNING            — 当前 agent 是否在 turn loop 内（防重入 + UI 状态灯）。
 *
 *  Blackboard 不预填值：agent 第一次 set 才落盘。这里只是 string 常量，避免 magic strings 散落。
 *  其它 agent_id / agent_dir / home_dir 这些可以静态推导，不需要常驻 blackboard —— 等 directives
 *  系统进来再决定要不要走 blackboard 还是直接 prompt 里塞。 */

export const BLACKBOARD_KEYS = {
  LAST_USER_INPUT_AT: "LAST_USER_INPUT_AT",
  STATUS: "STATUS",
  CURRENT_DIR: "CURRENT_DIR",
  RUNNING: "RUNNING",
  /** Tool names + descriptions active in the current turn; consumed by tools slot. Volatile. */
  ACTIVE_TOOLS: "ACTIVE_TOOLS",
} as const;

export type BlackboardBuiltinKey = typeof BLACKBOARD_KEYS[keyof typeof BLACKBOARD_KEYS];

/** 持久化策略：哪些 key 默认 persist=true，哪些纯内存。 */
export const BLACKBOARD_PERSIST_POLICY: Record<BlackboardBuiltinKey, boolean> = {
  [BLACKBOARD_KEYS.LAST_USER_INPUT_AT]: true,
  [BLACKBOARD_KEYS.STATUS]: true,
  [BLACKBOARD_KEYS.CURRENT_DIR]: false,
  [BLACKBOARD_KEYS.RUNNING]: false,
  [BLACKBOARD_KEYS.ACTIVE_TOOLS]: false,
};
