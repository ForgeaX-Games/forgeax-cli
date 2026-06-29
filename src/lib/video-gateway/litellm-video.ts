// litellm video gateway — host-side wrapper around the proxy's OpenAI-shaped
// async video API (`/v1/videos`). Used by wb-reel (互动影游) so the litellm key
// never reaches the browser bundle and concurrency stays server-managed.
//
// Verified contract (2026-06, LITELLM_PROXY_BASE_URL, model=`seedance`):
//   1) POST   {base}/videos   { model, prompt, seconds?, size?, input_reference? }
//        → 200 { id, object:'video', status:'queued' }   (returns immediately)
//   2) GET    {base}/videos/{id}
//        → { status: 'queued' | 'in_progress' | 'completed' | 'failed', error? }
//   3) GET    {base}/videos/{id}/content
//        → 200 video/mp4 binary (no inline URL in the status JSON — must be
//          downloaded here with the key, then re-served same-origin to the iframe)
//
// Reference image: `input_reference` accepts a base64 data URL string and routes
// to Volcengine image-to-video (single reference image). The OpenAI `image`
// field is NOT honored by the Volcengine adapter, so we only use input_reference.
// `extra_body` is forwarded verbatim for provider-native knobs (generate_audio…).

const DEFAULT_VIDEO_MODEL = 'seedance';

function proxyBase(): string {
  // LITELLM_PROXY_BASE_URL already ends with /v1 (same as the chat transport).
  return (process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
}
function proxyKey(): string {
  return process.env.LITELLM_PROXY_KEY ?? '';
}

export function litellmVideoConfigured(): boolean {
  return !!(proxyBase() && proxyKey());
}

export interface CreateVideoTaskInput {
  prompt: string;
  model?: string;
  /** Video duration in seconds (litellm expects a string, e.g. "5"). */
  seconds?: number | string;
  /** Dimensions like "1280x720" — optional; omit to let the model default. */
  size?: string;
  /** Primary reference / first frame as a base64 data URL (single image only). */
  inputReferenceDataUrl?: string;
  /** Provider-native passthrough (e.g. { generate_audio: true }). */
  extraBody?: Record<string, unknown>;
}

export interface VideoTaskStatus {
  id: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | string;
  error?: string;
}

interface VideoCreateResp {
  id?: string;
  status?: string;
  error?: { message?: string } | string | null;
}

function errMessage(e: VideoCreateResp['error']): string | undefined {
  if (!e) return undefined;
  if (typeof e === 'string') return e;
  return e.message;
}

/** Create an async video task. Returns the litellm video id (poll with it). */
export async function createLitellmVideoTask(input: CreateVideoTaskInput): Promise<{ id: string }> {
  const base = proxyBase();
  const key = proxyKey();
  if (!base) throw new Error('litellm-video: LITELLM_PROXY_BASE_URL not set');
  if (!key) throw new Error('litellm-video: LITELLM_PROXY_KEY not set');
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('litellm-video: empty prompt');

  const body: Record<string, unknown> = {
    model: input.model?.trim() || DEFAULT_VIDEO_MODEL,
    prompt,
  };
  if (input.seconds !== undefined) body.seconds = String(input.seconds);
  if (input.size) body.size = input.size;
  if (input.inputReferenceDataUrl) body.input_reference = input.inputReferenceDataUrl;
  if (input.extraBody && Object.keys(input.extraBody).length > 0) body.extra_body = input.extraBody;

  const resp = await fetch(`${base}/videos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  let parsed: VideoCreateResp;
  try {
    parsed = JSON.parse(raw) as VideoCreateResp;
  } catch {
    throw new Error(`litellm-video: non-JSON create response (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`litellm-video: create failed — ${errMessage(parsed.error) ?? `HTTP ${resp.status}`}`);
  }
  if (!parsed.id) {
    throw new Error(`litellm-video: create response missing id · ${raw.slice(0, 200)}`);
  }
  return { id: parsed.id };
}

/** Poll one video task's status (single request, no internal loop). */
export async function getLitellmVideoStatus(id: string): Promise<VideoTaskStatus> {
  const base = proxyBase();
  const key = proxyKey();
  if (!base || !key) throw new Error('litellm-video: proxy not configured');
  const resp = await fetch(`${base}/videos/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const raw = await resp.text();
  let parsed: VideoCreateResp;
  try {
    parsed = JSON.parse(raw) as VideoCreateResp;
  } catch {
    throw new Error(`litellm-video: non-JSON status (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) {
    throw new Error(`litellm-video: status failed — ${errMessage(parsed.error) ?? `HTTP ${resp.status}`}`);
  }
  return {
    id: parsed.id ?? id,
    status: parsed.status ?? 'queued',
    error: errMessage(parsed.error),
  };
}

/** Download the completed video bytes (mp4). Caller persists / re-serves them. */
export async function downloadLitellmVideoContent(
  id: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const base = proxyBase();
  const key = proxyKey();
  if (!base || !key) throw new Error('litellm-video: proxy not configured');
  const resp = await fetch(`${base}/videos/${encodeURIComponent(id)}/content`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`litellm-video: content download failed HTTP ${resp.status} · ${raw.slice(0, 200)}`);
  }
  const ab = await resp.arrayBuffer();
  const mime = resp.headers.get('content-type') || 'video/mp4';
  return { bytes: Buffer.from(ab), mime };
}
