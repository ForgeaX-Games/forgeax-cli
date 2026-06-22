import type { ToolDefinition, ToolOutput } from "#src/core/types.js";

const MIN_SEC = 0.1;
const MAX_SEC = 300;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function waitWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export default {
  name: "sleep",
  description: "Wait for the specified number of seconds (0.1–300).",
  input_schema: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "Duration to sleep in seconds (0.1–300)",
      },
    },
    required: ["seconds"],
  },
  async execute(args, ctx): Promise<ToolOutput> {
    const raw = Number(args.seconds);
    if (!Number.isFinite(raw)) return "Error: seconds must be a finite number.";
    const seconds = clamp(raw, MIN_SEC, MAX_SEC);
    await waitWithSignal(seconds * 1000, ctx.signal);
    return `Waited ${seconds}s.`;
  },
  serial: false,
} satisfies ToolDefinition;
