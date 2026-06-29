// Direct Doubao (Volcengine openspeech) TTS — host-side fallback for wb-reel
// 角色音色 / 旁白合成.
//
// 为什么需要这条直连路径（2026-06）：
//   LiteLLM 代理的 key 白名单里**没有任何 TTS/语音模型**（只有文本/图像/视频），
//   所以 /reel-tts 走 litellm 必然 401。但 .env 里带了直连豆包的凭据
//   （DOUBAO_TTS_KEY / DOUBAO_TTS_APP_ID / DOUBAO_TTS_CLUSTER），key 留在
//   server 端同样不进前端 bundle。reel-tts 优先用这条直连，litellm 仅兜底。
//
// 协议（与 wb-reel 前端 createTtsClient 同形）：
//   POST {base}/api/v1/tts
//   headers: Authorization: "Bearer; <token>"   (分号是上游字面量约定，非笔误)
//   body: { app:{appid, token, cluster}, user:{uid},
//           audio:{voice_type, encoding:'mp3', speed_ratio},
//           request:{reqid, text, operation:'query'} }
//   resp: { code:3000, data:<base64 mp3> }   (code!=3000 即失败)

const DEFAULT_BASE = 'https://openspeech.bytedance.com';
const DEFAULT_CLUSTER = 'volcano_tts';

function ttsKey(): string {
  return (process.env.DOUBAO_TTS_KEY ?? '').trim();
}
function ttsAppId(): string {
  return (process.env.DOUBAO_TTS_APP_ID ?? '').trim();
}
function ttsCluster(): string {
  return (process.env.DOUBAO_TTS_CLUSTER ?? '').trim() || DEFAULT_CLUSTER;
}
function ttsBase(): string {
  return (process.env.DOUBAO_TTS_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

/** 直连豆包 TTS 是否可用（key + appid 都有）。 */
export function doubaoTtsConfigured(): boolean {
  return !!(ttsKey() && ttsAppId());
}

export interface DoubaoSpeechInput {
  /** 要合成的文本。 */
  input: string;
  /** 音色编码（voice_type，如 BV001_streaming）。 */
  voice: string;
  /** 语速 0.5–2.0；缺省 1.0。 */
  speed?: number;
}

/** 同步合成一段语音（operation=query），返回 mp3 字节。 */
export async function createDoubaoSpeech(
  args: DoubaoSpeechInput,
): Promise<{ bytes: Buffer; mime: string }> {
  const key = ttsKey();
  const appId = ttsAppId();
  if (!key) throw new Error('doubao-tts: DOUBAO_TTS_KEY not set');
  if (!appId) throw new Error('doubao-tts: DOUBAO_TTS_APP_ID not set');
  const input = args.input?.trim();
  if (!input) throw new Error('doubao-tts: empty input');
  if (!args.voice) throw new Error('doubao-tts: empty voice');

  const reqid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const body = {
    app: { appid: appId, token: 'ignored', cluster: ttsCluster() },
    user: { uid: 'forgeax-reel' },
    audio: {
      voice_type: args.voice,
      encoding: 'mp3',
      speed_ratio: typeof args.speed === 'number' ? args.speed : 1.0,
    },
    request: { reqid, text: input, operation: 'query' },
  };

  const resp = await fetch(`${ttsBase()}/api/v1/tts`, {
    method: 'POST',
    headers: {
      // 上游鉴权约定: "Bearer; <token>"（分号是字面量）
      Authorization: `Bearer; ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`doubao-tts: HTTP ${resp.status} · ${raw.slice(0, 240)}`);
  }
  let json: { code?: number; message?: string; data?: string };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`doubao-tts: non-JSON response · ${raw.slice(0, 200)}`);
  }
  if (json.code !== 3000 || !json.data) {
    throw new Error(`doubao-tts: code=${json.code} ${json.message ?? ''}`.trim());
  }
  return { bytes: Buffer.from(json.data, 'base64'), mime: 'audio/mpeg' };
}
