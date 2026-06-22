/**
 * Embedding providers for memory_search.
 *
 * Pure provider implementations — no config loading, no file I/O.
 * Key reading and provider construction happen in memory_search.ts.
 *
 *   GeminiEmbeddingProvider  → gemini-embedding-2-preview (3072-dim, MRL, natively multimodal)
 *   OpenAIEmbeddingProvider  → text-embedding-3-small (1536-dim)
 *
 * Priority when both keys are present: Gemini > OpenAI.
 */

import type { EmbeddingProvider } from "./index-manager.js";

export type { EmbeddingProvider };

/**
 * Returns the best available EmbeddingProvider given raw API keys.
 * Priority: Gemini > OpenAI > null (FTS5-only fallback).
 */
export function buildEmbeddingProvider(
  geminiKey: string,
  openaiKey: string,
  geminiOutputDim: 256 | 512 | 768 | 1024 | 1536 | 3072 = 768,
): EmbeddingProvider | null {
  if (geminiKey) return new GeminiEmbeddingProvider(geminiKey, geminiOutputDim);
  if (openaiKey) return new OpenAIEmbeddingProvider(openaiKey);
  return null;
}

// ─── Gemini embedding-2 ───────────────────────────────────────────────────────

/**
 * Gemini embedding-2-preview
 *
 * Key facts (March 2026):
 * - 3072-dim output (default), MRL allows truncation to any sub-dimension
 * - Natively multimodal: text + images + video + audio + PDF in ONE call
 * - Dimensions < 3072 are NOT normalized by the API — we normalize here
 * - task_type: RETRIEVAL_DOCUMENT for index, RETRIEVAL_QUERY for search query
 * - Max input: 8192 tokens (text) / 6 images / 120s video / 80s audio / 6-page PDF
 */
class GeminiEmbeddingProvider implements EmbeddingProvider {
  private readonly model = "gemini-embedding-2-preview";
  private readonly apiBase = "https://generativelanguage.googleapis.com/v1beta";

  constructor(private readonly apiKey: string, private readonly outputDim: number) {}

  async embed(texts: string[], taskType: "index" | "query" = "index"): Promise<number[][]> {
    const BATCH_SIZE = 100;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      results.push(...await this.embedBatch(texts.slice(i, i + BATCH_SIZE), taskType));
    }
    return results;
  }

  private async embedBatch(texts: string[], taskType: "index" | "query"): Promise<number[][]> {
    const geminiTaskType = taskType === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const url = `${this.apiBase}/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
          taskType: geminiTaskType,
          outputDimensionality: this.outputDim,
        })),
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Gemini embedding API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as { embeddings: Array<{ values: number[] }> };
    return json.embeddings.map((e) => {
      // Vectors < 3072 are not normalized by the API — normalize manually
      return this.outputDim < 3072 ? l2Normalize(e.values) : e.values;
    });
  }
}

// ─── OpenAI text-embedding-3-small ───────────────────────────────────────────

/**
 * OpenAI text-embedding-3-small
 * - 1536-dim output, normalized by default
 */
class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly model = "text-embedding-3-small";
  private readonly apiBase = "https://api.openai.com/v1";

  constructor(private readonly apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    const BATCH_SIZE = 256;
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      results.push(...await this.embedBatch(texts.slice(i, i + BATCH_SIZE)));
    }
    return results;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.apiBase}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts, encoding_format: "float" }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`OpenAI embedding API error ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

function l2Normalize(vec: number[]): number[] {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  return norm === 0 ? vec : vec.map((v) => v / norm);
}
