// Direct MiniMax T2A (text-to-speech) — host-side primary path for wb-reel
// 角色音色 / 旁白合成。
//
// 为什么用直连 MiniMax（2026-06）：
//   · LiteLLM 代理这把 key 白名单里没有任何 TTS 模型（/audio/speech 全 401）。
//   · 直连豆包账号 403（volc.tts.default 资源未授权）。
//   · 实测 MINIMAX_API_KEY 走 /v1/t2a_v2 可正常合成（system_voice 全量可用）。
//   所以 reel-tts 主路径用 MiniMax 直连，key 留 server 不进前端 bundle。
//
// 协议（MiniMax T2A v2，非流式）：
//   POST {base}/v1/t2a_v2
//   headers: Authorization: Bearer <api_key>
//   body: { model, text, stream:false,
//           voice_setting:{ voice_id, speed, vol, pitch },
//           audio_setting:{ sample_rate, bitrate, format:'mp3' } }
//   resp: { data:{ audio:'<hex mp3>' }, base_resp:{ status_code, status_msg } }
//         status_code===0 即成功；audio 是 hex 编码的 mp3 字节。

const DEFAULT_BASE = 'https://api.minimaxi.com';
const DEFAULT_MODEL = 'speech-2.5-hd-preview';
const DEFAULT_VOICE = 'female-tianmei';

function ttsKey(): string {
  return (process.env.MINIMAX_API_KEY ?? '').trim();
}
function ttsBase(): string {
  return (process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}
function ttsModel(): string {
  return (process.env.MINIMAX_TTS_MODEL ?? '').trim() || DEFAULT_MODEL;
}

/** 直连 MiniMax TTS 是否可用（仅需 api key）。 */
export function minimaxTtsConfigured(): boolean {
  return !!ttsKey();
}

export interface MinimaxSpeechInput {
  /** 要合成的文本。 */
  input: string;
  /** MiniMax voice_id（如 female-tianmei / male-qn-qingse）。 */
  voice: string;
  /** 语速 0.5–2.0；缺省 1.0。 */
  speed?: number;
  /** 覆盖模型名；缺省 speech-2.5-hd-preview / MINIMAX_TTS_MODEL。 */
  model?: string;
}

function clampSpeed(s: number | undefined): number {
  if (typeof s !== 'number' || Number.isNaN(s)) return 1.0;
  return Math.min(2.0, Math.max(0.5, s));
}

/** 同步合成一段语音，返回 mp3 字节。 */
export async function createMinimaxSpeech(
  args: MinimaxSpeechInput,
): Promise<{ bytes: Buffer; mime: string }> {
  const key = ttsKey();
  if (!key) throw new Error('minimax-tts: MINIMAX_API_KEY not set');
  const input = args.input?.trim();
  if (!input) throw new Error('minimax-tts: empty input');
  const voice = (args.voice || DEFAULT_VOICE).trim();

  const body = {
    model: args.model?.trim() || ttsModel(),
    text: input,
    stream: false,
    voice_setting: {
      voice_id: voice,
      speed: clampSpeed(args.speed),
      vol: 1,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
    },
  };

  const resp = await fetch(`${ttsBase()}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`minimax-tts: HTTP ${resp.status} · ${raw.slice(0, 240)}`);
  }
  let json: {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`minimax-tts: non-JSON response · ${raw.slice(0, 200)}`);
  }
  const status = json.base_resp?.status_code;
  if (status !== 0) {
    throw new Error(
      `minimax-tts: status=${status} ${json.base_resp?.status_msg ?? ''}`.trim(),
    );
  }
  const hex = json.data?.audio;
  if (!hex) throw new Error('minimax-tts: empty audio in response');
  return { bytes: Buffer.from(hex, 'hex'), mime: 'audio/mpeg' };
}
