// @desc WeChat CDN media — AES-128-ECB encrypt/decrypt, image download and upload

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { getUploadUrl, sendMessage } from "./wechat-api.js";
import type { WeixinApiOptions, SendMessageResp } from "./wechat-api.js";
import { MessageItemType, MessageType, MessageState, UploadMediaType } from "./wechat-types.js";
import type { ImageItem, CDNMedia, MessageItem, SendMessageReq } from "./wechat-types.js";
import { mediasDir } from "./wechat-store.js";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

// ── AES-128-ECB ──

function encryptAesEcb(plain: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ── CDN URL ──

function cdnDownloadUrl(eqp: string): string {
  return `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(eqp)}`;
}

function cdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

// ── Inbound: download + decrypt image ──

export async function downloadImage(
  imageItem: ImageItem,
  log: (msg: string) => void,
): Promise<string | null> {
  const eqp = imageItem.media?.encrypt_query_param;
  if (!eqp) {
    log("image download: no encrypt_query_param");
    return null;
  }

  const aesKeyHex = imageItem.aeskey;
  const aesKeyB64 = imageItem.media?.aes_key;
  let keyBuf: Buffer;
  if (aesKeyHex) {
    keyBuf = Buffer.from(aesKeyHex, "hex");
  } else if (aesKeyB64) {
    keyBuf = Buffer.from(aesKeyB64, "base64");
    if (keyBuf.length === 32 && /^[0-9a-fA-F]{32}$/.test(keyBuf.toString("ascii"))) {
      keyBuf = Buffer.from(keyBuf.toString("ascii"), "hex");
    }
  } else {
    log("image download: no AES key available");
    return null;
  }

  const url = cdnDownloadUrl(eqp);
  log(`image download: ${url.slice(0, 80)}...`);
  const res = await fetch(url);
  if (!res.ok) {
    log(`image download failed: ${res.status}`);
    return null;
  }

  const cipherBuf = Buffer.from(await res.arrayBuffer());
  let plainBuf: Buffer;
  try {
    plainBuf = decryptAesEcb(cipherBuf, keyBuf);
  } catch (err) {
    log(`image decrypt failed: ${String(err)}`);
    return null;
  }

  const dir = mediasDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.jpg`);
  fs.writeFileSync(filePath, plainBuf);
  log(`image saved: ${filePath} (${plainBuf.length} bytes)`);
  return filePath;
}

// ── Outbound: encrypt + upload media, then send ──

export type OutboundMediaType = "image" | "audio" | "video" | "file";

const MEDIA_TYPE_MAP: Record<OutboundMediaType, number> = {
  image: UploadMediaType.IMAGE,
  video: UploadMediaType.VIDEO,
  file:  UploadMediaType.FILE,
  audio: UploadMediaType.VOICE,
};

async function cdnUploadFile(params: {
  plainBuf: Buffer;
  uploadMediaType: number;
  to: string;
  opts: WeixinApiOptions;
}): Promise<{ downloadParam: string; rawSize: number; cipherSize: number; aesKey: Buffer }> {
  const { plainBuf, uploadMediaType, to, opts } = params;
  const aesKey = crypto.randomBytes(16);
  const cipherBuf = encryptAesEcb(plainBuf, aesKey);
  const md5 = crypto.createHash("md5").update(plainBuf).digest("hex");
  const filekey = `agenteam_${randomUUID().replace(/-/g, "")}`;

  const uploadResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    filekey,
    media_type: uploadMediaType,
    to_user_id: to,
    rawsize: plainBuf.length,
    rawfilemd5: md5,
    filesize: cipherBuf.length,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
  });

  if (!uploadResp.upload_param) {
    throw new Error("getUploadUrl: no upload_param returned");
  }

  const cdnUrl = cdnUploadUrl(uploadResp.upload_param, filekey);
  const cdnRes = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(cipherBuf),
  });
  if (!cdnRes.ok) {
    throw new Error(`CDN upload failed: ${cdnRes.status}`);
  }
  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) {
    throw new Error("CDN upload: missing x-encrypted-param header");
  }

  return { downloadParam, rawSize: plainBuf.length, cipherSize: cipherBuf.length, aesKey };
}

function buildMediaMessageItem(
  type: OutboundMediaType,
  downloadParam: string,
  aesKey: Buffer,
  cipherSize: number,
  rawSize: number,
  fileName?: string,
): MessageItem {
  const cdnMedia: CDNMedia = {
    encrypt_query_param: downloadParam,
    aes_key: Buffer.from(aesKey.toString("hex")).toString("base64"),
    encrypt_type: 1,
  };

  switch (type) {
    case "image":
      return { type: MessageItemType.IMAGE, image_item: { media: cdnMedia, mid_size: cipherSize } };
    case "audio":
      return { type: MessageItemType.VOICE, voice_item: { media: cdnMedia } };
    case "video":
      return { type: MessageItemType.VIDEO, video_item: { media: cdnMedia, video_size: cipherSize } };
    case "file":
      return { type: MessageItemType.FILE, file_item: { media: cdnMedia, file_name: fileName, len: String(rawSize) } };
  }
}

export async function uploadAndSendMedia(params: {
  filePath: string;
  mediaType: OutboundMediaType;
  to: string;
  text?: string;
  opts: WeixinApiOptions & { contextToken?: string };
}): Promise<void> {
  const { filePath, mediaType, to, text, opts } = params;
  const plainBuf = fs.readFileSync(filePath);

  const { downloadParam, rawSize, cipherSize, aesKey } = await cdnUploadFile({
    plainBuf,
    uploadMediaType: MEDIA_TYPE_MAP[mediaType],
    to,
    opts,
  });

  const fileName = mediaType === "file" ? path.basename(filePath) : undefined;
  const mediaItem = buildMediaMessageItem(mediaType, downloadParam, aesKey, cipherSize, rawSize, fileName);

  const items: MessageItem[] = [];
  if (text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text } });
  }
  items.push(mediaItem);

  await sendMessageItems(items, { to, opts });
}

export async function sendMessageItems(
  items: MessageItem[],
  ctx: { to: string; opts: WeixinApiOptions & { contextToken?: string } },
): Promise<SendMessageResp | undefined> {
  const clientId = `agenteam-${randomUUID()}`;
  let lastResp: SendMessageResp | undefined;
  for (let i = 0; i < items.length; i++) {
    const isLast = i === items.length - 1;
    const req: SendMessageReq = {
      msg: {
        from_user_id: "",
        to_user_id: ctx.to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: isLast ? MessageState.FINISH : MessageState.GENERATING,
        item_list: [items[i]],
        context_token: ctx.opts.contextToken ?? undefined,
      },
    };
    lastResp = await sendMessage({ baseUrl: ctx.opts.baseUrl, token: ctx.opts.token, body: req });
    if (lastResp?.context_token) {
      ctx.opts.contextToken = lastResp.context_token;
    }
  }
  return lastResp;
}
