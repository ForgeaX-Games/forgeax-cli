// ark-video gateway — host-side direct integration with Volcengine Ark's
// Seedance video API (`/contents/generations/tasks`). Used by wb-reel (互动影游)
// so the ARK key never reaches the browser bundle.
//
// WHY this exists alongside litellm-video (2026-06 root-cause):
//   The litellm proxy maps the OpenAI `/v1/videos` shape onto Volcengine but
//   only honors a SINGLE `input_reference` (treated as a first_frame) and
//   silently drops `image_with_roles`. That makes true 多图参考 (角色定妆照 +
//   场景 同时作为 reference_image) impossible, and any first_frame + reference
//   media (audio) combo gets rejected by Volcengine. The result was 节点视频
//   几乎全失败 / The operation timed out.
//
//   Volcengine's own `doubao-seedance-2-0-260128` supports R2V (多模态参考生
//   视频): 1–9 `reference_image` + ≤3 reference_video + ≤3 reference_audio,
//   composed into a fresh video. We hit ARK directly here, building the native
//   `content[]` with explicit `role`s, so multi-reference actually works.
//
// Contract (verified live 2026-06 against ARK_VIDEO_KEY):
//   1) POST {base}/contents/generations/tasks
//        { model, content:[{type:'text',text}, {type:'image_url',image_url:{url},role}...],
//          ratio?, resolution?, duration?, generate_audio?, watermark? }
//        → 200 { id: 'cgt-...' }
//   2) GET  {base}/contents/generations/tasks/{id}
//        → { status:'queued'|'running'|'succeeded'|'failed', content:{video_url}, error? }
//   3) The completed `content.video_url` is a short-lived signed URL — we
//      download the bytes here and re-serve them same-origin to the iframe.
//
// Notes:
//   · 多模态参考模式与首/尾帧模式互斥 —— 调用方通过每张图的 role 自行二选一。
//   · reference_audio 必须搭配至少一张图或一段参考视频，不能单独出现。
//   · data:base64 图片直接内联进 image_url.url，ARK 接受（单图 < 30MB，边长 ≥14px）。

const DEFAULT_ARK_VIDEO_MODEL = 'doubao-seedance-2-0-260128';
const DEFAULT_ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

function arkBase(): string {
  return (process.env.ARK_API_BASE || DEFAULT_ARK_BASE).replace(/\/+$/, '');
}
function arkKey(): string {
  return process.env.ARK_VIDEO_KEY ?? '';
}
function arkModel(): string {
  return process.env.ARK_VIDEO_MODEL?.trim() || DEFAULT_ARK_VIDEO_MODEL;
}

export function arkVideoConfigured(): boolean {
  return !!arkKey();
}

export type ArkImageRole = 'first_frame' | 'last_frame' | 'reference_image';

export interface CreateArkVideoInput {
  prompt: string;
  model?: string;
  /** Video duration in seconds (ARK expects a number). */
  seconds?: number | string;
  /** Resolution tier like '720p' / '1080p' — optional. */
  resolution?: string;
  /** Aspect ratio like '16:9' / '3:4' / 'adaptive' — optional. */
  ratio?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  /**
   * 多模态参考 / 首尾帧统一入口：每张图带 role。
   *   · reference_image (1–9)        → 多模态参考生视频 (R2V)
   *   · first_frame (+ last_frame)   → 首/尾帧图生视频 (i2v)
   * 两类互斥；调用方负责只传其一。
   */
  imageWithRoles?: Array<{ role?: string; url?: string }>;
  /** 单图首帧兜底（无 imageWithRoles 时按 i2v 处理）。 */
  inputReferenceDataUrl?: string;
  /** 参考视频（多模态参考模式），data: 或 https。 */
  referenceVideoDataUrl?: string;
  /** 参考音频（多模态参考模式，需搭配图/视频），data: 或 https。 */
  referenceAudioDataUrl?: string;
}

type ArkContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: ArkImageRole }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' };

function normalizeRole(r: string | undefined): ArkImageRole {
  if (r === 'first_frame' || r === 'last_frame' || r === 'reference_image') return r;
  return 'reference_image';
}

interface ArkCreateResp {
  id?: string;
  error?: { message?: string; code?: string } | string | null;
}

function errMessage(e: ArkCreateResp['error']): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  return e.message ?? e.code;
}

/** Build the native ARK `content[]` from role-tagged refs. */
function buildArkContent(input: CreateArkVideoInput): {
  content: ArkContentPart[];
  /** true 当本次是「多模态参考模式」(含 reference_image)，无首/尾帧。 */
  isReference: boolean;
} {
  const content: ArkContentPart[] = [{ type: 'text', text: input.prompt }];
  const roleImgs = (input.imageWithRoles ?? []).filter(
    (r) => r && typeof r.url === 'string' && r.url.length > 0,
  );

  let hasFrame = false;
  let hasRef = false;
  if (roleImgs.length > 0) {
    for (const r of roleImgs) {
      const role = normalizeRole(r.role);
      if (role === 'reference_image') hasRef = true;
      else hasFrame = true;
      content.push({ type: 'image_url', image_url: { url: r.url as string }, role });
    }
  } else if (input.inputReferenceDataUrl) {
    // 无 role 列表时，单图按首帧 i2v 处理。
    content.push({
      type: 'image_url',
      image_url: { url: input.inputReferenceDataUrl },
      role: 'first_frame',
    });
    hasFrame = true;
  }

  // 参考视频 / 参考音频仅在多模态参考模式（无首/尾帧）下附加，避免与首尾帧互斥冲突。
  const isReference = hasRef && !hasFrame;
  let hasVideo = false;
  if (!hasFrame && input.referenceVideoDataUrl) {
    content.push({
      type: 'video_url',
      video_url: { url: input.referenceVideoDataUrl },
      role: 'reference_video',
    });
    hasVideo = true;
  }
  // 火山规则：reference_audio 必须搭配至少一张参考图或一段参考视频，不能单独出现。
  if (!hasFrame && input.referenceAudioDataUrl && (hasRef || hasVideo)) {
    content.push({
      type: 'audio_url',
      audio_url: { url: input.referenceAudioDataUrl },
      role: 'reference_audio',
    });
  }

  return { content, isReference };
}

/** Create an async ARK video task. Returns the task id (poll with it). */
export async function createArkVideoTask(input: CreateArkVideoInput): Promise<{ id: string }> {
  const key = arkKey();
  if (!key) throw new Error('ark-video: ARK_VIDEO_KEY not set');
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('ark-video: empty prompt');

  const { content } = buildArkContent({ ...input, prompt });

  const body: Record<string, unknown> = {
    model: input.model?.trim() || arkModel(),
    content,
  };
  if (input.ratio) body.ratio = input.ratio;
  if (input.resolution) body.resolution = input.resolution;
  if (input.seconds !== undefined && input.seconds !== '') {
    const n = Number(input.seconds);
    if (Number.isFinite(n) && n > 0) body.duration = n;
  }
  if (typeof input.generateAudio === 'boolean') body.generate_audio = input.generateAudio;
  if (typeof input.watermark === 'boolean') body.watermark = input.watermark;

  const resp = await fetch(`${arkBase()}/contents/generations/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  let parsed: ArkCreateResp;
  try {
    parsed = JSON.parse(raw) as ArkCreateResp;
  } catch {
    throw new Error(`ark-video: non-JSON create response (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
  }
  if (!resp.ok || parsed.error) {
    throw new Error(`ark-video: create failed — ${errMessage(parsed.error) ?? `HTTP ${resp.status}`}`);
  }
  if (!parsed.id) {
    throw new Error(`ark-video: create response missing id · ${raw.slice(0, 200)}`);
  }
  return { id: parsed.id };
}

export interface ArkVideoTaskStatus {
  id: string;
  /** Normalized to litellm-shaped vocab so the shim can treat both gateways alike. */
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | string;
  error?: string;
  /** Short-lived signed mp4 URL (only when completed). */
  videoUrl?: string;
}

interface ArkStatusResp {
  id?: string;
  status?: string;
  error?: { message?: string; code?: string } | string | null;
  content?: { video_url?: string } | null;
}

function mapArkStatus(s: string | undefined): ArkVideoTaskStatus['status'] {
  switch (s) {
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'cancelled':
    case 'canceled':
      return 'failed';
    case 'running':
    case 'queued':
      return 'in_progress';
    default:
      return s ?? 'in_progress';
  }
}

/** Poll one ARK video task's status (single request, no internal loop). */
export async function getArkVideoStatus(id: string): Promise<ArkVideoTaskStatus> {
  const key = arkKey();
  if (!key) throw new Error('ark-video: ARK_VIDEO_KEY not set');
  const resp = await fetch(`${arkBase()}/contents/generations/tasks/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const raw = await resp.text();
  let parsed: ArkStatusResp;
  try {
    parsed = JSON.parse(raw) as ArkStatusResp;
  } catch {
    throw new Error(`ark-video: non-JSON status (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`ark-video: status failed — ${errMessage(parsed.error) ?? `HTTP ${resp.status}`}`);
  }
  return {
    id: parsed.id ?? id,
    status: mapArkStatus(parsed.status),
    error: errMessage(parsed.error),
    videoUrl: parsed.content?.video_url || undefined,
  };
}

/** Download the completed video bytes from ARK's signed url. */
export async function downloadArkVideoContent(
  videoUrl: string,
): Promise<{ bytes: Buffer; mime: string }> {
  if (!videoUrl) throw new Error('ark-video: missing video_url');
  const resp = await fetch(videoUrl);
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`ark-video: content download failed HTTP ${resp.status} · ${raw.slice(0, 200)}`);
  }
  const ab = await resp.arrayBuffer();
  const mime = resp.headers.get('content-type') || 'video/mp4';
  return { bytes: Buffer.from(ab), mime };
}

/** True when a task id was minted by ARK (so /video-status routes here). */
export function isArkTaskId(id: string): boolean {
  return typeof id === 'string' && id.startsWith('cgt-');
}
