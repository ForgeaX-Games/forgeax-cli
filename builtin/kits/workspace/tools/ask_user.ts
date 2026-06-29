/** ask_user —— 让 agent 向用户抛出一个带选项的问题，由用户单选/多选作答，
 *  选择结果作为 tool_result 回流。
 *
 *  机制（见 .claude/docs/需求/ask-user-tool-需求单.md）：
 *  - 调用前 tool-batch-runner 已 hook(Hook.ToolCall) 把 args(question/options/
 *    multiSelect) 流到前端，前端 ForgeCard 据 tool 段 name==='ask_user' 渲染
 *    可点选卡片，无需本工具额外发事件。
 *  - execute() 注册一个阻塞 Promise（ask-user-registry，键 sid::agentPath），
 *    返回值即 tool_result；前端选完 POST /api/sessions/:sid/ask-reply resolve。
 *  - 串行执行 (serial:true) 保证同一 agent 同一时刻至多一个 ask pending。
 *  - ctx.signal abort / 超时 → 优雅兜底回执，不抛错卡死 loop。 */

import type { ToolDefinition, AgentContext, ToolOutput } from "../../../../src/core/types";
import { registerAsk } from "../../../../src/core/ask-user-registry";

// 无超时:ask_user 是「问用户」,本就该一直等用户回答(对齐 the reference agent CLI 的
// AskUserQuestion —— 不设 deadline,用户答 或 中断本轮 才结束)。0 = 不挂定时器。
const ASK_TIMEOUT_MS = 0;

interface AskOption {
  label: string;
  description?: string;
}

function readOptions(args: Record<string, unknown>): AskOption[] {
  const raw = args.options;
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const it of raw) {
    if (it && typeof it === "object" && typeof (it as any).label === "string") {
      const label = (it as any).label as string;
      const description = typeof (it as any).description === "string" ? (it as any).description : undefined;
      out.push({ label, ...(description ? { description } : {}) });
    } else if (typeof it === "string") {
      // 容错：允许直接传字符串数组。
      out.push({ label: it });
    }
  }
  return out;
}

export default {
  name: "ask_user",
  description:
    // 命中率主要靠这段 model-facing 描述驱动。forgeax 不把工具 prompt 注入系统
    // 提示(guidance 仅用于 observatory),所以这里把 the reference agent CLI 的两段都合进
    // description:① 短描述(tools 数组那条)②系统提示里的 AskUserQuestion 引导
    // (numbered use-cases + Usage notes),原文措辞尽量保留;plan-mode 那段不适用,删。
    "Asks the user multiple choice questions to gather information, clarify " +
    "ambiguity, understand preferences, make decisions, or offer them choices.\n" +
    "\n" +
    "Use this tool whenever you need an answer from the user during execution " +
    "and that answer is a choice among a few concrete options — PREFER it over " +
    "asking in plain prose. It pauses and renders clickable choices in the chat, " +
    "and the user's selection comes back as the tool result so you can act on it " +
    "directly. This allows you to:\n" +
    "1. Gather user preferences or requirements\n" +
    "2. Clarify ambiguous instructions\n" +
    "3. Get decisions on implementation/design choices as you work\n" +
    "4. Offer choices to the user about what direction to take\n" +
    "\n" +
    "Usage notes:\n" +
    "- The UI always appends an \"Other\" choice so the user can provide custom " +
    "free-text input; that text comes back as the selected value, so be ready to " +
    "handle answers that are not among your listed options.\n" +
    "- Use multiSelect: true to allow multiple answers to be selected for a " +
    "question.\n" +
    "- If you recommend a specific option, make that the first option in the list " +
    "and add \"(Recommended)\" at the end of the label.\n" +
    "- One question per call; give 2–5 distinct, mutually-exclusive options, each " +
    "with a short description of its trade-off.",
  guidance:
    "**ask_user**: Reach for this whenever you would otherwise ask the user a " +
    "clarifying or decision question in prose and the answer is a choice among " +
    "a few options — it's almost always better to let them click than to type. " +
    "Good triggers: ambiguous requirements, picking an approach/tech, scoping " +
    "(which features/levels), confirming an assumption before a big step. Give " +
    "2–5 distinct, mutually-exclusive options each with a short description; " +
    "multiSelect:true when not mutually exclusive.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The complete question to ask. Clear, specific, ends with a question " +
          "mark. If multiSelect is true, phrase accordingly (e.g. \"Which " +
          "features do you want to enable?\").",
      },
      header: {
        type: "string",
        description: "Very short label (≤12 chars) shown as a chip, e.g. \"Game type\", \"Approach\".",
      },
      options: {
        type: "array",
        description:
          "2–5 distinct, mutually-exclusive choices (the UI auto-adds an " +
          "\"Other\" free-text option, so do not add one yourself).",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Concise display text for the option (1–5 words). Append \" (Recommended)\" if you recommend it.",
            },
            description: {
              type: "string",
              description: "Short explanation of what this option means / its trade-off (recommended).",
            },
          },
          required: ["label"],
        },
      },
      multiSelect: {
        type: "boolean",
        description: "true = checkbox multi-select (choices not mutually exclusive); default false = radio single-select.",
      },
    },
    required: ["question", "options"],
  },
  validateInput(args) {
    if (typeof args.question !== "string" || !args.question.trim()) {
      return "ask_user: 'question' (non-empty string) is required.";
    }
    const opts = readOptions(args);
    if (opts.length === 0) {
      return "ask_user: 'options' must be a non-empty array of { label } items.";
    }
    return undefined;
  },
  async execute(args, ctx: AgentContext): Promise<ToolOutput> {
    const opts = readOptions(args);
    const multi = args.multiSelect === true;
    const sid = ctx.tree.sid;
    const agentPath = ctx.agentPath;

    const handle = registerAsk(sid, agentPath, ASK_TIMEOUT_MS);

    // Abort (user interrupt) → resolve the pending ask with null so we don't
    // dangle. registerAsk's dispose() in finally also clears it.
    const onAbort = () => handle.dispose();
    if (ctx.signal.aborted) {
      handle.dispose();
      return "(用户中断,未作答)";
    }
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const values = await handle.promise;
      if (values === null) {
        // 无超时:null 只来自 abort(中断本轮)或被新的 ask 取代,不存在"超时未答"。
        return ctx.signal.aborted ? "(用户中断,未作答)" : "(问题已取消)";
      }
      // 不做选项白名单过滤 —— 除了给定选项,UI 还允许用户「其他…」自填自由文本,
      // 这类值不在 opts 里,必须如实带回(只去空白)。
      const known = new Set(opts.map((o) => o.label));
      const picked = values.map((v) => v.trim()).filter(Boolean);
      if (picked.length === 0) return "用户未选择任何项";
      const tagOf = (v: string) => (known.has(v) ? `「${v}」` : `「${v}」(自填)`);
      const rendered = picked.map(tagOf).join("");
      return multi ? `用户(多选)选择了: ${rendered}` : `用户选择了: ${tagOf(picked[0]!)}`;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      handle.dispose();
    }
  },
  // 故意不实现 formatDisplay —— 它会把 visual_display 设成问题文本,而前端
  // event-formatter 对 toolResult「有 visual_display 就跳过抽取 result 正文」,
  // 导致重放时 resultContent 为空、刷新后卡片显示「已选择:(无)」。不设
  // visual_display,工具返回串(=用户答案)就会落进 resultContent,刷新后
  // AskUserCard 能从 tc.result 回填「已选择」。我们也不靠 chip 显示(ask_user
  // 走 AskUserCard 而非 ToolChipRow)。
  compactResult(_args, result) {
    return `[ask_user] ${result}`.slice(0, 120);
  },
  serial: true,
} satisfies ToolDefinition;
