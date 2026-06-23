/** Gemini 2.x adapter — thinkingBudget, no thought signature requirements */

import { GoogleGenAI } from "@google/genai";
import { registerProvider, downgradeEffort, type ProviderFactoryOpts } from "./provider.js";
import type { LLMMessage, LLMProvider } from "./types.js";
import { annotateLLMError } from "./errors.js";
import {
  collectToolResponsesToGemini,
  toolDefsToGemini,
  contentPartsToGemini,
  describeGeminiError,
  prepareGeminiInboundMessages,
  streamGeminiResponse,
} from "./gemini-shared.js";
import { extractTextContent } from "./thinking.js";
import { blocksToText } from "./provider-utils.js";
import { partitionSystemBlocks, foldDynamicReminders } from "./provider-utils.js";

async function messagesToGemini2(messages: LLMMessage[]): Promise<any[]> {
  const contents: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "tool") {
      const grouped = collectToolResponsesToGemini(messages, i);
      contents.push(grouped.content);
      i = grouped.nextIndex - 1;
      continue;
    }

    if (msg.role === "assistant") {
      const parts: any[] = [];
      const thinkingText = msg.thinking;

      if (thinkingText) {
        parts.push({ thought: true, text: thinkingText });
      }

      const textContent = extractTextContent(msg.content);
      if (textContent) {
        parts.push({ text: textContent });
      }

      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
      }

      if (parts.length > 0) {
        contents.push({ role: "model", parts });
      }
      continue;
    }

    contents.push({
      role: "user",
      parts: await contentPartsToGemini(msg.content, msg),
    });
  }
  return contents;
}

function createGemini2Provider(opts: ProviderFactoryOpts): LLMProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model;
  const temperature = opts.temperature;
  const maxOutputTokens = opts.maxTokens;
  const reasoningEffort = opts.reasoningEffort;

  return {
    async prepareInboundMessages(messages, context) {
      return await prepareGeminiInboundMessages(client, messages, context.signal);
    },
    async *chatStream(system, messages, tools, signal) {
      try {
        // Partition system into stable (systemInstruction) + dynamic (appended
        // as a fresh trailing user message carrying a single system-reminder
        // block). Gemini implicit context caching matches input prefix bytes —
        // keeping systemInstruction stable AND parking per-turn dynamic in its
        // own trailing user turn means every prior turn's bytes (history, tool
        // responses) stay byte-stable across calls and remain cache-eligible.
        const { stable } = partitionSystemBlocks(system ?? []);
        const enrichedMessages = foldDynamicReminders(messages);

        const contents = await messagesToGemini2(enrichedMessages);
        const geminiTools = toolDefsToGemini(tools);

        const config: any = {
          systemInstruction: stable.length ? blocksToText(stable) : undefined,
          tools: geminiTools,
          temperature,
          maxOutputTokens,
        };

        if (reasoningEffort) {
          const effective = downgradeEffort(reasoningEffort, ["low", "medium", "high"]);
          const budget = effective === "high" ? 32768 : effective === "medium" ? 16384 : 4096;
          config.thinkingConfig = {
            includeThoughts: true,
            thinkingBudget: budget,
          };
        }

        const response = await client.models.generateContentStream({ model, contents, config });

        yield* streamGeminiResponse(response, signal);
      } catch (err) {
        annotateLLMError(err, { provider: "gemini", model });
        console.error(
          "[gemini] stream error",
          JSON.stringify({ model, error: describeGeminiError(err) }),
        );
        throw err;
      }
    },
  };
}

registerProvider("google-gemini-2", createGemini2Provider);

export { createGemini2Provider };
