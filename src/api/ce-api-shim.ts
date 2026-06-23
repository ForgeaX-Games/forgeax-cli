/**
 * /__ce-api__/* —— studio-host shim for the wb-character iframe plugin.
 *
 * Background: packages/marketplace/plugins/wb-character/src/* still hits the
 * vite-dev plugin's `/__ce-api__/<endpoint>` (88 call sites) through plain
 * fetch — Bridge.ts STUDIO_HOST_MODE was defined but the call sites bypass it.
 * The submodule is built as static assets and served at /plugins/wb-character/*
 * by main.ts, so without this shim every "generate portrait / pixel / spine /
 * vfx" click would 404.
 *
 * Strategy: terminate the legacy endpoints here, forward to existing host libs
 * (image-gateway ImageDispatcher, lib/llm-gateway, raw FS for persistence).
 * Submodule code stays unchanged — this is the 接线层 until we push the iframe
 * to use Bridge.ts → /api/wb/character/*.
 *
 * Envelope convention: every response is `{success: boolean, ...}` with HTTP
 * 200 even on failure (Hono `c.json`). The iframe checks `success` first and
 * renders `error` inline; an HTTP-level error would manifest as "network
 * failure" toast and lose context.
 *
 * Wired for Spine: /gemini-text with inputImages (vision prompt), /generate-image
 * with multiple inputImages or aspectRatio (Gemini multi-ref image gen).
 *
 * Deferred (returns 503): monster/**, video-generate, analyze-ultimate,
 * magic-prompt, remove-bg, enhance-prompt, pixelart, character-turnaround.
 * These need Python pipelines / MCP servers that aren't wired in studio. The
 * iframe surfaces a friendly toast on 503 — see VFX_CHANGES.md.
 */

import { Hono } from 'hono';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { complete, type ChatMessage } from '../lib/llm-gateway';
import { ImageDispatcher } from '../lib/image-gateway/clients/dispatcher';
import { vendorForModel } from '../lib/image-gateway';
import { createLitellmSpeech, litellmTtsConfigured } from '../lib/audio-gateway/litellm-tts';
import { createDoubaoSpeech, doubaoTtsConfigured } from '../lib/audio-gateway/doubao-tts';
import { createMinimaxSpeech, minimaxTtsConfigured } from '../lib/audio-gateway/minimax-tts';
import { createMinimaxMusic, minimaxMusicConfigured } from '../lib/audio-gateway/minimax-music';
import {
  createLitellmVideoTask,
  getLitellmVideoStatus,
  downloadLitellmVideoContent,
  litellmVideoConfigured,
} from '../lib/video-gateway/litellm-video';
import {
  arkVideoConfigured,
  createArkVideoTask,
  getArkVideoStatus,
  downloadArkVideoContent,
  isArkTaskId,
} from '../lib/video-gateway/ark-video';

/** marketplace UI 资产清洗能力 —— 由产品壳(server)注入,编排层**不直接依赖 marketplace**。
 *  结构化类型(不 import marketplace 的具体类型);未注入时清洗步骤优雅跳过(用原图)。 */
export interface UiAssetCanvasReport {
  opaqueEdgePixels: number;
  transparentCornerDirtyPixels: number;
  fragmentationRatio: number;
  largestComponentRatio: number;
  opaqueBoundsFillRatio: number;
}
export interface UiAssetCleanup {
  normalizeStandaloneUiAsset(
    dataUrl: string,
    options?: { mode?: 'icon' | 'chrome'; fillRatio?: number; chromeEdgeRefine?: 'dark-ui' | undefined },
  ): Promise<string>;
  inspectUiAssetCanvas(dataUrl: string): Promise<UiAssetCanvasReport>;
}

export interface CeApiShimCtx {
  projectRoot: string;
  env: Record<string, string | undefined>;
  /** 注入的 UI 资产清洗能力(marketplace 后端)。缺省 ⇒ 跳过清洗、用原图。 */
  uiAssetCleanup?: UiAssetCleanup;
}

/** 产品壳注入的清洗能力(router 创建时由 createCeApiShimRouter 设置)。 */
let injectedUiAssetCleanup: UiAssetCleanup | undefined;

// All shim-owned state lives under <projectRoot>/.forgeax/wb-character/. The
// host already whitelists .forgeax/games for /api/files; wb-character/ is a
// sibling tree (settings + spine sessions + character-export). Workspace
// games live at .forgeax/games/<gameId>/ per project_packages_layout.md.
function shimRoot(ctx: CeApiShimCtx): string {
  return resolve(ctx.projectRoot, '.forgeax/wb-character');
}
function workspaceGamesDir(ctx: CeApiShimCtx): string {
  return resolve(ctx.projectRoot, '.forgeax/games');
}
function spineDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'spine');
}
function spineHistoryDir(ctx: CeApiShimCtx): string {
  return resolve(spineDir(ctx), 'history');
}
function characterExportDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'character-export');
}
// wb-reel 视频任务下载后的同源 mp4 落盘目录(host 代下,iframe 永不见网关 key).
function reelVideoDir(ctx: CeApiShimCtx): string {
  return resolve(shimRoot(ctx), 'reel-videos');
}
const MAX_SPINE_HISTORY = 20;

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length < 128 && /^[a-zA-Z0-9][a-zA-Z0-9_\-]*$/.test(id);
}

function b64ToFile(dataUrl: string, filePath: string): void {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    writeFileSync(filePath, dataUrl, 'utf-8');
    return;
  }
  writeFileSync(filePath, Buffer.from(match[2], 'base64'));
}

function fileToB64(filePath: string, mime = 'image/png'): string | null {
  if (!existsSync(filePath)) return null;
  return `data:${mime};base64,${readFileSync(filePath).toString('base64')}`;
}

interface GenerateImageBody {
  prompt?: string;
  model?: string;
  aspectRatio?: string;
  imageSize?: string;
  inputImageBase64?: string;
  inputImages?: Array<{ base64: string; mimeType?: string }>;
  role?: 'concept-art' | 'sprite-frame';
}

interface GeminiTextBody {
  prompt?: string;
  system?: string;
  model?: string;
  inputImages?: Array<{ base64: string; mimeType?: string }>;
}

interface ChatBody {
  messages?: Array<{ role: string; content: string | unknown }>;
  system?: string;
  model?: string;
  maxTokens?: number;
}

type UiAssetKind = 'buttonNormal' | 'buttonPrimary' | 'titleDeco' | 'panelTexture' | 'icons' | 'background' | 'npc' | 'shopItems' | 'weapons';

interface UiDesignGenerateAssetsBody {
  genre?: string;
  style?: string;
  styleTone?: string;
  screens?: string[];
  sceneDesc?: string;
  styleBoardPrompt?: string;
  assetPromptNotes?: string;
  assetKinds?: UiAssetKind[];
  styleKey?: string;
  genreKey?: string;
  generationNonce?: string;
  generationAttempt?: number;
}

interface UiGeneratedAssets {
  backgrounds: Record<string, string>;
  npc?: string;
  shopItems: string[];
  weapons: string[];
  panelTexture?: string;
  icons: string[];
  buttonNormal?: string;
  buttonPrimary?: string;
  titleDeco?: string;
}

function imageBytesToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function getMcpHost(): string {
  return process.env.MCP_HOST || '127.0.0.1';
}

function getMcpGeminiImagePort(): number {
  return Number(process.env.MCP_GEMINI_IMAGE_PORT || '3100');
}

function getMcpJimengImagePort(): number {
  return Number(process.env.MCP_JIMENG_IMAGE_PORT || '3103');
}

function mcpCall(host: string, port: number, tool: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolveMcp, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: tool, arguments: args },
      id: Date.now(),
    });
    const req = httpRequest({
      hostname: host,
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 180_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try { resolveMcp(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('MCP parse error: ' + e)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('MCP timeout')); });
    req.write(payload);
    req.end();
  });
}

function dataUrlFromMcpResult(result: any): string | null {
  const content = result?.result?.content ?? result?.content ?? [];
  for (const item of content) {
    if (item?.type === 'image' && item?.data) {
      return `data:${item.mimeType ?? 'image/png'};base64,${item.data}`;
    }
    const textPath = typeof item?.text === 'string'
      ? item.text.match(/workspace[\\/][^\s"'`]+?\.(?:png|jpg|jpeg|webp)/i)?.[0]
      : '';
    const pathValue = item?.path || item?.file || textPath;
    if (typeof pathValue === 'string') {
      const absPath = resolve(ctxProjectRootForMcpOutput(), pathValue.replace(/^workspace[\\/]/, ''));
      if (existsSync(absPath)) {
        const buf = readFileSync(absPath);
        const ext = absPath.split('.').pop()?.toLowerCase();
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
        return `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
  }
  return null;
}

async function mcpTextToImage(prompt: string, outputPath: string, aspectRatio = '1:1'): Promise<string | null> {
  const host = getMcpHost();
  const providers = [
    {
      name: 'Gemini',
      port: getMcpGeminiImagePort(),
      args: { prompt, outputPath, aspectRatio },
    },
  ];

  let lastError = '';
  for (const provider of providers) {
    try {
      const result = await mcpCall(host, provider.port, 'text_to_image', provider.args);
      const dataUrl = dataUrlFromMcpResult(result);
      if (dataUrl) return dataUrl;
      const text = (result?.result?.content ?? result?.content ?? [])
        .map((item: any) => typeof item?.text === 'string' ? item.text : '')
        .filter(Boolean)
        .join(' ');
      const textPath = text.match(/workspace[\\/][^\s"'`]+?\.(?:png|jpg|jpeg|webp)/i)?.[0];
      if (textPath && /successfully completed/i.test(text)) {
        throw new Error(`${provider.name} MCP 已生成图片，但当前运行中的 MCP 服务仍只返回内部文件路径 ${textPath}，没有返回 image/base64。请重启 image-gemini MCP 进程加载已更新的 server.py。`);
      } else if (text) {
        lastError = text;
      }
    } catch (e) {
      lastError = (e as Error).message;
      if (lastError.includes('MCP 已生成图片')) {
        break;
      }
    }
  }
  if (lastError) throw new Error(lastError);
  return null;
}

function ctxProjectRootForMcpOutput(): string {
  return process.env.FORGEAX_PROJECT_ROOT ?? resolve(import.meta.dir, '../../..');
}

function uiDesignOutputPrefix(body: UiDesignGenerateAssetsBody): string {
  const sig = createHash('sha1').update(JSON.stringify({
    genre: body.genre,
    style: body.style,
    styleKey: body.styleKey,
    genreKey: body.genreKey,
    styleTone: body.styleTone,
    styleBoardPrompt: body.styleBoardPrompt,
    assetPromptNotes: body.assetPromptNotes,
    generationNonce: body.generationNonce,
    generationAttempt: body.generationAttempt,
  })).digest('hex').slice(0, 10);
  const genreSlug = String(body.genreKey || body.genre || 'ui').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const styleSlug = String(body.styleKey || body.style || 'style').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `workspace/images/ui-design-proto/${genreSlug}-${styleSlug}-${sig}`;
}

function buildUiAssetPrompt(kind: string, body: UiDesignGenerateAssetsBody, variant = ''): string {
  const genre = body.genre ?? '游戏';
  const style = body.style ?? body.styleKey ?? 'modern game UI';
  const tone = body.styleTone ? `Style tone: ${body.styleTone}.` : '';
  const notes = [body.styleBoardPrompt, body.assetPromptNotes].filter(Boolean).join(' ');
  const seed = body.generationNonce ? `Fresh generation seed: ${body.generationNonce}, attempt ${body.generationAttempt ?? 1}.` : '';
  const common = [
    `Create ONE standalone game UI asset for ${genre}.`,
    `Visual style: ${style}.`,
    tone,
    notes ? `Extra direction: ${notes}.` : '',
    seed,
    'CRITICAL: Do not output a full UI screenshot, mockup board, labels, captions, characters, or multiple components.',
    'Place the asset on one flat pure magenta #FF00FF chroma-key background with visible margin on every side for cutout cleanup.',
  ].filter(Boolean).join(' ');

  if (kind === 'buttonPrimary') return `${common} Asset: primary CTA button background texture only, wide 4:1 rectangle, premium highlighted state, no text, no icons.`;
  if (kind === 'buttonNormal') return `${common} Asset: secondary/normal button background texture only, wide 4:1 rectangle, quieter state than primary, no text, no icons.`;
  if (kind === 'titleDeco') return `${common} Asset: decorative title/header strip only, wide ornamental frame, no readable text, no buttons, no icons.`;
  if (kind === 'panelTexture') return `${common} Asset: standalone UI panel frame or panel texture, square 1:1, all four edges visible, no text, no icons.`;
  if (kind === 'icons') {
    const iconSubjects = ['crossed sword attack', 'shield defense', 'backpack inventory', 'glowing star quest'];
    const match = variant.match(/\d+/);
    const subject = match ? iconSubjects[(Number(match[0]) - 1) % iconSubjects.length] : 'skill symbol';
    return `${common} Asset: one ${subject} icon only, centered clear silhouette, transparent-ready, no text, no frame, no UI page.`;
  }
  if (kind === 'background') return [
    `Create a game UI-readable background scene for ${genre}.`,
    `Visual style: ${style}.`,
    tone,
    notes ? `Extra direction: ${notes}.` : '',
    seed,
    `Screen context: ${variant || 'game screen'}.`,
    'Dark/desaturated enough for UI overlays, no UI elements, no text.',
  ].filter(Boolean).join(' ');
  return `${common} Asset: standalone UI prop ${variant}, centered, no text.`;
}

async function generateUiDesignAsset(
  body: UiDesignGenerateAssetsBody,
  kind: UiAssetKind,
  variant = '',
): Promise<string | null> {
  const prompt = buildUiAssetPrompt(kind, body, variant);
  const prefix = uiDesignOutputPrefix(body);
  const fileName = `${kind}${variant ? '-' + variant.replace(/[^a-z0-9-]/gi, '-') : ''}.png`;
  const aspectRatio = kind === 'background'
    ? '16:9'
    : kind === 'buttonPrimary' || kind === 'buttonNormal' || kind === 'titleDeco'
      ? '21:9'
      : '1:1';
  const raw = await mcpTextToImage(prompt, `${prefix}/${fileName}`, aspectRatio);
  if (!raw) return null;
  if (kind === 'background') return raw;

  // 资产清洗由产品壳注入(marketplace 后端);未注入 ⇒ 跳过清洗、直接返回原图(优雅降级)。
  const cleanup = injectedUiAssetCleanup;
  if (!cleanup) return raw;

  const normalized = await cleanup.normalizeStandaloneUiAsset(raw, {
    mode: kind === 'icons' || kind === 'npc' || kind === 'shopItems' || kind === 'weapons' ? 'icon' : 'chrome',
    fillRatio: kind === 'icons' || kind === 'npc' || kind === 'shopItems' || kind === 'weapons' ? 0.62 : 0.9,
    chromeEdgeRefine: body.styleKey === 'sci-fi' || body.styleKey === 'realistic-military' ? 'dark-ui' : undefined,
  });
  const report = await cleanup.inspectUiAssetCanvas(normalized);
  const strictCutoutIssue = kind === 'icons' || kind === 'npc' || kind === 'shopItems' || kind === 'weapons'
    ? report.opaqueEdgePixels > 6
      || report.transparentCornerDirtyPixels > 24
      || report.fragmentationRatio > 0.42
      || report.largestComponentRatio < 0.58
      || report.opaqueBoundsFillRatio > 0.88
    : report.opaqueEdgePixels > 0
      || report.transparentCornerDirtyPixels > 0
      || report.fragmentationRatio > 0.42
      || report.largestComponentRatio < 0.56;

  // Gemini can produce valid chrome assets that fail strict cutout heuristics
  // after cleanup. The UI must not stay in loading because a real generated
  // asset was discarded by an over-strict quality gate.
  if (strictCutoutIssue) {
    console.warn(`[ui-design/generate-assets] ${kind} cutout inspection warning`, report);
  }
  return normalized;
}

async function handleUiDesignGenerateAssetsReal(ctx: CeApiShimCtx, body: UiDesignGenerateAssetsBody): Promise<Record<string, unknown>> {
  const screens = Array.isArray(body.screens) ? body.screens.filter((v): v is string => typeof v === 'string') : [];
  const assetKinds = Array.isArray(body.assetKinds) ? new Set(body.assetKinds) : new Set<UiAssetKind>();
  const wants = (kind: UiAssetKind): boolean => assetKinds.size === 0 || assetKinds.has(kind);
  const assets: UiGeneratedAssets = { backgrounds: {}, shopItems: [], weapons: [], icons: [] };
  const failedKinds: string[] = [];

  try {
    if (wants('buttonPrimary')) {
      assets.buttonPrimary = await generateUiDesignAsset(body, 'buttonPrimary') ?? undefined;
      if (!assets.buttonPrimary) failedKinds.push('buttonPrimary');
    }
    if (wants('buttonNormal')) {
      assets.buttonNormal = await generateUiDesignAsset(body, 'buttonNormal') ?? undefined;
      if (!assets.buttonNormal) failedKinds.push('buttonNormal');
    }
    if (wants('titleDeco')) {
      assets.titleDeco = await generateUiDesignAsset(body, 'titleDeco') ?? undefined;
      if (!assets.titleDeco) failedKinds.push('titleDeco');
    }
    if (wants('panelTexture')) {
      assets.panelTexture = await generateUiDesignAsset(body, 'panelTexture') ?? undefined;
      if (!assets.panelTexture) failedKinds.push('panelTexture');
    }
    if (wants('icons')) {
      for (let i = 0; i < 4; i += 1) {
        const icon = await generateUiDesignAsset(body, 'icons', `icon ${i + 1}`);
        assets.icons[i] = icon ?? '';
        if (!icon) failedKinds.push(`icons:${i}`);
      }
    }
    if (wants('background')) {
      for (const screen of screens) {
        const bg = await generateUiDesignAsset(body, 'background', screen);
        if (bg) assets.backgrounds[screen] = bg;
        else failedKinds.push(`background:${screen}`);
      }
    }
    if (failedKinds.length > 0) {
      return { success: false, error: `组件生成失败: ${failedKinds.join(', ')}`, assets, failedKinds };
    }
    return { success: true, assets };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'UI 组件素材生成失败', assets, failedKinds };
  }
}

function getGeminiKey(env: Record<string, string | undefined>): string {
  return (env.GEMINI_API_KEY ?? env.GOOGLE_GEN_AI_KEY ?? '').trim();
}

function cleanB64(data: string): string {
  return data.replace(/^data:[^;]+;base64,/, '');
}

/** Image-gen model ids must not be used for TEXT modality (Spine prompt step). */
function resolveGeminiTextModel(requested?: string): string {
  const m = requested?.trim();
  // Use gemini-2.5-flash as the vision-capable text model — fast, stable, supports images.
  if (!m) return 'gemini-2.5-flash';
  if (m.includes('image')) return 'gemini-2.5-flash';
  return m;
}

async function geminiGenerateContent(
  env: Record<string, string | undefined>,
  model: string,
  payload: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const apiKey = getGeminiKey(env);
  if (!apiKey) {
    return { ok: false, error: '未配置 GEMINI_API_KEY，请在 Studio .env 中设置后重启服务' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({})) as { error?: { message?: string } };
    if (!r.ok) {
      return { ok: false, error: j.error?.message || `Gemini API 错误 (${r.status})` };
    }
    return { ok: true, data: j };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Gemini 网络请求失败' };
  }
}

async function shimGeminiMultimodalText(
  env: Record<string, string | undefined>,
  body: GeminiTextBody,
): Promise<{ success: boolean; text?: string; error?: string }> {
  const model = resolveGeminiTextModel(body.model);
  const parts: Array<Record<string, unknown>> = [];
  for (const img of body.inputImages ?? []) {
    parts.push({
      inlineData: { mimeType: img.mimeType || 'image/png', data: cleanB64(img.base64) },
    });
  }
  parts.push({ text: body.prompt });
  const result = await geminiGenerateContent(env, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['TEXT'], temperature: 1.0, maxOutputTokens: 4096 },
  });
  if (!result.ok) return { success: false, error: result.error };
  const data = result.data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) return { success: false, error: '模型未返回文本内容' };
  return { success: true, text };
}

async function shimGeminiMultimodalImage(
  env: Record<string, string | undefined>,
  body: GenerateImageBody,
): Promise<{ success: boolean; imageBase64?: string; mimeType?: string; error?: string }> {
  const model = body.model?.trim() || 'gemini-2.5-flash-image';
  const parts: Array<Record<string, unknown>> = [];
  if (body.inputImageBase64) {
    parts.push({ inlineData: { mimeType: 'image/png', data: cleanB64(body.inputImageBase64) } });
  }
  for (const img of body.inputImages ?? []) {
    parts.push({
      inlineData: { mimeType: img.mimeType || 'image/png', data: cleanB64(img.base64) },
    });
  }
  parts.push({ text: body.prompt });
  const genConfig: Record<string, unknown> = { responseModalities: ['IMAGE'], temperature: 1.0 };
  const imgCfg: Record<string, string> = {};
  if (body.aspectRatio) imgCfg.aspectRatio = body.aspectRatio;
  if (body.imageSize) imgCfg.imageSize = body.imageSize;
  if (Object.keys(imgCfg).length > 0) genConfig.imageConfig = imgCfg;

  const result = await geminiGenerateContent(env, model, {
    contents: [{ role: 'user', parts }],
    generationConfig: genConfig,
  });
  if (!result.ok) return { success: false, error: result.error };
  const data = result.data as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }>;
    promptFeedback?: { blockReason?: string };
  };
  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return {
          success: true,
          imageBase64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || 'image/png',
        };
      }
    }
  }
  if (data.promptFeedback?.blockReason) {
    return { success: false, error: `内容被拦截: ${data.promptFeedback.blockReason}` };
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return { success: false, error: text || '模型未返回图片' };
}

function needsGeminiImageRoute(body: GenerateImageBody): boolean {
  const model = body.model?.trim() ?? '';
  return model.startsWith('gemini')
    || (body.inputImages?.length ?? 0) > 1
    || Boolean(body.aspectRatio);
}

export function createCeApiShimRouter(ctx: CeApiShimCtx): Hono {
  // 记录产品壳注入的 UI 资产清洗能力,供模块级 generateUiDesignAsset 使用。
  injectedUiAssetCleanup = ctx.uiAssetCleanup;
  const app = new Hono();

  // wb-ui is served as static iframe assets in Studio, so its original Vite
  // dev plugin is not present. This host shim must perform real image
  // generation + cleanup; returning deterministic SVGs here makes step 3 look
  // like it "generated" without ever touching the image backend.
  app.post('/ui-design/generate-assets', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    return c.json(await handleUiDesignGenerateAssetsReal(ctx, body as UiDesignGenerateAssetsBody));
  });

  // ── POST /generate-image ──────────────────────────────────────────────
  // The iframe expects: { success, imageBase64, mimeType }
  // We route through ImageDispatcher (registers seedream / nano-banana /
  // azure-gpt-image / litellm-images on construction, fallback chain wired).
  app.post('/generate-image', async (c) => {
    let body: GenerateImageBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });

    // Spine 拆件 / 多参考图 / 指定宽高比 → 直连 Gemini 多模态生图（与 wb-anim dev 插件一致）。
    if (needsGeminiImageRoute(body)) {
      return c.json(await shimGeminiMultimodalImage(ctx.env, body));
    }

    const refImageBase64 = body.inputImageBase64 ?? body.inputImages?.[0]?.base64;
    const dispatcher = new ImageDispatcher(ctx.env);
    const role = body.role ?? 'concept-art';
    const requestedModel = body.model?.trim() || undefined;
    const preferredVendor = vendorForModel(requestedModel);
    try {
      const r = await dispatcher.generate(role, {
        prompt,
        size: '2k',
        refImageBase64,
        modelOverride: requestedModel,
      }, preferredVendor);
      return c.json({
        success: true,
        imageBase64: Buffer.from(r.pngBytes).toString('base64'),
        mimeType: r.mime,
        vendor: r.vendor,
        modelId: r.modelId,
        triedVendors: r.triedVendors,
      });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '图像生成失败' });
    } finally {
      dispatcher.dispose();
    }
  });

  // ── POST /gemini-text ────────────────────────────────────────────────
  // Iframe expects: { success, text }
  // Multimodal (inputImages) → 501 for now (llm-gateway.complete is text-only).
  app.post('/gemini-text', async (c) => {
    let body: GeminiTextBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });
    if (Array.isArray(body.inputImages) && body.inputImages.length > 0) {
      return c.json(await shimGeminiMultimodalText(ctx.env, body));
    }
    const messages: ChatMessage[] = [];
    if (body.system?.trim()) messages.push({ role: 'system', content: body.system });
    messages.push({ role: 'user', content: prompt });
    try {
      const r = await complete({
        model: body.model?.trim() || 'claude-opus-4-7',
        messages,
      });
      return c.json({ success: true, text: r.text, upstreamModel: r.upstreamModel });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── POST /chat ───────────────────────────────────────────────────────
  // Iframe expects: { success, text }
  app.post('/chat', async (c) => {
    let body: ChatBody;
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json({ success: false, error: '缺少 messages' });
    }
    const messages: ChatMessage[] = [];
    if (body.system?.trim()) messages.push({ role: 'system', content: body.system });
    for (const m of body.messages) {
      const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      messages.push({ role, content });
    }
    try {
      const r = await complete({
        model: body.model?.trim() || 'claude-opus-4-7',
        messages,
        maxTokens: body.maxTokens,
      });
      return c.json({ success: true, text: r.text, upstreamModel: r.upstreamModel });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Character render config ──────────────────────────────────────────
  // GET returns saved JSON or '{}'; POST writes verbatim body to disk.
  // Lives at <shimRoot>/character-render.json (not under any game).
  app.get('/character-render-config', (c) => {
    const p = resolve(shimRoot(ctx), 'character-render.json');
    if (!existsSync(p)) return c.body('{}', 200, { 'content-type': 'application/json' });
    try {
      return c.body(readFileSync(p, 'utf-8'), 200, { 'content-type': 'application/json' });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message }, 500);
    }
  });
  app.post('/character-render-config', async (c) => {
    try {
      const raw = await c.req.text();
      ensureDir(shimRoot(ctx));
      writeFileSync(resolve(shimRoot(ctx), 'character-render.json'), raw, 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Scene settings + default settings ────────────────────────────────
  app.post('/save-scene-settings', async (c) => {
    try {
      const body = await c.req.json();
      const p = resolve(shimRoot(ctx), 'scene-settings.json');
      ensureDir(shimRoot(ctx));
      writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });
  app.post('/save-default-settings', async (c) => {
    try {
      const body = await c.req.json();
      const p = resolve(shimRoot(ctx), 'default-settings.json');
      ensureDir(shimRoot(ctx));
      writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
      return c.json({ success: true });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Publish character (legacy CHARACTER_EXPORT_DIR target) ───────────
  app.post('/publish-character', async (c) => {
    try {
      const body = await c.req.json() as {
        characterId?: string;
        manifest?: unknown;
        files?: Record<string, string>;
      };
      if (!isSafeId(body.characterId)) {
        return c.json({ success: false, error: 'Invalid characterId' });
      }
      if (!body.manifest || typeof body.manifest !== 'object') {
        return c.json({ success: false, error: 'Missing manifest' });
      }
      const targetDir = resolve(characterExportDir(ctx), body.characterId);
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      ensureDir(targetDir);
      const fileCount = writeFilesUnder(targetDir, body.files ?? {});
      writeFileSync(
        resolve(targetDir, 'character.manifest.json'),
        JSON.stringify(body.manifest, null, 2),
        'utf-8',
      );
      console.log(`[ce-api-shim] publish-character: ${body.characterId} → ${targetDir} (${fileCount + 1} files)`);
      return c.json({ success: true, dir: targetDir, fileCount: fileCount + 1 });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Publish to workspace game ────────────────────────────────────────
  // Target: <projectRoot>/.forgeax/games/<gameId>/public/assets/art/characters/<slot>/
  app.post('/publish-to-workspace-game', async (c) => {
    try {
      const body = await c.req.json() as {
        gameId?: string;
        characterId?: string;
        manifest?: unknown;
        files?: Record<string, string>;
      };
      if (!isSafeId(body.gameId)) return c.json({ success: false, error: 'Invalid gameId' });
      if (!isSafeId(body.characterId)) return c.json({ success: false, error: 'Invalid characterId' });
      if (!body.manifest || typeof body.manifest !== 'object') {
        return c.json({ success: false, error: 'Missing manifest' });
      }
      const gameRoot = resolve(workspaceGamesDir(ctx), body.gameId);
      if (!existsSync(gameRoot)) {
        return c.json({ success: false, error: `Game not found: ${body.gameId} (in ${workspaceGamesDir(ctx)})` });
      }
      const targetDir = resolve(gameRoot, 'public/assets/art/characters', body.characterId);
      if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
      ensureDir(targetDir);
      const fileCount = writeFilesUnder(targetDir, body.files ?? {});
      writeFileSync(
        resolve(targetDir, 'character.manifest.json'),
        JSON.stringify(body.manifest, null, 2),
        'utf-8',
      );
      console.log(`[ce-api-shim] publish-to-workspace-game: ${body.gameId}/${body.characterId} → ${targetDir} (${fileCount + 1} files)`);
      return c.json({ success: true, dir: targetDir, fileCount: fileCount + 1 });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Merge skills (VFX → existing manifest) ───────────────────────────
  app.post('/merge-skills-to-workspace-game', async (c) => {
    try {
      const body = await c.req.json() as {
        gameId?: string;
        characterId?: string;
        skills?: Array<{ slotId?: string; actionId?: string }>;
      };
      if (!isSafeId(body.gameId)) return c.json({ success: false, error: 'Invalid gameId' });
      if (!isSafeId(body.characterId)) return c.json({ success: false, error: 'Invalid characterId' });
      if (!Array.isArray(body.skills)) return c.json({ success: false, error: 'Missing skills[]' });

      const charDir = resolve(workspaceGamesDir(ctx), body.gameId, 'public/assets/art/characters', body.characterId);
      const manifestPath = resolve(charDir, 'character.manifest.json');
      if (!existsSync(manifestPath)) {
        return c.json({
          success: false,
          error: `Character not found: ${body.characterId} in game ${body.gameId}. 请先用「导入到游戏作为主角」发布一次。`,
        });
      }
      let manifest: { actions?: Array<{ id?: string }>; skills?: unknown[] };
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')); }
      catch (e) { return c.json({ success: false, error: `Failed to parse manifest: ${(e as Error).message}` }); }
      if (!Array.isArray(manifest.actions)) {
        return c.json({ success: false, error: 'Existing manifest has no actions[]' });
      }
      const actionIds = new Set(manifest.actions.map((a) => String(a?.id ?? '')));
      const existing: Array<{ slotId?: string }> = Array.isArray(manifest.skills) ? manifest.skills as Array<{ slotId?: string }> : [];
      const bySlotId = new Map<string, unknown>();
      for (const s of existing) {
        if (s && typeof s.slotId === 'string') bySlotId.set(s.slotId, s);
      }
      const applied: unknown[] = [];
      const skipped: Array<{ slotId: string; reason: string }> = [];
      for (const raw of body.skills) {
        if (!raw || typeof raw !== 'object') continue;
        const slotId = String(raw.slotId ?? '');
        const actionId = String(raw.actionId ?? '');
        if (!slotId) { skipped.push({ slotId: '?', reason: 'missing slotId' }); continue; }
        if (!actionId || !actionIds.has(actionId)) {
          skipped.push({ slotId, reason: `actionId "${actionId}" not in manifest` });
          continue;
        }
        bySlotId.set(slotId, raw);
        applied.push(raw);
      }
      const merged = {
        ...manifest,
        skills: Array.from(bySlotId.values()),
        exportedAt: Date.now(),
      };
      writeFileSync(manifestPath, JSON.stringify(merged, null, 2), 'utf-8');
      return c.json({
        success: true,
        dir: charDir,
        skillsApplied: applied.length,
        skillsSkipped: skipped.length,
        skippedDetail: skipped,
      });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  // ── Spine session persistence ────────────────────────────────────────
  app.post('/save-spine-session', async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const currentDir = join(spineDir(ctx), 'current');
      saveSpineSessionTo(body, currentDir);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const historySlot = join(spineHistoryDir(ctx), ts);
      saveSpineSessionTo(body, historySlot);
      pruneSpineHistory(spineHistoryDir(ctx));
      return c.json({ success: true, historySlot: ts });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/load-spine-session', (c) => {
    try {
      const slot = c.req.query('slot');
      const dir = slot ? join(spineHistoryDir(ctx), slot) : join(spineDir(ctx), 'current');
      const data = loadSpineSessionFrom(dir);
      if (data) return c.json({ success: true, session: data });
      return c.json({ success: false, error: 'No saved session' });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/list-spine-sessions', (c) => {
    try {
      ensureDir(spineHistoryDir(ctx));
      const dirs = readdirSync(spineHistoryDir(ctx))
        .filter((d) => existsSync(join(spineHistoryDir(ctx), d, 'session.json')))
        .sort().reverse();
      const entries = dirs.map((d) => {
        try {
          const meta = JSON.parse(readFileSync(join(spineHistoryDir(ctx), d, 'session.json'), 'utf-8'));
          return {
            slot: d,
            timestamp: meta.timestamp,
            profession: meta.profession,
            activeTab: meta.activeTab,
            hasThumbnail: existsSync(join(spineHistoryDir(ctx), d, 'character.png')),
            hasExplosion: !!meta.hasExplosionImage,
            partsCount: (meta.partRegionsMeta || []).filter((p: { width?: number }) => (p.width ?? 0) > 0).length,
          };
        } catch { return null; }
      }).filter(Boolean);
      return c.json({ success: true, sessions: entries });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/spine-session-thumbnail', (c) => {
    const slot = c.req.query('slot');
    if (!slot) return c.json({ error: 'Missing slot' }, 400);
    const imgPath = join(spineHistoryDir(ctx), slot, 'character.png');
    if (!existsSync(imgPath)) return c.json({ error: 'No thumbnail' }, 404);
    const data = readFileSync(imgPath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    });
  });

  // ── Workspace games listing ──────────────────────────────────────────
  app.get('/list-workspace-games', (c) => {
    const root = workspaceGamesDir(ctx);
    if (!existsSync(root)) return c.json({ success: true, root, games: [] });
    try {
      const entries = readdirSync(root, { withFileTypes: true });
      const games: Array<{ gameId: string; hasPlayerSlot: boolean }> = [];
      for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.') || !isSafeId(ent.name)) continue;
        const gameRoot = resolve(root, ent.name);
        const looksLikeGame = existsSync(resolve(gameRoot, 'package.json'))
          || existsSync(resolve(gameRoot, 'public'))
          || existsSync(resolve(gameRoot, 'forge.json'));
        if (!looksLikeGame) continue;
        const hasPlayerSlot = existsSync(
          resolve(gameRoot, 'public/assets/art/characters/player/character.manifest.json'),
        );
        games.push({ gameId: ent.name, hasPlayerSlot });
      }
      return c.json({ success: true, root, games });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message });
    }
  });

  app.get('/workspace-game-manifest', (c) => {
    const gameId = c.req.query('gameId') || '';
    const characterId = c.req.query('characterId') || '';
    if (!isSafeId(gameId) || !isSafeId(characterId)) {
      return c.json({ success: false, error: 'invalid gameId/characterId' });
    }
    const p = resolve(workspaceGamesDir(ctx), gameId, 'public/assets/art/characters', characterId, 'character.manifest.json');
    if (!existsSync(p)) return c.json({ success: false, error: 'manifest not found' });
    try {
      return c.json({ success: true, manifest: JSON.parse(readFileSync(p, 'utf-8')) });
    } catch (e) {
      return c.json({ success: false, error: `parse failed: ${(e as Error).message}` });
    }
  });

  app.get('/list-workspace-game-npcs', (c) => {
    const gameId = c.req.query('gameId') || '';
    if (!isSafeId(gameId)) return c.json({ success: false, error: 'invalid gameId', npcs: [] });
    const gameRoot = resolve(workspaceGamesDir(ctx), gameId);
    const npcsJsonPath = resolve(gameRoot, 'public/npcs.json');
    if (!existsSync(npcsJsonPath)) {
      return c.json({
        success: false,
        error: '游戏里没有 public/npcs.json —— 无法自动发现 NPC 槽位。',
        npcs: [],
      });
    }
    try {
      const parsed = JSON.parse(readFileSync(npcsJsonPath, 'utf-8'));
      const raw = Array.isArray(parsed?.npcs) ? parsed.npcs : [];
      const charDirRoot = resolve(gameRoot, 'public/assets/art/characters');
      const npcs = raw
        .filter((n: { manifestId?: unknown }) => n && typeof n.manifestId === 'string' && isSafeId(n.manifestId))
        .map((n: { kind?: string; tag?: unknown; name?: unknown; manifestId: string }) => ({
          kind: n.kind === 'civilian_pool' ? 'civilian_pool' : 'npc',
          tag: String(n.tag ?? ''),
          name: String(n.name ?? n.tag ?? n.manifestId),
          manifestId: n.manifestId,
          hasManifest: existsSync(resolve(charDirRoot, n.manifestId, 'character.manifest.json')),
        }));
      return c.json({ success: true, npcs });
    } catch (e) {
      return c.json({ success: false, error: `parse npcs.json failed: ${(e as Error).message}` });
    }
  });

  // ── Deferred endpoints (503) ─────────────────────────────────────────
  // Each returns success:false so the iframe's existing fail-toast picks it
  // up. The error message names the missing dependency so the user can flag
  // it to us as we wire each one in.
  const deferred: Record<string, string> = {
    '/video-generate':        'Kling video pipeline not wired in studio. Needs KLING_AK/SK + monster-pipeline.',
    '/analyze-ultimate':      'MCP analyze-ultimate not running in studio.',
    '/magic-prompt':          'MCP magic-prompt server not running in studio.',
    '/remove-bg':             'remove-bg dependency (rembg / ComfyUI) not running in studio.',
    '/enhance-prompt':        'MCP enhance-prompt server not running in studio.',
    '/pixelart':              'MCP pixelart server not running in studio.',
    '/character-turnaround':  'character-turnaround needs MCP pixelart server.',
    '/video-query':           'Kling video pipeline not wired in studio.',
    '/video-proxy':           'Kling video pipeline not wired in studio.',
  };
  for (const [path, reason] of Object.entries(deferred)) {
    app.all(path, async (c) => {
      // Match the iframe envelope so frontend renders the message inline.
      const known = reason;
      try { await c.req.text(); } catch { /* tolerate */ }
      return c.json({ success: false, error: known, deferred: true });
    });
  }

  // Monster pipeline (Python Flask on MONSTER_BACKEND_HOST:5000) is not wired
  // in the studio host. Returning a 503 envelope lets the iframe show the
  // friendly error instead of choking on a network failure.
  app.all('/monster/*', async (c) => {
    try { await c.req.text(); } catch { /* tolerate */ }
    return c.json({
      success: false,
      error: 'Monster pipeline (Python Flask) is not wired in studio host. Start it via packages/marketplace/plugins/wb-character/server/monster-pipeline/ if needed.',
      deferred: true,
    });
  });

  // ── POST /reel-tts ──────────────────────────────────────────────────────
  // wb-reel 角色音色 / 旁白合成。key 全程留在编排层,浏览器只发同源 /__ce-api__/reel-tts。
  //   POST /reel-tts  { text, voice, speed?, model? } → { success, base64, mimeType }
  // 路由优先级:① litellm `doubao-tts`(代理开通时);② 直连 MiniMax;③ 直连豆包。
  app.post('/reel-tts', async (c) => {
    if (!minimaxTtsConfigured() && !doubaoTtsConfigured() && !litellmTtsConfigured()) {
      return c.json({
        success: false,
        error: 'TTS 未配置:请在 .env 设 MINIMAX_API_KEY(直连 MiniMax),或 DOUBAO_TTS_KEY + DOUBAO_TTS_APP_ID(直连豆包),或让 LiteLLM 代理开通 TTS 模型',
      });
    }
    let body: { text?: string; voice?: string; speed?: number; model?: string };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const text = (body.text ?? '').trim();
    const voice = (body.voice ?? '').trim();
    if (!text) return c.json({ success: false, error: 'empty text' });
    if (!voice) return c.json({ success: false, error: 'empty voice' });
    const speed = typeof body.speed === 'number' ? body.speed : undefined;
    const errors: string[] = [];
    if (litellmTtsConfigured()) {
      try {
        const { bytes, mime } = await createLitellmSpeech({ input: text, voice, model: body.model, speed });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) { errors.push(`litellm: ${(e as Error).message}`); }
    }
    if (minimaxTtsConfigured()) {
      try {
        const { bytes, mime } = await createMinimaxSpeech({ input: text, voice, speed, model: body.model });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) { errors.push(`minimax: ${(e as Error).message}`); }
    }
    if (doubaoTtsConfigured()) {
      try {
        const { bytes, mime } = await createDoubaoSpeech({ input: text, voice, speed });
        return c.json({ success: true, base64: bytes.toString('base64'), mimeType: mime });
      } catch (e) { errors.push(`doubao: ${(e as Error).message}`); }
    }
    return c.json({ success: false, error: errors.join(' · ') || 'TTS 合成失败' });
  });

  // ── POST /reel-music ────────────────────────────────────────────────────
  // wb-reel 场景 BGM 生成(MiniMax music_generation 直连)。key 留编排层。
  //   POST /reel-music { prompt?, lyrics?, isInstrumental?, lyricsOptimizer?, model?, audioSetting? }
  //   注意:同步阻塞,整曲常需 60–150s,前端走宿主网关时不要设短超时。
  app.post('/reel-music', async (c) => {
    if (!minimaxMusicConfigured()) {
      return c.json({ success: false, error: 'BGM 未配置:请在 .env 设 MINIMAX_MUSIC_KEY(直连 MiniMax 音乐)' });
    }
    let body: {
      prompt?: string; lyrics?: string; isInstrumental?: boolean; lyricsOptimizer?: boolean; model?: string;
      audioSetting?: { sampleRate?: 16000 | 24000 | 32000 | 44100; bitrate?: 32000 | 64000 | 128000 | 256000; format?: 'mp3' | 'wav' | 'pcm' };
    };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    if (!body.prompt?.trim() && !body.lyrics?.trim() && !body.lyricsOptimizer) {
      return c.json({ success: false, error: 'prompt / lyrics 至少给一个' });
    }
    try {
      const r = await createMinimaxMusic({
        prompt: body.prompt, lyrics: body.lyrics, isInstrumental: body.isInstrumental,
        lyricsOptimizer: body.lyricsOptimizer, model: body.model, audioSetting: body.audioSetting,
      });
      return c.json({
        success: true, base64: r.bytes.toString('base64'), mimeType: r.mime, model: r.model,
        traceId: r.traceId, durationMs: r.durationMs, sampleRate: r.sampleRate, channel: r.channel,
        bitrate: r.bitrate, fileSizeBytes: r.fileSizeBytes,
      });
    } catch (e) {
      return c.json({ success: false, error: `minimax-music: ${(e as Error).message}` });
    }
  });

  // ── wb-reel video (litellm /v1/videos · async task) ─────────────────────
  // Three-step contract mirrors the OpenAI Sora shape, but the iframe never
  // sees the litellm key: the host creates the task, polls status, downloads
  // the completed mp4 and re-serves it same-origin.
  //
  //   POST /generate-video  { prompt, model?, seconds?, size?,
  //                           inputReferenceDataUrl?, generateAudio? }
  //     → { success, taskId }
  //   GET  /video-status?taskId=...
  //     → { success, status, videoUrl?, error? }   (videoUrl set when completed)
  //   GET  /video-file/:id   → streams the saved mp4
  app.post('/generate-video', async (c) => {
    // 视频网关优先级：直连火山方舟（ARK_VIDEO_KEY，支持 doubao-seedance-2-0 的
    // 多图参考 R2V：角色定妆照 + 场景同时作为 reference_image）> litellm 代理
    // （只能单图当首帧、丢多图）。两者都没配才报错。
    const useArk = arkVideoConfigured();
    if (!useArk && !litellmVideoConfigured()) {
      return c.json({
        success: false,
        error: '视频网关未配置（缺 ARK_VIDEO_KEY 或 LITELLM_PROXY_BASE_URL/KEY）',
      });
    }
    let body: {
      prompt?: string;
      model?: string;
      seconds?: number | string;
      size?: string;
      inputReferenceDataUrl?: string;
      generateAudio?: boolean;
      // Seedance 原生 knobs（2026-06）—— 放进 litellm extra_body 逐字透传
      mode?: string;
      resolution?: string;
      ratio?: string;
      imageWithRoles?: Array<{ role?: string; url?: string }>;
      referenceVideoDataUrl?: string;
      referenceAudioDataUrl?: string;
      watermark?: boolean;
    };
    try { body = await c.req.json(); } catch {
      return c.json({ success: false, error: 'invalid JSON body' });
    }
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ success: false, error: '缺少 prompt' });

    // ── 直连火山方舟（首选）：完整 content[] 多图带 role，真正支持
    //    角色定妆照 + 场景 同时作为 reference_image（R2V）。 ──
    if (useArk) {
      try {
        const { id } = await createArkVideoTask({
          prompt,
          model: body.model,
          seconds: body.seconds,
          resolution: body.resolution,
          ratio: body.ratio,
          generateAudio: body.generateAudio,
          watermark: body.watermark,
          imageWithRoles: body.imageWithRoles,
          inputReferenceDataUrl: body.inputReferenceDataUrl,
          referenceVideoDataUrl: body.referenceVideoDataUrl,
          referenceAudioDataUrl: body.referenceAudioDataUrl,
        });
        return c.json({ success: true, taskId: id });
      } catch (e) {
        return c.json({ success: false, error: (e as Error).message || '视频任务创建失败' });
      }
    }

    try {
      // Seedance 原生 knobs → extra_body 逐字透传（代理侧适配器决定是否生效）。
      const extraBody: Record<string, unknown> = {};
      if (typeof body.generateAudio === 'boolean') extraBody.generate_audio = body.generateAudio;
      if (typeof body.watermark === 'boolean') extraBody.watermark = body.watermark;
      if (body.mode) extraBody.mode = body.mode;
      if (body.resolution) extraBody.resolution = body.resolution;
      if (body.ratio) extraBody.ratio = body.ratio;
      const roleImgs = Array.isArray(body.imageWithRoles)
        ? body.imageWithRoles.filter((r) => r && typeof r.url === 'string' && r.url.length > 0)
        : [];
      if (roleImgs.length > 0) extraBody.image_with_roles = roleImgs;
      if (body.referenceVideoDataUrl) extraBody.reference_video = body.referenceVideoDataUrl;
      if (body.referenceAudioDataUrl) extraBody.reference_audio = body.referenceAudioDataUrl;
      const { id } = await createLitellmVideoTask({
        prompt,
        model: body.model,
        seconds: body.seconds,
        size: body.size,
        inputReferenceDataUrl: body.inputReferenceDataUrl,
        extraBody,
      });
      return c.json({ success: true, taskId: id });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '视频任务创建失败' });
    }
  });

  app.get('/video-status', async (c) => {
    const taskId = c.req.query('taskId') || '';
    if (!taskId) return c.json({ success: false, error: '缺少 taskId' });
    try {
      const hash = createHash('sha1').update(taskId).digest('hex');
      const filePath = resolve(reelVideoDir(ctx), `${hash}.mp4`);
      // Already downloaded → return cached URL without re-hitting the gateway.
      if (existsSync(filePath)) {
        return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
      }
      // 按 task id 前缀路由：ARK(cgt-...) 走直连方舟；其余走 litellm。
      if (isArkTaskId(taskId)) {
        const st = await getArkVideoStatus(taskId);
        if (st.status === 'completed') {
          if (!st.videoUrl) {
            return c.json({ success: true, status: 'failed', error: 'ARK 任务完成但缺少 video_url' });
          }
          const { bytes } = await downloadArkVideoContent(st.videoUrl);
          ensureDir(reelVideoDir(ctx));
          writeFileSync(filePath, bytes);
          return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
        }
        if (st.status === 'failed') {
          return c.json({ success: true, status: 'failed', error: st.error || '视频任务失败' });
        }
        return c.json({ success: true, status: st.status });
      }
      const st = await getLitellmVideoStatus(taskId);
      if (st.status === 'completed') {
        const { bytes } = await downloadLitellmVideoContent(taskId);
        ensureDir(reelVideoDir(ctx));
        writeFileSync(filePath, bytes);
        return c.json({ success: true, status: 'completed', videoUrl: `/__ce-api__/video-file/${hash}` });
      }
      if (st.status === 'failed') {
        return c.json({ success: true, status: 'failed', error: st.error || '视频任务失败' });
      }
      return c.json({ success: true, status: st.status });
    } catch (e) {
      return c.json({ success: false, error: (e as Error).message || '视频状态查询失败' });
    }
  });

  app.get('/video-file/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[a-f0-9]{40}$/.test(id)) return c.json({ error: 'invalid id' }, 400);
    const filePath = resolve(reelVideoDir(ctx), `${id}.mp4`);
    if (!existsSync(filePath)) return c.json({ error: 'not found' }, 404);
    const data = readFileSync(filePath);
    return new Response(data, {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'cache-control': 'public, max-age=86400' },
    });
  });

  return app;
}

// ── helpers ────────────────────────────────────────────────────────────

function writeFilesUnder(targetDir: string, files: Record<string, string>): number {
  let fileCount = 0;
  for (const [relPath, b64] of Object.entries(files)) {
    if (typeof relPath !== 'string' || relPath.includes('..') || relPath.startsWith('/')) {
      throw new Error(`Illegal file path: ${relPath}`);
    }
    if (typeof b64 !== 'string') continue;
    const abs = resolve(targetDir, relPath);
    if (!abs.startsWith(targetDir + '/') && abs !== targetDir) {
      throw new Error(`Path escapes target dir: ${relPath}`);
    }
    ensureDir(resolve(abs, '..'));
    const match = b64.match(/^data:[^;]+;base64,(.+)$/);
    const raw = match ? match[1] : b64;
    writeFileSync(abs, Buffer.from(raw, 'base64'));
    fileCount++;
  }
  return fileCount;
}

interface SpineSessionBody {
  profession?: unknown; characterDescription?: unknown;
  activeTab?: unknown; exportPath?: unknown;
  bindingJson?: unknown; bindingVersion?: unknown;
  timestamp?: number;
  characterImage?: string; explosionImage?: string;
  partRegions?: Array<{ id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; imageData?: string }>;
  attachmentImages?: Record<string, string>;
  animations?: Record<string, unknown>;
}

function saveSpineSessionTo(body: SpineSessionBody, slotDir: string): void {
  ensureDir(slotDir);
  const partsDir = join(slotDir, 'parts');
  ensureDir(partsDir);

  const meta: {
    profession?: unknown; characterDescription?: unknown;
    activeTab?: unknown; exportPath?: unknown;
    bindingJson?: unknown; bindingVersion?: unknown;
    timestamp: number;
    partRegionsMeta: Array<{ id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; hasImage?: boolean }>;
    hasCharacterImage: boolean; hasExplosionImage: boolean;
    attachmentKeys: string[]; animationKeys: string[];
    animations?: Record<string, unknown>;
  } = {
    profession: body.profession,
    characterDescription: body.characterDescription,
    activeTab: body.activeTab,
    exportPath: body.exportPath,
    bindingJson: body.bindingJson,
    bindingVersion: body.bindingVersion,
    timestamp: body.timestamp ?? Date.now(),
    partRegionsMeta: [],
    hasCharacterImage: false,
    hasExplosionImage: false,
    attachmentKeys: [],
    animationKeys: [],
  };

  if (body.characterImage) {
    b64ToFile(body.characterImage, join(slotDir, 'character.png'));
    meta.hasCharacterImage = true;
  }
  if (body.explosionImage) {
    b64ToFile(body.explosionImage, join(slotDir, 'explosion.png'));
    meta.hasExplosionImage = true;
  }

  if (Array.isArray(body.partRegions)) {
    for (const r of body.partRegions) {
      const partMeta: { id?: string; name?: string; x?: number; y?: number; width?: number; height?: number; hasImage?: boolean } = {
        id: r.id, name: r.name, x: r.x, y: r.y, width: r.width, height: r.height,
      };
      if (r.imageData && (r.width ?? 0) > 0) {
        b64ToFile(r.imageData, join(partsDir, `${r.id}.png`));
        partMeta.hasImage = true;
      }
      meta.partRegionsMeta.push(partMeta);
    }
  }

  if (body.attachmentImages && typeof body.attachmentImages === 'object') {
    for (const [key, dataUrl] of Object.entries(body.attachmentImages)) {
      b64ToFile(dataUrl, join(slotDir, `attach_${key}.png`));
      meta.attachmentKeys.push(key);
    }
  }

  if (body.animations && typeof body.animations === 'object') {
    meta.animations = body.animations;
    meta.animationKeys = Object.keys(body.animations);
  }

  writeFileSync(join(slotDir, 'session.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

function loadSpineSessionFrom(slotDir: string): Record<string, unknown> | null {
  const metaPath = join(slotDir, 'session.json');
  if (!existsSync(metaPath)) return null;
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  const result: Record<string, unknown> = {
    profession: meta.profession,
    characterDescription: meta.characterDescription,
    activeTab: meta.activeTab,
    exportPath: meta.exportPath,
    bindingJson: meta.bindingJson,
    bindingVersion: meta.bindingVersion,
    timestamp: meta.timestamp,
    characterImage: null,
    explosionImage: null,
    partRegions: [] as Array<Record<string, unknown>>,
    attachmentImages: {} as Record<string, string>,
    animations: meta.animations ?? {},
  };
  if (meta.hasCharacterImage) result.characterImage = fileToB64(join(slotDir, 'character.png'));
  if (meta.hasExplosionImage) result.explosionImage = fileToB64(join(slotDir, 'explosion.png'));
  const partsDir = join(slotDir, 'parts');
  if (Array.isArray(meta.partRegionsMeta)) {
    for (const pm of meta.partRegionsMeta) {
      const region: Record<string, unknown> = {
        id: pm.id, name: pm.name, x: pm.x, y: pm.y, width: pm.width, height: pm.height, imageData: '',
      };
      if (pm.hasImage) region.imageData = fileToB64(join(partsDir, `${pm.id}.png`)) || '';
      (result.partRegions as Array<Record<string, unknown>>).push(region);
    }
  }
  if (Array.isArray(meta.attachmentKeys)) {
    for (const key of meta.attachmentKeys) {
      const data = fileToB64(join(slotDir, `attach_${key}.png`));
      if (data) (result.attachmentImages as Record<string, string>)[key] = data;
    }
  }
  return result;
}

function pruneSpineHistory(historyRoot: string): void {
  ensureDir(historyRoot);
  const dirs = readdirSync(historyRoot)
    .filter((d) => existsSync(join(historyRoot, d, 'session.json')))
    .sort().reverse();
  for (const dir of dirs.slice(MAX_SPINE_HISTORY)) {
    try { rmSync(join(historyRoot, dir), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
