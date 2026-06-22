// @desc Enhanced web fetch with fast (HTTP) and deep (headless browser) modes
import type { ToolDefinition, AgentContext } from "#src/core/types.js";
import { getTerminalManager } from "#src/terminal/manager.js";
import { getSandboxFs } from "#src/sandbox/fs-bridge.js";
import { getSandboxManager } from "#src/sandbox/manager.js";

const DEFAULT_MAX_LENGTH = 80_000;
const BROWSER_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PW_HELPER = "/tmp/_agenteam_pw_fetch.py";

// Only cache positive state — retries on every call until first success
let _pwReady = false;
let _lastBrowserError = "";

// ── Python helper (written to container on first use) ───────────────
const PW_SCRIPT = `#!/usr/bin/env python3
"""Headless Chromium fetch — SPA wait + structured extraction."""
import sys, json

def write_result(path, data):
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False)

def main():
    url = sys.argv[1]
    result_path = sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 30000
    ua = sys.argv[4] if len(sys.argv) > 4 else "Mozilla/5.0"

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        write_result(result_path, {"ok": False, "error": "playwright not installed"})
        return

    browser = None
    try:
        pw = sync_playwright().start()
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(
            user_agent=ua,
            viewport={"width": 1920, "height": 1080},
            locale="zh-CN",
        )
        page = context.new_page()

        try:
            page.goto(url, timeout=timeout, wait_until="networkidle")
        except Exception:
            pass

        # SPA hydration: wait + progressive scroll
        page.wait_for_timeout(2500)
        height = page.evaluate("document.body.scrollHeight") or 3000
        for i in range(4):
            page.evaluate(f"window.scrollTo(0, {int(height * (i + 1) / 4)})")
            page.wait_for_timeout(800)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(500)

        html = page.content()
        final_url = page.url

        # Extract raw SPA state (generic)
        spa_data = page.evaluate("""() => {
            const CAP = 8000;
            const snap = (obj) => { try { const s = JSON.stringify(obj); return s.length > CAP ? s.substring(0, CAP) + '\\u2026' : s; } catch(e) { return null; } };
            const r = {};
            if (window.__INITIAL_STATE__)  r.__INITIAL_STATE__  = snap(window.__INITIAL_STATE__);
            if (window.__NEXT_DATA__)      r.__NEXT_DATA__      = snap(window.__NEXT_DATA__);
            if (window.__NUXT__)           r.__NUXT__           = snap(window.__NUXT__);
            return Object.keys(r).length > 0 ? r : null;
        }""")

        # Extract Shadow DOM text (best-effort, skip CSS-heavy fragments)
        shadow_text = None
        try:
            shadow_text = page.evaluate("""() => {
                const parts = [];
                for (const h of document.querySelectorAll('*')) {
                    try {
                        const sr = h.shadowRoot;
                        if (!sr) continue;
                        const t = sr.textContent?.trim();
                        if (!t || t.length < 20) continue;
                        const cssHits = (t.match(/[:;{}]|var\\\\(--|\\\\bhost\\\\b/g) || []).length;
                        if (cssHits / t.length > 0.03) continue;
                        parts.push(t.substring(0, 2000));
                    } catch(e) {}
                }
                return parts.length > 0 ? parts.join('\\\\n---\\\\n') : null;
            }""")
        except Exception:
            pass

        browser.close()
        browser = None
        pw.stop()

        out = {"ok": True, "html": html, "final_url": final_url}
        if spa_data:
            out["spa_data"] = spa_data
        if shadow_text:
            out["shadow_text"] = shadow_text
        write_result(result_path, out)
    except Exception as e:
        write_result(result_path, {"ok": False, "error": str(e)})
    finally:
        try:
            if browser:
                browser.close()
        except Exception:
            pass

if __name__ == "__main__":
    main()
`;

// ── HTML → readable text ────────────────────────────────────────────
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncate(text: string, max: number): { content: string; truncated: boolean } {
  if (text.length <= max) return { content: text, truncated: false };
  return { content: text.slice(0, max) + "\n\n[Content truncated]", truncated: true };
}

// ── Playwright lifecycle ────────────────────────────────────────────

// Returns null on success, error string on failure.
async function ensurePlaywright(ctx: AgentContext): Promise<string | null> {
  if (_pwReady) return null;

  const tm = getTerminalManager();
  const opts = (timeout: number) => ({ agentId: ctx.agentId, timeout });
  const isDirect = getSandboxManager()?.getMode() === "direct";

  const py = await tm.exec("python3 --version && echo PY_OK", opts(5000));
  if (!py.stdout.includes("PY_OK")) {
    return isDirect
      ? "宿主机未找到 python3，请手动安装后重试。"
      : "python3 not found in container.";
  }

  const pw = await tm.exec('python3 -c "from playwright.sync_api import sync_playwright; print(\'PW_OK\')"', opts(10_000));
  if (pw.stdout.includes("PW_OK")) {
    _pwReady = true;
    return null;
  }

  if (isDirect) {
    return "宿主机模式不自动安装依赖，请手动运行：pip install playwright && python3 -m playwright install chromium";
  }

  console.warn("[web_fetch] Installing playwright + chromium…");
  const inst = await tm.exec(
    "python3 -m pip install --user --break-system-packages playwright && python3 -m playwright install chromium && echo INSTALL_OK",
    opts(180_000),
  );
  if (inst.stdout.includes("INSTALL_OK")) {
    console.warn("[web_fetch] Playwright ready");
    _pwReady = true;
    return null;
  }
  return `playwright/chromium 自动安装失败。stdout: ${inst.stdout.slice(-300) || "(empty)"}`;
}

interface BrowserResult {
  html: string;
  finalUrl: string;
  spaData?: Record<string, unknown>;
  shadowText?: string;
}

async function fetchWithBrowser(url: string, ctx: AgentContext): Promise<BrowserResult | null> {
  const tm = getTerminalManager();
  const fs = getSandboxFs();

  fs.writeTextSync(PW_HELPER, PW_SCRIPT);

  const uid = `${ctx.agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outPath = `/tmp/_pw_out_${uid}.json`;

  const safeUrl = url.replace(/'/g, "'\\''");
  const execResult = await tm.exec(
    `python3 ${PW_HELPER} '${safeUrl}' '${outPath}' ${BROWSER_TIMEOUT_MS} '${CHROME_UA}'`,
    { agentId: ctx.agentId, timeout: BROWSER_TIMEOUT_MS + 30_000 },
  );

  if (execResult.backgrounded) {
    try { fs.unlinkSync(outPath); } catch { /* best effort */ }
    _lastBrowserError = `process exceeded ${(BROWSER_TIMEOUT_MS + 30_000) / 1000}s and was backgrounded`;
    return null;
  }

  let browserError = "page may have timed out or crashed";
  try {
    const raw = fs.readTextSync(outPath);
    const r = JSON.parse(raw);
    if (r.ok && r.html) {
      return {
        html: r.html,
        finalUrl: r.final_url ?? url,
        spaData: r.spa_data ?? undefined,
        shadowText: r.shadow_text ?? undefined,
      };
    }
    if (r.error) browserError = r.error;
  } catch { /* missing or malformed — keep default message */ }
  finally {
    try { fs.unlinkSync(outPath); } catch { /* best effort */ }
  }
  _lastBrowserError = browserError;
  return null;
}

// ── Simple HTTP fetch ───────────────────────────────────────────────

async function fetchSimple(
  url: string,
  maxLength: number,
): Promise<{ content: string; url: string; truncated: boolean; error?: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": CHROME_UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: unknown) {
    const reason = e instanceof Error && e.name === "TimeoutError"
      ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
      : (e instanceof Error ? e.message : String(e));
    return { content: "", url, truncated: false, error: reason };
  }
  if (!res.ok) {
    return { content: "", url, truncated: false, error: `HTTP ${res.status} ${res.statusText}` };
  }
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = ct.includes("text/html") ? htmlToText(raw) : raw;
  const { content, truncated } = truncate(text, maxLength);
  return { content, url, truncated };
}

// ── Tool definition ─────────────────────────────────────────────────

export default {
  name: "web_fetch",
  description:
    "Fetch a URL and return its content as plain text. HTML is automatically converted to readable text. Follows redirects. " +
    "Two modes: **fast** (default) uses simple HTTP with Chrome UA — lightweight and instant. " +
    "**deep** uses a headless browser for full JS rendering, SPA data extraction " +
    "(__INITIAL_STATE__/__NEXT_DATA__/__NUXT__ auto-extracted into spa_data), " +
    "and Shadow DOM content — slower (~15s) but handles dynamic pages. " +
    "Use deep when fast returns incomplete/empty content (SPA sites, anti-bot pages).",
  input_schema: {
    type: "object" as const,
    properties: {
      url: { type: "string", description: "URL to fetch" },
      mode: {
        type: "string",
        enum: ["fast", "deep"],
        description: "fast (default): simple HTTP, instant. deep: headless browser with JS rendering, ~15s.",
      },
      max_length: {
        type: "number",
        description: "Maximum content length in characters (default: 80000)",
      },
    },
    required: ["url"],
  },
  serial: false,
  compactResult(args, result) {
    const preview = result.slice(0, 500);
    return `[web_fetch "${args.url}"]\n${preview}...`;
  },
  async execute(args, ctx) {
    const url = String(args.url);
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return JSON.stringify({ error: `Invalid URL: "${url}" could not be parsed.`, url });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return JSON.stringify({ error: `Only http:// and https:// URLs are supported (got ${parsed.protocol}).`, url });
    }
    const rawMax = args.max_length ?? DEFAULT_MAX_LENGTH;
    const maxLen = Number.isFinite(Number(rawMax)) ? Number(rawMax) : DEFAULT_MAX_LENGTH;
    const mode = (args.mode as string) === "deep" ? "deep" : "fast";

    // ── fast: simple HTTP with Chrome UA ──
    if (mode === "fast") {
      const simple = await fetchSimple(url, maxLen);
      if (simple.error) {
        return JSON.stringify({ error: simple.error, url });
      }
      return JSON.stringify({
        content: simple.content,
        url: simple.url,
        length: simple.content.length,
        truncated: simple.truncated,
      });
    }

    // ── deep: headless browser ──
    let pwErr: string | null = "ensurePlaywright threw unexpectedly";
    try { pwErr = await ensurePlaywright(ctx); } catch (e) {
      pwErr = e instanceof Error ? e.message : String(e);
    }

    if (pwErr !== null) {
      return JSON.stringify({ error: `Headless browser unavailable — ${pwErr}`, url });
    }

    _lastBrowserError = "";
    const r = await fetchWithBrowser(url, ctx);
    if (!r) {
      return JSON.stringify({ error: `Headless browser fetch failed — ${_lastBrowserError || "unknown error"}`, url });
    }

    const text = htmlToText(r.html);
    const { content, truncated } = truncate(text, maxLen);
    const out: Record<string, unknown> = { content, url: r.finalUrl, length: content.length, truncated };
    if (r.spaData) out.spa_data = r.spaData;
    if (r.shadowText) out.shadow_text = r.shadowText;
    return JSON.stringify(out);
  },
} satisfies ToolDefinition;
