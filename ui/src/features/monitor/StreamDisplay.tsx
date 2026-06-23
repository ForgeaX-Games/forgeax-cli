import { useState, useRef, useLayoutEffect, useCallback, memo } from "react";
import type {
  CompletedTurn,
  RendererMessage,
  ToolCallMessage,
  AssistantCompleteMessage,
  UserInputMessage,
  SystemMessage,
} from "@/lib/event-engine/types";
import { Brain, MessageSquare, Inbox, Send } from "lucide-react";

// ── Icon map ──

const TOOL_ICONS: Record<string, string> = {
  shell: "$", read_file: "\u{1F4C4}", write_file: "\u270F\uFE0F", edit_file: "\u270F\uFE0F",
  list_dir: "\u{1F4C1}", glob: "\u{1F50D}", grep: "\u{1F50D}",
  web_search: "\u{1F310}", web_fetch: "\u{1F310}",
  memory_get: "\u{1F9E0}", memory_search: "\u{1F50D}", memory_set: "\u{1F4BE}",
  plan: "\u{1F4DD}", ask_user: "\u2753", self_reflect: "\u{1F4AD}",
  create_plan: "\u{1F4DD}", review_plan: "\u{1F4CB}", execute_plan: "\u25B6",
  complete_plan: "\u2705", enter_plan_mode: "\u{1F4DD}",
  read: "\u{1F4C4}", write: "\u270F\uFE0F", edit: "\u270F\uFE0F",
  todo_write: "\u{1F4CB}", multi_edit: "\u270F\uFE0F",
  restart_instance: "\u{1F504}",
};

function getIcon(name: string): string {
  if (name.startsWith("subagent:") || name.startsWith("subagent ")) return "\u{1F916}";
  return TOOL_ICONS[name] ?? "\u25B8";
}

// ── Helpers ──

function shortPath(p: string): string {
  if (p.length <= 40) return p;
  const parts = p.split("/");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : p.slice(0, 40) + "\u2026";
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function toolBrief(msg: ToolCallMessage): string {
  const a = msg.args as Record<string, unknown> | undefined;
  if (!a) return "";
  const n = msg.name.replace(/^subagent:\s*/, "");
  if (n === "shell") return String(a.command ?? "").slice(0, 80);
  if (["read_file", "read", "write_file", "write", "edit_file", "edit"].includes(n))
    return shortPath(String(a.path ?? a.file ?? ""));
  if (n === "glob") return shortPath(String(a.pattern ?? ""));
  if (n === "grep") return `"${String(a.pattern ?? "").slice(0, 40)}"`;
  if (n === "memory_get") return shortPath(String(a.path ?? a.key ?? ""));
  if (n === "memory_search" || n === "web_search") return String(a.query ?? a.scope ?? "").slice(0, 50);
  if (n === "self_reflect") return String(a.gaps ?? a.query ?? "").slice(0, 60);
  if (n === "list_dir") return shortPath(String(a.path ?? ""));
  if (n === "create_plan" || n === "review_plan" || n === "execute_plan")
    return String(a.name ?? a.plan ?? "").slice(0, 50);
  if (n === "restart_instance") return String(a.reason ?? "").slice(0, 50);
  if (msg.name.startsWith("subagent:") || msg.name.startsWith("subagent "))
    return String(a.subagentId ?? a.template ?? a.task ?? "").slice(0, 50);
  const first = Object.entries(a)[0];
  return first ? `${first[0]}: ${String(first[1] ?? "").slice(0, 40)}` : "";
}

// ── DAG data model ──

type DagStep =
  | { kind: "turn"; index: number; agent: string; time: string; toolCount: number }
  | { kind: "user"; message: UserInputMessage }
  | { kind: "assistant"; message: AssistantCompleteMessage }
  | { kind: "tool_batch"; tools: ToolCallMessage[] }
  | { kind: "system_message"; message: SystemMessage };

function buildDag(turns: CompletedTurn[]): DagStep[] {
  const steps: DagStep[] = [];

  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti];
    const time = new Date(turn.timestamp).toLocaleTimeString();
    // Drop tool_result and bare system noise; keep system messages that carry
    // direction info (inter-agent traffic surfaced by the formatter).
    const meaningful = turn.messages.filter(m => {
      if (m.kind === "tool_result") return false;
      if (m.kind === "system") return (m as SystemMessage).direction !== undefined;
      return true;
    });
    const toolCount = meaningful.filter(m => m.kind === "tool_call").length;

    // Collect content steps for this turn first, only emit header if non-empty
    const turnContent: DagStep[] = [];
    let pendingTools: ToolCallMessage[] = [];

    const flushTools = () => {
      if (pendingTools.length > 0) {
        turnContent.push({ kind: "tool_batch", tools: [...pendingTools] });
        pendingTools = [];
      }
    };

    for (const msg of meaningful) {
      if (msg.kind === "tool_call") {
        pendingTools.push(msg as ToolCallMessage);
      } else {
        flushTools();
        if (msg.kind === "user_input") {
          turnContent.push({ kind: "user", message: msg as UserInputMessage });
        } else if (msg.kind === "assistant_complete") {
          const am = msg as AssistantCompleteMessage;
          if (am.text || am.thinking) {
            turnContent.push({ kind: "assistant", message: am });
          }
        } else if (msg.kind === "system") {
          turnContent.push({ kind: "system_message", message: msg as SystemMessage });
        }
      }
    }
    flushTools();

    if (turnContent.length > 0) {
      steps.push({ kind: "turn", index: ti, agent: turn.agent, time, toolCount });
      steps.push(...turnContent);
    }
  }
  return steps;
}

// ── Main component ──

interface StreamDisplayProps {
  turns: CompletedTurn[];
  streamText?: string;
  isThinking?: boolean;
  selectedMessage: RendererMessage | null;
  onSelect: (msg: RendererMessage) => void;
}

export function StreamDisplay({ turns, streamText, isThinking, selectedMessage, onSelect }: StreamDisplayProps) {
  const steps = buildDag(turns);

  return (
    <div className="flex flex-col items-center w-full py-4">
      {steps.map((step, i) => (
        <DagStepView
          key={i}
          step={step}
          selectedMessage={selectedMessage}
          onSelect={onSelect}
          isFirst={i === 0}
        />
      ))}
      {streamText && (
        <>
          <VLine h={24} />
          <StreamingCard text={streamText} isThinking={isThinking} />
        </>
      )}
    </div>
  );
}

// ── Vertical connector line ──

function VLine({ h = 24 }: { h?: number }) {
  return (
    <div className="flex justify-center" style={{ height: h }}>
      <div className="w-px bg-border h-full" />
    </div>
  );
}

// ── Step dispatcher ──

const DagStepView = memo(function DagStepView({
  step, selectedMessage, onSelect, isFirst,
}: {
  step: DagStep;
  selectedMessage: RendererMessage | null;
  onSelect: (msg: RendererMessage) => void;
  isFirst: boolean;
}) {
  switch (step.kind) {
    case "turn":
      return <TurnDivider step={step} isFirst={isFirst} />;
    case "user":
      return (
        <>
          <VLine />
          <UserCard msg={step.message} isSelected={selectedMessage === step.message} onSelect={onSelect} />
        </>
      );
    case "assistant":
      return (
        <>
          <VLine />
          <AssistantCard msg={step.message} isSelected={selectedMessage === step.message} onSelect={onSelect} />
        </>
      );
    case "tool_batch":
      return <ToolBatchBlock tools={step.tools} selectedMessage={selectedMessage} onSelect={onSelect} />;
    case "system_message":
      return (
        <>
          <VLine />
          <SystemMessageCard msg={step.message} isSelected={selectedMessage === step.message} onSelect={onSelect} />
        </>
      );
  }
});

// ── Turn divider ──

function TurnDivider({ step, isFirst }: { step: Extract<DagStep, { kind: "turn" }>; isFirst: boolean }) {
  return (
    <>
      {!isFirst && <VLine h={16} />}
      <div className="flex items-center gap-3 w-full max-w-2xl px-2">
        <div className="h-px flex-1 bg-border" />
        <div className="flex items-center gap-2 text-xs shrink-0">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
            {step.index + 1}
          </span>
          <span className="font-semibold">{step.agent}</span>
          <span className="text-muted-foreground">{step.time}</span>
          {step.toolCount > 0 && (
            <span className="text-muted-foreground/60">{step.toolCount} tool{step.toolCount > 1 ? "s" : ""}</span>
          )}
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
    </>
  );
}

// ── Tool batch (parallel DAG) ──

function ToolBatchBlock({ tools, selectedMessage, onSelect }: {
  tools: ToolCallMessage[];
  selectedMessage: RendererMessage | null;
  onSelect: (msg: RendererMessage) => void;
}) {
  const isParallel = tools.length > 1;
  const containerRef = useRef<HTMLDivElement>(null);
  const [fanPaths, setFanPaths] = useState<{ out: string[]; inP: string[] }>({ out: [], inP: [] });

  const computePaths = useCallback(() => {
    if (!isParallel || !containerRef.current) return;
    const container = containerRef.current;
    const cards = container.querySelectorAll<HTMLElement>("[data-tool-card]");
    if (cards.length === 0) return;

    const containerRect = container.getBoundingClientRect();
    const centerX = containerRect.width / 2;

    const outPaths: string[] = [];
    const inPaths: string[] = [];

    cards.forEach(card => {
      const cardRect = card.getBoundingClientRect();
      const cardCenterX = cardRect.left - containerRect.left + cardRect.width / 2;
      const fanH = 20;

      outPaths.push(
        `M ${centerX} 0 C ${centerX} ${fanH * 0.6}, ${cardCenterX} ${fanH * 0.4}, ${cardCenterX} ${fanH}`
      );
      inPaths.push(
        `M ${cardCenterX} 0 C ${cardCenterX} ${fanH * 0.6}, ${centerX} ${fanH * 0.4}, ${centerX} ${fanH}`
      );
    });

    setFanPaths({ out: outPaths, inP: inPaths });
  }, [isParallel]);

  useLayoutEffect(() => {
    computePaths();
  }, [computePaths, tools.length]);

  if (!isParallel) {
    return (
      <>
        <VLine />
        <ToolCard msg={tools[0]} isSelected={selectedMessage === tools[0]} onSelect={onSelect} />
      </>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col items-center w-full max-w-4xl">
      {/* Fan-out lines */}
      <VLine h={12} />
      <svg className="w-full" height={20} style={{ overflow: "visible" }}>
        {fanPaths.out.map((d, i) => (
          <path key={i} d={d} fill="none" className="stroke-border" strokeWidth={1} />
        ))}
      </svg>

      {/* Parallel tool cards */}
      <div className="flex items-start justify-center gap-3 flex-wrap px-4">
        {tools.map((tool, i) => (
          <div key={i} data-tool-card className="flex flex-col items-center">
            <ToolCard msg={tool} isSelected={selectedMessage === tool} onSelect={onSelect} />
          </div>
        ))}
      </div>

      {/* Fan-in lines */}
      <svg className="w-full" height={20} style={{ overflow: "visible" }}>
        {fanPaths.inP.map((d, i) => (
          <path key={i} d={d} fill="none" className="stroke-border" strokeWidth={1} />
        ))}
      </svg>
    </div>
  );
}

// ── Tool card ──

function ToolCard({ msg, isSelected, onSelect }: {
  msg: ToolCallMessage;
  isSelected: boolean;
  onSelect: (msg: RendererMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const icon = getIcon(msg.name);
  const brief = toolBrief(msg);
  const dur = fmtMs(msg.durationMs);
  const isSubagent = msg.name.startsWith("subagent:");
  const isDone = msg.status === "done";
  const isError = msg.status === "error";
  const isRunning = msg.status === "running";

  const borderCls = isError
    ? "border-red-500/50"
    : isSubagent
    ? "border-violet-500/50"
    : isDone
    ? "border-green-500/30"
    : isRunning
    ? "border-blue-500/50"
    : "border-border";

  const bgCls = isError
    ? "bg-red-500/5"
    : isSubagent
    ? "bg-violet-500/5"
    : isDone
    ? "bg-green-500/5"
    : isRunning
    ? "bg-blue-500/5"
    : "bg-card";

  return (
    <div
      className={`min-w-[180px] max-w-[320px] rounded-xl border-2 ${borderCls} ${bgCls} shadow-sm transition-all cursor-pointer ${
        isSelected ? "ring-2 ring-primary shadow-md scale-[1.02]" : "hover:shadow-md hover:scale-[1.01]"
      }`}
      onClick={() => onSelect(msg)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="text-lg shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="font-mono font-semibold text-sm truncate">{msg.name}</div>
          {brief && <div className="font-mono text-xs text-muted-foreground truncate mt-0.5">{brief}</div>}
        </div>
        <div className="flex flex-col items-end gap-0.5 shrink-0">
          <StatusDot status={msg.status} />
          {dur && <span className="text-[10px] text-muted-foreground">{dur}</span>}
        </div>
      </div>

      {/* Expand toggle */}
      {!!(msg.resultContent || msg.args) && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setExpanded(prev => !prev); }}
          className="w-full text-[10px] text-muted-foreground/60 hover:text-muted-foreground py-0.5 border-t border-border/30 transition-colors"
        >
          {expanded ? "\u25B4 collapse" : "\u25BE expand"}
        </button>
      )}

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-border/30 px-3 py-2 space-y-2">
          {msg.args != null && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground mb-1">Args</div>
              <pre className="text-[11px] bg-muted/50 rounded-lg p-2 overflow-auto max-h-32 font-mono whitespace-pre-wrap">
                {typeof msg.args === "string" ? msg.args : JSON.stringify(msg.args, null, 2)}
              </pre>
            </div>
          )}
          {msg.resultContent && (
            <div>
              <div className="text-[10px] font-semibold text-muted-foreground mb-1">Result</div>
              <pre className="text-[11px] bg-muted/50 rounded-lg p-2 overflow-auto max-h-32 font-mono whitespace-pre-wrap">
                {msg.resultContent.length > 1500
                  ? msg.resultContent.slice(0, 1500) + "\n\u2026 (truncated)"
                  : msg.resultContent}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Status dot ──

function StatusDot({ status }: { status: string }) {
  switch (status) {
    case "done":
      return (
        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs font-semibold">
          {"\u2713"}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-semibold">
          {"\u2717"}
        </span>
      );
    case "running":
      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />;
    default:
      return <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground/30" />;
  }
}

// ── Assistant card ──

function AssistantCard({ msg, isSelected, onSelect }: {
  msg: AssistantCompleteMessage;
  isSelected: boolean;
  onSelect: (msg: RendererMessage) => void;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const hasThinking = Boolean(msg.thinking);

  return (
    <div
      className={`min-w-[240px] max-w-2xl w-full rounded-xl border-2 border-emerald-500/30 bg-emerald-500/5 shadow-sm transition-all cursor-pointer ${
        isSelected ? "ring-2 ring-primary shadow-md" : "hover:shadow-md"
      }`}
      onClick={() => onSelect(msg)}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-emerald-500/10">
        <span className="text-lg">{"\u{1F916}"}</span>
        <span className="font-semibold text-sm text-emerald-700 dark:text-emerald-400">Assistant</span>
        {hasThinking && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setShowThinking(prev => !prev); }}
            className="ml-auto text-[11px] text-violet-500 hover:underline flex items-center gap-1"
          >
            <Brain className="h-3 w-3" />
            {showThinking ? "hide thinking" : "show thinking"}
          </button>
        )}
      </div>
      {showThinking && msg.thinking && (
        <pre className="text-xs bg-violet-500/5 px-4 py-2 overflow-auto max-h-28 font-mono whitespace-pre-wrap text-muted-foreground border-b border-violet-500/10">
          {msg.thinking.length > 800 ? msg.thinking.slice(0, 800) + "\n\u2026" : msg.thinking}
        </pre>
      )}
      <div className="px-4 py-3">
        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
          {msg.text.length > 400 ? msg.text.slice(0, 400) + "\u2026" : msg.text}
        </p>
      </div>
    </div>
  );
}

// ── System message card (inter-agent direction-aware) ──
//
// The formatter outputs structured `direction` / `from` / `to` based purely on
// `to` / `source` / `agent` of the StoredEvent. Visual encoding (icon, color,
// label) lives entirely here — the UI's concern.

type SystemTone = {
  icon: React.ReactNode;
  label: string;
  border: string;
  bg: string;
  textColor: string;
};

// buildDag filters out system messages without direction; systemTone only sees
// direction === "incoming" | "outgoing". No fallback branch needed.
function systemTone(msg: SystemMessage): SystemTone {
  if (msg.direction === "incoming") {
    return {
      icon: <Inbox className="h-4 w-4" />,
      label: msg.from ? `from ${msg.from}` : "incoming",
      border: "border-violet-500/40",
      bg: "bg-violet-500/5",
      textColor: "text-violet-700 dark:text-violet-400",
    };
  }
  return {
    icon: <Send className="h-4 w-4" />,
    label: msg.to ? `to ${msg.to}` : "outgoing",
    border: "border-yellow-500/40",
    bg: "bg-yellow-500/5",
    textColor: "text-yellow-700 dark:text-yellow-400",
  };
}

function SystemMessageCard({ msg, isSelected, onSelect }: {
  msg: SystemMessage;
  isSelected: boolean;
  onSelect: (msg: RendererMessage) => void;
}) {
  const tone = systemTone(msg);
  return (
    <div
      className={`min-w-[240px] max-w-2xl w-full rounded-xl border-2 ${tone.border} ${tone.bg} shadow-sm transition-all cursor-pointer ${
        isSelected ? "ring-2 ring-primary shadow-md" : "hover:shadow-md"
      }`}
      onClick={() => onSelect(msg)}
    >
      <div className={`flex items-center gap-2 px-4 py-2 border-b border-current/10 ${tone.textColor}`}>
        {tone.icon}
        <span className="font-semibold text-sm">{tone.label}</span>
        {msg.source && (
          <span className="text-[11px] font-mono text-muted-foreground/80 truncate">{msg.source}</span>
        )}
      </div>
      <div className="px-4 py-2.5">
        <p className="text-sm whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
          {msg.text.length > 600 ? msg.text.slice(0, 600) + "…" : msg.text}
        </p>
      </div>
    </div>
  );
}

// ── User card ──

function UserCard({ msg, isSelected, onSelect }: {
  msg: UserInputMessage;
  isSelected: boolean;
  onSelect: (msg: RendererMessage) => void;
}) {
  return (
    <div
      className={`min-w-[240px] max-w-2xl w-full rounded-xl border-2 border-blue-500/40 bg-blue-500/5 shadow-sm transition-all cursor-pointer ${
        isSelected ? "ring-2 ring-primary shadow-md" : "hover:shadow-md"
      }`}
      onClick={() => onSelect(msg)}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-blue-500/10">
        <span className="text-lg">{"\u{1F464}"}</span>
        <span className="font-semibold text-sm text-blue-700 dark:text-blue-400">{msg.source ?? "user"}</span>
      </div>
      <div className="px-4 py-3">
        <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>
      </div>
    </div>
  );
}

// ── Streaming card ──

function StreamingCard({ text, isThinking }: { text: string; isThinking?: boolean }) {
  return (
    <div className="min-w-[240px] max-w-2xl w-full rounded-xl border-2 border-dashed border-blue-500/40 bg-blue-500/5 shadow-sm">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-blue-500/10">
        {isThinking
          ? <Brain className="h-4 w-4 text-violet-500 animate-pulse" />
          : <MessageSquare className="h-4 w-4 text-blue-500" />
        }
        <span className="font-semibold text-sm text-blue-600 dark:text-blue-400">
          {isThinking ? "Thinking\u2026" : "Streaming\u2026"}
        </span>
        <span className="ml-auto inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
      </div>
      <div className="px-4 py-3">
        <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-6">
          {text.slice(-500)}
        </p>
      </div>
    </div>
  );
}
