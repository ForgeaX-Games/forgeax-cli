import { C } from "./colors.js";

export const theme = {
  // ── Input area ──
  prompt:      { color: C.green, bold: true, char: "❯" },
  promptCont:  { char: "  " },

  // ── Agent / Session labels ──
  agentLabel:    { color: C.cyan, bold: true, char: "●" },
  instanceLabel: { color: C.magenta, bold: true },
  sessionLabel:  { color: C.yellow },

  // ── Message types ──
  userInput:   { color: C.green, promptChar: "❯" },
  userMessage: { bg: "rgb(55,55,55)" as const, fg: C.white },
  steerInput:  { color: C.yellow, char: "⚡" },

  // ── Thinking ──
  thinking: { symbolColor: C.blueBright, barColor: C.blackBright, textColor: C.blackBright, ruleChar: "─" },

  // ── System messages ──
  systemLine: { labelColor: C.blackBright },
  notice:     { color: C.yellow, icon: "📨" },
  error:      { color: C.red, icon: "✗" },
  warning:    { color: C.yellow, icon: "⚠" },

  // ── Tool activity ──
  toolPending: { color: C.blackBright },
  toolRunning: { color: C.yellow },
  toolDone:    { color: C.green },
  toolError:   { color: C.red },
  toolResult:  { connector: "⎿", ellipsis: "…" },

  // ── Subagent ──
  subagent: {
    color: C.cyan,
    activeBorder: C.cyan,
    doneBorder: "#555" as const,
    borderStyle: "round" as const,
  },

  // ── Diff ──
  diff: {
    add:    { color: C.green, bg: "rgb(30,60,30)" as const },
    remove: { color: C.red,   bg: "rgb(60,30,30)" as const },
  },

  // ── Input chunks (file/paste/media inline labels) ──
  inputChunk: {
    paste: { bg: C.blue, fg: C.white },
    file:  { bg: C.cyan, fg: C.black },
    media: { bg: C.magenta, fg: C.white },
  },

  // ── Overlay / Select ──
  overlay: {
    borderStyle: "round" as const,
    borderColor: "#666" as const,
    selectedColor: C.green,
    selectedChar: "●",
    disabledColor: C.blackBright,
    loadingColor: C.yellow,
    commandColor: C.cyan,
  },

  // ── Agent tree panel ──
  tree: {
    roleColor: {
      admin: C.magenta,
      steward: C.cyan,
      worker: C.white,
    },
    runningColor: C.green,
    stoppedColor: C.blackBright,
    runningIcon: "●",
    stoppedIcon: "○",
    connectors: { last: "└── ", mid: "├── ", pipe: "│   ", blank: "    " },
  },

  // ── Board panel ──
  board: {
    headerColor: C.cyan,
    headerRule: "─",
    ruleColor: C.blackBright,
    keyColor: C.yellow,
    jsonKeyColor: C.cyan,
  },

  // ── Status bar ──
  statusBar: {
    separator: " │ ",
    bar: { full: "█", empty: "░", left: "▕", right: "▏" },
    noValue: "—",
  },

  // ── Feedback icons (terminal setup, etc.) ──
  feedback: { success: "✅", failure: "❌" },

  // ── Spinner ──
  spinner: { color: C.yellow, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] },

  // ── Instance status ──
  instanceStatus: {
    running: C.green,
    idle: C.yellow,
    provisioning: C.cyan,
    starting: C.cyan,
    stopping: C.yellow,
    stopped: C.red,
    restarting: C.yellow,
    error: C.red,
    unloaded: C.blackBright,
  },

  // ── Context ring ──
  contextRing: {
    low: C.green,
    medium: C.yellow,
    high: C.red,
    critical: C.redBright,
  },

  // ── Markdown ──
  markdown: { theme: "dark" as const },
} as const;
