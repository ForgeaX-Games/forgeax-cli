// Stage D — image-gateway contract tests.
//
// Verify:
//   - registerImageVendor + listImageVendors round-trip.
//   - generateImage picks vendor by role-default chain, skips unready vendors,
//     records each attempt in triedVendors.
//   - Explicit `req.vendor` wins over chain order (but still falls back).
//   - HTTP errors from a vendor cascade to the next; final failure throws
//     with the full attempt list.
//   - LiteLLM-images vendor reports isReady=false when LITELLM_PROXY_IMAGE_MODEL
//     is absent, true when set; request shape matches OpenAI images API
//     ({n,size,response_format:'b64_json'}); decodes b64_json → pngBytes.
//   - setRoleChain overrides the default chain ordering.
//
// All vendors here are mocks so the test stays hermetic and offline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  registerImageVendor,
  unregisterImageVendor,
  generateImage,
  listImageVendors,
  setRoleChain,
  resolveChain,
  _resetImageGateway,
  type ImageVendor,
} from "../src/lib/image-gateway";
import { createLitellmImagesVendor } from "../src/lib/image-gateway/vendors/litellm-images";

function mockVendor(name: string, opts: {
  ready?: boolean;
  failWith?: Error;
  produces?: { mime?: 'image/png' | 'image/jpeg' | 'image/webp'; modelId?: string };
} = {}): ImageVendor & { calls: number } {
  const v: ImageVendor & { calls: number } = {
    name,
    calls: 0,
    isReady: () => opts.ready !== false,
    async generate(req) {
      v.calls++;
      if (opts.failWith) throw opts.failWith;
      return {
        pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(name + ':' + req.prompt)]),
        mime: opts.produces?.mime ?? 'image/png',
        vendor: name,
        modelId: opts.produces?.modelId ?? `${name}-default`,
        estimateUSD: 0.01,
      };
    },
  };
  return v;
}

let prevBaseUrl: string | undefined;
let prevKey: string | undefined;
let prevImgModel: string | undefined;

beforeEach(() => {
  prevBaseUrl = process.env.LITELLM_PROXY_BASE_URL;
  prevKey = process.env.LITELLM_PROXY_KEY;
  prevImgModel = process.env.LITELLM_PROXY_IMAGE_MODEL;
  _resetImageGateway();
});

afterEach(() => {
  if (prevBaseUrl === undefined) delete process.env.LITELLM_PROXY_BASE_URL;
  else process.env.LITELLM_PROXY_BASE_URL = prevBaseUrl;
  if (prevKey === undefined) delete process.env.LITELLM_PROXY_KEY;
  else process.env.LITELLM_PROXY_KEY = prevKey;
  if (prevImgModel === undefined) delete process.env.LITELLM_PROXY_IMAGE_MODEL;
  else process.env.LITELLM_PROXY_IMAGE_MODEL = prevImgModel;
  _resetImageGateway();
});

describe("registry basics", () => {
  test("registerImageVendor + listImageVendors", () => {
    const v1 = mockVendor("seedream");
    const v2 = mockVendor("nano-banana", { ready: false });
    registerImageVendor(v1);
    registerImageVendor(v2);
    const listed = listImageVendors();
    expect(listed).toEqual([
      { name: "seedream", ready: true },
      { name: "nano-banana", ready: false },
    ]);
  });

  test("unregisterImageVendor drops from registry", () => {
    registerImageVendor(mockVendor("x"));
    expect(listImageVendors().length).toBe(1);
    unregisterImageVendor("x");
    expect(listImageVendors().length).toBe(0);
  });
});

describe("resolveChain", () => {
  test("default concept-art chain order", () => {
    registerImageVendor(mockVendor("seedream"));
    registerImageVendor(mockVendor("nano-banana"));
    registerImageVendor(mockVendor("azure-gpt-image"));
    registerImageVendor(mockVendor("litellm-images"));
    expect(resolveChain({ prompt: "x", role: "concept-art" })).toEqual([
      "seedream", "nano-banana", "azure-gpt-image", "litellm-images",
    ]);
  });

  test("default sprite-frame chain prefers gemini first", () => {
    registerImageVendor(mockVendor("seedream"));
    registerImageVendor(mockVendor("nano-banana"));
    registerImageVendor(mockVendor("azure-gpt-image"));
    registerImageVendor(mockVendor("litellm-images"));
    expect(resolveChain({ prompt: "x", role: "sprite-frame" })).toEqual([
      "nano-banana", "azure-gpt-image", "seedream", "litellm-images",
    ]);
  });

  test("preferred vendor moves to front; rest preserves natural order", () => {
    registerImageVendor(mockVendor("seedream"));
    registerImageVendor(mockVendor("nano-banana"));
    registerImageVendor(mockVendor("azure-gpt-image"));
    const chain = resolveChain({ prompt: "x", role: "concept-art", vendor: "azure-gpt-image" });
    expect(chain).toEqual(["azure-gpt-image", "seedream", "nano-banana", "litellm-images"]);
  });

  test("setRoleChain overrides default", () => {
    registerImageVendor(mockVendor("custom-a"));
    registerImageVendor(mockVendor("custom-b"));
    setRoleChain("concept-art", ["custom-b", "custom-a"]);
    expect(resolveChain({ prompt: "x", role: "concept-art" })).toEqual(["custom-b", "custom-a"]);
  });

  test("default role = concept-art when role unset", () => {
    registerImageVendor(mockVendor("seedream"));
    const chain = resolveChain({ prompt: "x" });
    expect(chain[0]).toBe("seedream");
  });
});

describe("generateImage", () => {
  test("happy path: first ready vendor in chain serves the request", async () => {
    const seedream = mockVendor("seedream");
    const gemini = mockVendor("nano-banana");
    registerImageVendor(seedream);
    registerImageVendor(gemini);

    const resp = await generateImage({ prompt: "tiny cat", role: "concept-art" });
    expect(resp.vendor).toBe("seedream");
    expect(seedream.calls).toBe(1);
    expect(gemini.calls).toBe(0);
    expect(resp.triedVendors).toEqual(["seedream"]);
    expect(resp.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("unready vendors are skipped with :no-key marker", async () => {
    registerImageVendor(mockVendor("seedream", { ready: false }));
    registerImageVendor(mockVendor("nano-banana"));
    const resp = await generateImage({ prompt: "x", role: "concept-art" });
    expect(resp.vendor).toBe("nano-banana");
    expect(resp.triedVendors).toEqual(["seedream:no-key", "nano-banana"]);
  });

  test("vendor failure cascades to next in chain; tried list records error code", async () => {
    registerImageVendor(mockVendor("seedream", { failWith: new Error("boom") }));
    registerImageVendor(mockVendor("nano-banana"));
    const resp = await generateImage({ prompt: "x", role: "concept-art" });
    expect(resp.vendor).toBe("nano-banana");
    expect(resp.triedVendors).toEqual(["seedream:err", "nano-banana"]);
  });

  test("all-fail throws with full attempt list", async () => {
    registerImageVendor(mockVendor("seedream", { failWith: new Error("primary down") }));
    registerImageVendor(mockVendor("nano-banana", { failWith: new Error("secondary down") }));
    // no others registered → chain refs to azure-gpt-image / litellm-images are no-ops
    await expect(generateImage({ prompt: "x", role: "concept-art" }))
      .rejects.toThrow(/all image vendors failed.*seedream:err.*nano-banana:err/);
  });

  test("explicit req.vendor wins first slot; still falls back to natural chain", async () => {
    const seedream = mockVendor("seedream");
    const azure = mockVendor("azure-gpt-image", { failWith: new Error("azure 500") });
    registerImageVendor(seedream);
    registerImageVendor(azure);
    const resp = await generateImage({ prompt: "x", role: "concept-art", vendor: "azure-gpt-image" });
    expect(resp.triedVendors).toEqual(["azure-gpt-image:err", "seedream"]);
    expect(resp.vendor).toBe("seedream");
  });
});

describe("litellm-images vendor", () => {
  test("isReady=false when LITELLM_PROXY_IMAGE_MODEL unset", () => {
    process.env.LITELLM_PROXY_BASE_URL = "https://proxy.test/v1";
    process.env.LITELLM_PROXY_KEY = "sk-x";
    delete process.env.LITELLM_PROXY_IMAGE_MODEL;
    const v = createLitellmImagesVendor();
    expect(v.isReady()).toBe(false);
  });

  test("isReady=true when all 3 env vars present", () => {
    process.env.LITELLM_PROXY_BASE_URL = "https://proxy.test/v1";
    process.env.LITELLM_PROXY_KEY = "sk-x";
    process.env.LITELLM_PROXY_IMAGE_MODEL = "seedream-v5";
    const v = createLitellmImagesVendor();
    expect(v.isReady()).toBe(true);
  });

  test("builds OpenAI-shape request body; decodes b64_json → pngBytes", async () => {
    let captured: { url?: string; body?: Record<string, unknown> } = {};
    // 4-byte PNG signature; gateway expects something decodable from base64
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const b64 = Buffer.from(fakePng).toString("base64");

    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      captured.body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 });
    }) as typeof fetch;

    const v = createLitellmImagesVendor({
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
      defaultModel: "seedream-v5",
      fetcher,
    });

    const r = await v.generate({ prompt: "tiny cat", size: "2k" });
    expect(captured.url).toBe("https://proxy.test/v1/images/generations");
    expect(captured.body).toEqual({
      model: "seedream-v5",
      prompt: "tiny cat",
      n: 1,
      size: "1024x1536",
      response_format: "b64_json",
    });
    expect(r.vendor).toBe("litellm-images");
    expect(r.modelId).toBe("seedream-v5");
    expect(r.mime).toBe("image/png");
    expect(Array.from(r.pngBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("modelOverride wins over defaultModel", async () => {
    let body: Record<string, unknown> | undefined;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(init?.body as string);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from(png).toString("base64") }],
      }), { status: 200 });
    }) as typeof fetch;

    const v = createLitellmImagesVendor({
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
      defaultModel: "default-img",
      fetcher,
    });
    await v.generate({ prompt: "x", modelOverride: "premium-img" });
    expect((body as Record<string, unknown>).model).toBe("premium-img");
  });

  test("HTTP error → throws with proxy message", async () => {
    const fetcher = (async () => new Response(JSON.stringify({
      error: { message: "Invalid model name" },
    }), { status: 400 })) as unknown as typeof fetch;
    const v = createLitellmImagesVendor({
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
      defaultModel: "fake-model",
      fetcher,
    });
    await expect(v.generate({ prompt: "x" })).rejects.toThrow(/Invalid model name/);
  });

  test("missing data[0].b64_json → throws", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ data: [{ url: "https://..." }] }), { status: 200 })) as unknown as typeof fetch;
    const v = createLitellmImagesVendor({
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
      defaultModel: "m",
      fetcher,
    });
    await expect(v.generate({ prompt: "x" })).rejects.toThrow(/missing data\[0\]\.b64_json/);
  });
});

describe("end-to-end via gateway with litellm-images vendor registered", () => {
  test("falls back to litellm-images when direct vendors fail / are unready", async () => {
    registerImageVendor(mockVendor("seedream", { ready: false }));
    registerImageVendor(mockVendor("nano-banana", { failWith: new Error("gemini quota") }));
    registerImageVendor(mockVendor("azure-gpt-image", { failWith: new Error("azure 429") }));

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xaa]);
    const fetcher = (async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from(png).toString("base64") }],
    }), { status: 200 })) as unknown as typeof fetch;

    registerImageVendor(createLitellmImagesVendor({
      baseUrl: "https://proxy.test/v1",
      apiKey: "sk-test",
      defaultModel: "seedream-proxy-v1",
      fetcher,
    }));

    const resp = await generateImage({ prompt: "tiny cat", role: "concept-art" });
    expect(resp.vendor).toBe("litellm-images");
    expect(resp.modelId).toBe("seedream-proxy-v1");
    expect(resp.triedVendors).toEqual([
      "seedream:no-key",
      "nano-banana:err",
      "azure-gpt-image:err",
      "litellm-images",
    ]);
  });
});
