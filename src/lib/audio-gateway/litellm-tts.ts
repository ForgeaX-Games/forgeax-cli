// litellm audio gateway — host-side wrapper around the proxy's OpenAI-shaped
// text-to-speech endpoint (`/audio/speech`). Used by wb-reel (角色音色 / 旁白合成)
// so the TTS key never reaches the browser bundle and stays server-managed.
//
// Verified contract (2026-06, LITELLM_PROXY_BASE_URL, model=`doubao-tts`):
//   POST {base}/audio/speech  { model, input, voice, response_format?, speed? }
//     → 200 binary audio (audio/mpeg by default)
//
// `voice` 沿用豆包原生 voice_type 编码（BV001_streaming 等），litellm 透传不映射。
// model 默认 `doubao-tts`，可用 LITELLM_PROXY_TTS_MODEL 覆盖。

const DEFAULT_TTS_MODEL = 'doubao-tts';

function proxyBase(): string {
  // LITELLM_PROXY_BASE_URL already ends with /v1 (same as the chat transport).
  return (process.env.LITELLM_PROXY_BASE_URL ?? '').replace(/\/+$/, '');
}
function proxyKey(): string {
  return process.env.LITELLM_PROXY_KEY ?? '';
}

export function litellmTtsConfigured(): boolean {
  return !!(proxyBase() && proxyKey());
}

function ttsModel(): string {
  return (process.env.LITELLM_PROXY_TTS_MODEL ?? '').trim() || DEFAULT_TTS_MODEL;
}

export interface CreateSpeechInput {
  /** 要合成的文本。 */
  input: string;
  /** 音色编码（沿用豆包 voice_type，如 BV001_streaming）。 */
  voice: string;
  /** 覆盖模型名；缺省走 doubao-tts / LITELLM_PROXY_TTS_MODEL。 */
  model?: string;
  /** 语速 0.25–4.0（OpenAI speech 口径）；缺省由模型默认。 */
  speed?: number;
  /** 输出格式，默认 mp3。 */
  responseFormat?: string;
}

/** 调 litellm /audio/speech 同步合成一段语音，返回二进制音频字节。 */
export async function createLitellmSpeech(
  args: CreateSpeechInput,
): Promise<{ bytes: Buffer; mime: string }> {
  const base = proxyBase();
  const key = proxyKey();
  if (!base) throw new Error('litellm-tts: LITELLM_PROXY_BASE_URL not set');
  if (!key) throw new Error('litellm-tts: LITELLM_PROXY_KEY not set');
  const input = args.input?.trim();
  if (!input) throw new Error('litellm-tts: empty input');
  if (!args.voice) throw new Error('litellm-tts: empty voice');

  const body: Record<string, unknown> = {
    model: args.model?.trim() || ttsModel(),
    input,
    voice: args.voice,
    response_format: args.responseFormat || 'mp3',
  };
  if (typeof args.speed === 'number') body.speed = args.speed;

  const resp = await fetch(`${base}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const mime = resp.headers.get('content-type') || 'audio/mpeg';
  // 成功是二进制；出错时代理一般回 JSON（即便 200）——按错误处理，别把 JSON 当音频。
  if (!resp.ok || mime.includes('application/json')) {
    const raw = await resp.text().catch(() => '');
    throw new Error(`litellm-tts: speech failed HTTP ${resp.status} · ${raw.slice(0, 240)}`);
  }
  const ab = await resp.arrayBuffer();
  return { bytes: Buffer.from(ab), mime };
}
