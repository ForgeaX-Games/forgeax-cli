// ── Misc glyphs ──
export const BLOCKQUOTE_BAR = '\u258e'
export const THINKING_SYMBOL = '\u2234'

// ── Tool icons ──
export const TOOL_ICONS: Record<string, string> = {
  shell:      "$",
  read_file:  "📄",
  write_file: "✏️",
  edit_file:  "✏️",
  apply_diff: "✏️",
  glob:       "🔍",
  grep:       "🔍",
  web_search: "🌐",
  web_fetch:  "🌐",
  subagent:   "🤖",
  todo_write: "📋",
};

// ── Status icons (todo items) ──
export const STATUS_ICON: Record<string, string> = {
  pending:     "○",
  in_progress: "▶",
  completed:   "✓",
  cancelled:   "✗",
};

// ── Tool state icons ──
export const TOOL_STATE_ICON = {
  pending: "○",
  running: "●",
  done:    "✓",
  error:   "✗",
} as const;
