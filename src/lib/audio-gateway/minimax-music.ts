// Direct MiniMax Music generation — host-side gateway for wb-reel BGM.
//
// 为什么 host 侧直连（2026-06）：
//   · LiteLLM 代理这把 key 没有 lyria3 / 任何音乐模型（全 401）。
//   · 实测 MINIMAX_MUSIC_KEY 走 /v1/music_generation 可正常出整曲
//     （music-2.6-free，~100s，hex mp3）。
//   原前端 MinimaxMusicProvider 用编译期注入 key，嵌入 iframe 时回落静音占位；
//   改走宿主 /reel-music 后 key 全程留 server，浏览器只发同源请求。
//
// 协议（MiniMax music_generation，非流式，output_format=hex）：
//   POST {base}/v1/music_generation
//   headers: Authorization: Bearer <api_key>
//   body: { model, prompt?, lyrics?, is_instrumental?, lyrics_optimizer?,
//           stream:false, output_format:'hex', audio_setting:{...} }
//   resp: { data:{ status, audio:'<hex>' }, extra_info:{...}, base_resp:{ status_code } }

const DEFAULT_BASE = 'https://api.minimaxi.com';
const DEFAULT_MODEL = 'music-2.6-free';

function musicKey(): string {
  return (process.env.MINIMAX_MUSIC_KEY ?? '').trim();
}
function musicBase(): string {
  return (process.env.MINIMAX_MUSIC_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}
function musicModel(): string {
  return (process.env.MINIMAX_MUSIC_DEFAULT_MODEL ?? '').trim() || DEFAULT_MODEL;
}

/** 直连 MiniMax 音乐是否可用（仅需 music key）。 */
export function minimaxMusicConfigured(): boolean {
  return !!musicKey();
}

export interface MinimaxMusicInput {
  /** 风格 / 情绪 / 场景描述。 */
  prompt?: string;
  /** 歌词（含 [Verse]/[Chorus] 结构标签）；纯音乐可省。 */
  lyrics?: string;
  /** 纯音乐（无人声），仅 music-2.6 系列支持。 */
  isInstrumental?: boolean;
  /** lyrics 为空时由 prompt 自动生成歌词。 */
  lyricsOptimizer?: boolean;
  /** 覆盖模型名；缺省 music-2.6-free / MINIMAX_MUSIC_DEFAULT_MODEL。 */
  model?: string;
  audioSetting?: {
    sampleRate?: 16000 | 24000 | 32000 | 44100;
    bitrate?: 32000 | 64000 | 128000 | 256000;
    format?: 'mp3' | 'wav' | 'pcm';
  };
}

export interface MinimaxMusicOutput {
  bytes: Buffer;
  mime: string;
  model: string;
  traceId?: string;
  durationMs?: number;
  sampleRate?: number;
  channel?: number;
  bitrate?: number;
  fileSizeBytes?: number;
}

/** 同步生成整曲，返回音频字节 + 元信息（注意：可能阻塞 60–150s）。 */
export async function createMinimaxMusic(
  args: MinimaxMusicInput,
): Promise<MinimaxMusicOutput> {
  const key = musicKey();
  if (!key) throw new Error('minimax-music: MINIMAX_MUSIC_KEY not set');
  const model = args.model?.trim() || musicModel();
  const fmt = args.audioSetting?.format ?? 'mp3';

  const body: Record<string, unknown> = {
    model,
    output_format: 'hex',
    stream: false,
    audio_setting: {
      sample_rate: args.audioSetting?.sampleRate ?? 44100,
      bitrate: args.audioSetting?.bitrate ?? 256000,
      format: fmt,
    },
  };
  if (args.prompt !== undefined && args.prompt !== '') body.prompt = args.prompt;
  if (args.lyrics !== undefined && args.lyrics !== '') body.lyrics = args.lyrics;
  if (args.isInstrumental) body.is_instrumental = true;
  if (args.lyricsOptimizer) body.lyrics_optimizer = true;

  const resp = await fetch(`${musicBase()}/v1/music_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`minimax-music: HTTP ${resp.status} · ${raw.slice(0, 240)}`);
  }
  let json: {
    data?: { status?: number; audio?: string };
    trace_id?: string;
    extra_info?: {
      music_duration?: number;
      music_sample_rate?: number;
      music_channel?: number;
      bitrate?: number;
      music_size?: number;
    };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new Error(`minimax-music: non-JSON response · ${raw.slice(0, 200)}`);
  }
  const code = json.base_resp?.status_code ?? -1;
  if (code !== 0) {
    throw new Error(
      `minimax-music: code=${code} ${json.base_resp?.status_msg ?? ''}`.trim(),
    );
  }
  const hex = json.data?.audio;
  if (!hex) throw new Error('minimax-music: empty audio in response');

  return {
    bytes: Buffer.from(hex, 'hex'),
    mime: fmt === 'wav' ? 'audio/wav' : 'audio/mpeg',
    model,
    traceId: json.trace_id,
    durationMs: json.extra_info?.music_duration,
    sampleRate: json.extra_info?.music_sample_rate,
    channel: json.extra_info?.music_channel,
    bitrate: json.extra_info?.bitrate,
    fileSizeBytes: json.extra_info?.music_size,
  };
}
