// @desc WeChat QR code login flow — get_bot_qrcode + poll get_qrcode_status

import { randomUUID } from "node:crypto";

const DEFAULT_ILINK_BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface LoginResult {
  connected: boolean;
  botToken?: string;
  botId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

async function fetchQRCode(apiBaseUrl: string): Promise<QRCodeResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_ILINK_BOT_TYPE}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const headers: Record<string, string> = { "iLink-App-ClientVersion": "1" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as StatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

/**
 * Start QR login: fetch a QR code from iLink and display it in the terminal.
 * Returns the qrcode string needed for polling, or throws on failure.
 */
export async function startLogin(
  apiBaseUrl: string,
  log: (msg: string) => void,
): Promise<{ qrcode: string; qrcodeUrl: string }> {
  log("正在获取二维码...");
  const qrResponse = await fetchQRCode(apiBaseUrl);

  log("\n使用微信扫描以下二维码，以完成连接：\n");
  try {
    const qrcodeterminal = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrcodeterminal.default.generate(qrResponse.qrcode_img_content, { small: true }, (qr: string) => {
        process.stdout.write(qr + "\n");
        resolve();
      });
    });
  } catch {
    log(`二维码链接: ${qrResponse.qrcode_img_content}`);
  }

  return { qrcode: qrResponse.qrcode, qrcodeUrl: qrResponse.qrcode_img_content };
}

/**
 * Wait for user to scan + confirm the QR code. Handles QR expiry with auto-refresh.
 * Returns LoginResult with connection details on success.
 */
export async function waitForLogin(opts: {
  qrcode: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  log: (msg: string) => void;
}): Promise<LoginResult> {
  const timeoutMs = Math.max(opts.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let { qrcode } = opts;
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  opts.log("等待扫码...");

  while (Date.now() < deadline) {
    const statusResponse = await pollQRStatus(opts.apiBaseUrl, qrcode);

    switch (statusResponse.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedPrinted) {
          opts.log("👀 已扫码，在微信继续操作...");
          scannedPrinted = true;
        }
        break;

      case "expired": {
        qrRefreshCount++;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          return { connected: false, message: "登录超时：二维码多次过期，请重新开始登录流程。" };
        }
        opts.log(`⏳ 二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH_COUNT})`);
        const newQr = await fetchQRCode(opts.apiBaseUrl);
        qrcode = newQr.qrcode;
        scannedPrinted = false;
        opts.log("🔄 新二维码已生成，请重新扫描\n");
        try {
          const qrterm = await import("qrcode-terminal");
          await new Promise<void>((resolve) => {
            qrterm.default.generate(newQr.qrcode_img_content, { small: true }, (qr: string) => {
              process.stdout.write(qr + "\n");
              resolve();
            });
          });
        } catch {
          opts.log(`二维码链接: ${newQr.qrcode_img_content}`);
        }
        break;
      }

      case "confirmed": {
        if (!statusResponse.ilink_bot_id) {
          return { connected: false, message: "登录失败：服务器未返回 ilink_bot_id。" };
        }
        return {
          connected: true,
          botToken: statusResponse.bot_token,
          botId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl,
          userId: statusResponse.ilink_user_id,
          message: "✅ 与微信连接成功！",
        };
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  return { connected: false, message: "登录超时，请重试。" };
}
