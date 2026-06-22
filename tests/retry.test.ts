// @desc Unit tests for retry mechanism — calculateDelay, withRetry, error classification
import { describe, it, mock } from "node:test";
import { strictEqual, ok, rejects, doesNotReject } from "node:assert";
import { calculateDelay, withRetry } from "../src/llm/retry.js";
import {
  classifyLLMError,
  isRetryable,
  getRecommendedDelay,
  TerminalLLMError,
  RetryableLLMError,
  NetworkError,
} from "../src/llm/errors.js";

// ── calculateDelay ──────────────────────────────────────────────────────────

describe("calculateDelay", () => {
  it("returns baseDelayMs * 2^attempt for attempt 0", () => {
    const delay = calculateDelay(0, 1000, 30000, false);
    strictEqual(delay, 1000);
  });

  it("doubles delay per attempt", () => {
    strictEqual(calculateDelay(0, 1000, 30000, false), 1000);
    strictEqual(calculateDelay(1, 1000, 30000, false), 2000);
    strictEqual(calculateDelay(2, 1000, 30000, false), 4000);
    strictEqual(calculateDelay(3, 1000, 30000, false), 8000);
  });

  it("caps at maxDelayMs", () => {
    const delay = calculateDelay(10, 1000, 30000, false);
    strictEqual(delay, 30000);
  });

  it("jitter is additive-only (never below base)", () => {
    for (let i = 0; i < 100; i++) {
      const base = calculateDelay(1, 1000, 30000, false);
      const withJitter = calculateDelay(1, 1000, 30000, true);
      ok(withJitter >= base, `jitter produced ${withJitter}, expected >= ${base}`);
      ok(withJitter <= base * 1.25 + 1, `jitter produced ${withJitter}, expected <= ${base * 1.25 + 1}`);
    }
  });

  it("uses recommendedDelay when provided", () => {
    const delay = calculateDelay(0, 1000, 30000, true, 5000);
    strictEqual(delay, 5000);
  });

  it("caps recommendedDelay at maxDelayMs", () => {
    const delay = calculateDelay(0, 1000, 30000, true, 60000);
    strictEqual(delay, 30000);
  });

  it("ignores recommendedDelay when 0 or negative", () => {
    const d1 = calculateDelay(0, 1000, 30000, false, 0);
    strictEqual(d1, 1000);
    const d2 = calculateDelay(0, 1000, 30000, false, -100);
    strictEqual(d2, 1000);
  });
});

// ── Error classification ────────────────────────────────────────────────────

describe("classifyLLMError", () => {
  it("classifies AbortError as terminal", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const result = classifyLLMError(err);
    strictEqual(result.kind, "terminal");
  });

  it("classifies 401 as terminal", () => {
    const err = Object.assign(new Error("unauthorized"), { status: 401 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "terminal");
  });

  it("classifies 403 as terminal", () => {
    const err = Object.assign(new Error("forbidden"), { status: 403 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "terminal");
  });

  it("classifies 400 as terminal", () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "terminal");
  });

  it("classifies 429 as retryable", () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
  });

  it("classifies 500 as retryable", () => {
    const err = Object.assign(new Error("server error"), { status: 500 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
  });

  it("classifies 529 as retryable", () => {
    const err = Object.assign(new Error("overloaded"), { status: 529 });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
  });

  it("classifies ECONNRESET as retryable NetworkError", () => {
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
    ok(result.error instanceof NetworkError);
  });

  it("classifies UND_ERR_SOCKET as retryable NetworkError", () => {
    const err = Object.assign(new Error("socket error"), { code: "UND_ERR_SOCKET" });
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
    ok(result.error instanceof NetworkError);
  });

  it("classifies unknown errors as retryable", () => {
    const result = classifyLLMError(new Error("something went wrong"));
    strictEqual(result.kind, "retryable");
  });

  it("preserves TerminalLLMError as-is", () => {
    const err = new TerminalLLMError("test", "TEST");
    const result = classifyLLMError(err);
    strictEqual(result.kind, "terminal");
    strictEqual(result.error, err);
  });

  it("preserves RetryableLLMError as-is", () => {
    const err = new RetryableLLMError("test", "TEST", 3000);
    const result = classifyLLMError(err);
    strictEqual(result.kind, "retryable");
    strictEqual(result.error, err);
  });
});

describe("isRetryable", () => {
  it("returns true for network errors", () => {
    ok(isRetryable(Object.assign(new Error(""), { code: "ECONNRESET" })));
  });

  it("returns true for 429", () => {
    ok(isRetryable(Object.assign(new Error(""), { status: 429 })));
  });

  it("returns true for 529", () => {
    ok(isRetryable(Object.assign(new Error(""), { status: 529 })));
  });

  it("returns false for 401", () => {
    ok(!isRetryable(Object.assign(new Error(""), { status: 401 })));
  });

  it("returns false for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    ok(!isRetryable(err));
  });
});

describe("getRecommendedDelay", () => {
  it("returns undefined for plain errors", () => {
    strictEqual(getRecommendedDelay(new Error("test")), undefined);
  });

  it("extracts retryDelayMs from RetryableLLMError", () => {
    const err = new RetryableLLMError("test", "TEST", 5000);
    strictEqual(getRecommendedDelay(err), 5000);
  });

  it("extracts retryAfterMs from annotated error", () => {
    const err = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfterMs: 10000,
    });
    const delay = getRecommendedDelay(err);
    strictEqual(delay, 10000);
  });
});

// ── withRetry ───────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    strictEqual(result, "ok");
  });

  it("retries on retryable error and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) {
          throw Object.assign(new Error("server error"), { status: 500 });
        }
        return Promise.resolve("recovered");
      },
      { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 50 },
    );
    strictEqual(result, "recovered");
    strictEqual(attempts, 3);
  });

  it("throws immediately on terminal error (no retry)", async () => {
    let attempts = 0;
    await rejects(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("bad request"), { status: 400 });
        },
        { maxRetries: 5, baseDelayMs: 10 },
      ),
      (err: any) => err instanceof TerminalLLMError,
    );
    strictEqual(attempts, 1);
  });

  it("exhausts maxRetries then throws", async () => {
    let attempts = 0;
    await rejects(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("server error"), { status: 500 });
        },
        { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 20 },
      ),
    );
    strictEqual(attempts, 4); // initial + 3 retries
  });

  it("respects AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort();
    await rejects(
      withRetry(() => Promise.resolve("ok"), { signal: ac.signal }),
      (err: any) => err.message === "Request cancelled",
    );
  });

  it("calls onRetry callback with correct info", async () => {
    const retryInfos: Array<{ attempt: number; delayMs: number }> = [];
    let attempts = 0;
    await rejects(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("error"), { status: 500 });
        },
        {
          maxRetries: 2,
          baseDelayMs: 10,
          maxDelayMs: 50,
          onRetry: (info) => retryInfos.push({ attempt: info.attempt, delayMs: info.delayMs }),
        },
      ),
    );
    strictEqual(retryInfos.length, 2);
    strictEqual(retryInfos[0].attempt, 1);
    strictEqual(retryInfos[1].attempt, 2);
    ok(retryInfos[0].delayMs >= 10);
    ok(retryInfos[1].delayMs >= 20);
  });

  it("applies exponential backoff delays", async () => {
    const delays: number[] = [];
    let attempts = 0;
    await rejects(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("error"), { status: 500 });
        },
        {
          maxRetries: 3,
          baseDelayMs: 10,
          maxDelayMs: 1000,
          jitter: false,
          onRetry: (info) => delays.push(info.delayMs),
        },
      ),
    );
    strictEqual(delays[0], 10);  // 10 * 2^0
    strictEqual(delays[1], 20);  // 10 * 2^1
    strictEqual(delays[2], 40);  // 10 * 2^2
  });
});
