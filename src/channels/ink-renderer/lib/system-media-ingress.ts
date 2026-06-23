import { spawn } from "node:child_process";
import { buildFileSegments, parseTextAsFileSegments } from "./file-reference-parser.js";
import type { InputSegment } from "../../shared/input-segments.js";

type FileSegment = Extract<InputSegment, { type: "file" }>;
type MediaSegment = Extract<InputSegment, { type: "media" }>;

type ClipboardPayload =
  | { kind: "files"; paths: string[] }
  | { kind: "image"; data: Buffer; mimeType: string }
  | { kind: "text"; text: string }
  | null;

export type SystemMediaPullResult =
  | { kind: "ok"; segments: (FileSegment | MediaSegment)[] }
  | { kind: "empty"; message: string };

export async function pullSystemMedia(): Promise<SystemMediaPullResult> {
  const payload = await readClipboardPayload();
  if (!payload) {
    return { kind: "empty", message: "剪贴板里没有可抓取的文件或多媒体内容" };
  }

  if (payload.kind === "files") {
    const segments = await buildFileSegments(payload.paths);
    return segments.length > 0
      ? { kind: "ok", segments }
      : { kind: "empty", message: "剪贴板里的文件当前不可访问" };
  }

  if (payload.kind === "image") {
    const segment: MediaSegment = {
      type: "media",
      data: payload.data.toString("base64"),
      mimeType: payload.mimeType,
      modality: "image",
    };
    return { kind: "ok", segments: [segment] };
  }

  const pathSegments = await parseTextAsFileSegments(payload.text);
  return pathSegments
    ? { kind: "ok", segments: pathSegments }
    : { kind: "empty", message: "剪贴板当前只有普通文本，没有文件或多媒体内容" };
}

async function readClipboardPayload(): Promise<ClipboardPayload> {
  if (isWsl()) {
    const windowsPayload = await readWindowsClipboard();
    if (windowsPayload) return windowsPayload;
  }

  const linuxPayload = await readLinuxClipboard();
  if (linuxPayload) return linuxPayload;

  return null;
}

async function readWindowsClipboard(): Promise<ClipboardPayload> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$result = [ordered]@{ kind = 'empty' }",
    "if ([Windows.Forms.Clipboard]::ContainsFileDropList()) {",
    "  $result.kind = 'files'",
    "  $result.paths = @([Windows.Forms.Clipboard]::GetFileDropList())",
    "} elseif ([Windows.Forms.Clipboard]::ContainsImage()) {",
    "  $img = [Windows.Forms.Clipboard]::GetImage()",
    "  if ($img -ne $null) {",
    "    $ms = New-Object System.IO.MemoryStream",
    "    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
    "    $result.kind = 'image'",
    "    $result.data = [Convert]::ToBase64String($ms.ToArray())",
    "    $result.mimeType = 'image/png'",
    "    $ms.Dispose()",
    "  }",
    "} elseif ([Windows.Forms.Clipboard]::ContainsText()) {",
    "  $result.kind = 'text'",
    "  $result.text = [Windows.Forms.Clipboard]::GetText()",
    "}",
    "$result | ConvertTo-Json -Compress",
  ].join("; ");

  const res = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
  if (!res.ok) return null;

  try {
    const parsed = JSON.parse(res.stdoutText) as Record<string, unknown>;
    if (parsed.kind === "files" && Array.isArray(parsed.paths)) {
      return { kind: "files", paths: parsed.paths.map((p) => String(p)) };
    }
    if (parsed.kind === "image" && typeof parsed.data === "string") {
      return { kind: "image", data: Buffer.from(parsed.data as string, "base64"), mimeType: String(parsed.mimeType ?? "image/png") };
    }
    if (parsed.kind === "text" && typeof parsed.text === "string") {
      return { kind: "text", text: parsed.text };
    }
  } catch {
    return null;
  }

  return null;
}

async function readLinuxClipboard(): Promise<ClipboardPayload> {
  const waylandPayload = await readWaylandClipboard();
  if (waylandPayload) return waylandPayload;
  return readX11Clipboard();
}

async function readWaylandClipboard(): Promise<ClipboardPayload> {
  if (!process.env.WAYLAND_DISPLAY) return null;

  const targets = await run(["wl-paste", "--list-types"]);
  if (!targets.ok) return null;
  const types = lines(targets.stdoutText);

  const uriType = resolveUriType(types);
  if (uriType) {
    const res = await run(["wl-paste", "--no-newline", "--type", uriType]);
    if (res.ok) return { kind: "text", text: res.stdoutText };
  }

  for (const imageType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    if (!types.includes(imageType)) continue;
    const res = await run(["wl-paste", "--type", imageType], { binary: true });
    if (!res.ok || res.stdout.length === 0) continue;
    return { kind: "image", data: res.stdout, mimeType: imageType };
  }

  const text = await run(["wl-paste", "--no-newline"]);
  return text.ok ? { kind: "text", text: text.stdoutText } : null;
}

async function readX11Clipboard(): Promise<ClipboardPayload> {
  if (!process.env.DISPLAY) return null;

  const targets = await run(["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"]);
  if (!targets.ok) return null;
  const types = lines(targets.stdoutText);

  const uriType = resolveUriType(types);
  if (uriType) {
    const res = await run(["xclip", "-selection", "clipboard", "-t", uriType, "-o"]);
    if (res.ok) return { kind: "text", text: res.stdoutText };
  }

  for (const imageType of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
    if (!types.includes(imageType)) continue;
    const res = await run(["xclip", "-selection", "clipboard", "-t", imageType, "-o"], { binary: true });
    if (!res.ok || res.stdout.length === 0) continue;
    return { kind: "image", data: res.stdout, mimeType: imageType };
  }

  const text = await run(["xclip", "-selection", "clipboard", "-o"]);
  return text.ok ? { kind: "text", text: text.stdoutText } : null;
}

function resolveUriType(types: string[]): string | null {
  if (types.includes("text/uri-list")) return "text/uri-list";
  if (types.includes("x-special/gnome-copied-files")) return "x-special/gnome-copied-files";
  return null;
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isWsl(): boolean {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function run(
  argv: string[],
  opts: { binary?: boolean } = {},
): Promise<{ ok: boolean; stdout: Buffer; stdoutText: string }> {
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => resolve({ ok: false, stdout: Buffer.alloc(0), stdoutText: "" }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      resolve({
        ok: code === 0,
        stdout,
        stdoutText: opts.binary ? "" : stdout.toString("utf8"),
      });
    });
  });
}
