import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { lookup as mimeLookup } from "mime-types";
import type { InputModality } from "../../../core/types.js";
import type { InputSegment } from "../../shared/input-segments.js";

type FileSegment = Extract<InputSegment, { type: "file" }>;

const WINDOWS_PATH_RE = /^[A-Za-z]:\\/;

export async function parseTextAsFileSegments(
  text: string,
  baseDir = process.cwd(),
): Promise<FileSegment[] | null> {
  const candidates = splitPathCandidates(text);
  if (candidates.length === 0 || candidates.length > 20) return null;

  const paths: string[] = [];
  for (const candidate of candidates) {
    const normalized = await normalizePotentialPath(candidate, baseDir);
    if (!normalized || !existsSync(normalized)) return null;
    paths.push(normalized);
  }

  const segments = await buildFileSegments(paths);
  return segments.length > 0 ? segments : null;
}

export async function buildFileSegments(paths: string[]): Promise<FileSegment[]> {
  const segments: FileSegment[] = [];

  for (const rawPath of paths) {
    const path = await normalizePotentialPath(rawPath, process.cwd());
    if (!path) continue;

    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }

    const mimeType = inferMimeType(path);
    segments.push({
      type: "file",
      path,
      mimeType: mimeType ?? undefined,
      modality: inferModality(path, mimeType),
    });
  }

  return segments;
}

function splitPathCandidates(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalized) return [];
  return normalized.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function normalizePotentialPath(raw: string, baseDir: string): Promise<string | null> {
  const trimmed = unwrapQuotedPath(raw.trim());
  if (!trimmed) return null;

  if (trimmed.startsWith("vscode-remote://")) {
    const remote = normalizeVsCodeRemoteUri(trimmed);
    return remote ? normalizePotentialPath(remote, baseDir) : null;
  }

  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== "file:") return null;
      const pathname = decodeURIComponent(url.pathname);
      const filePath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
      return normalizePotentialPath(filePath, baseDir);
    } catch {
      return null;
    }
  }

  if (isWsl() && WINDOWS_PATH_RE.test(trimmed)) {
    const converted = await convertWindowsPath(trimmed);
    return converted ? normalizePotentialPath(converted, baseDir) : null;
  }

  const unescaped = trimmed.replace(/\\([ "\\'()])/g, "$1");
  if (unescaped.startsWith("/")) return unescaped;
  return resolve(baseDir, unescaped);
}

function normalizeVsCodeRemoteUri(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "vscode-remote:") return null;
    const authority = decodeURIComponent(url.host);
    const pathname = decodeURIComponent(url.pathname);
    if (authority.startsWith("wsl+")) return pathname || null;
    return pathname || null;
  } catch {
    return null;
  }
}

function unwrapQuotedPath(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""))) {
    return value.slice(1, -1);
  }
  return value;
}

function inferMimeType(path: string): string | null {
  const mime = mimeLookup(path);
  return typeof mime === "string" ? mime : null;
}

function inferModality(path: string, mimeType?: string | null): InputModality | undefined {
  const mime = mimeType ?? inferMimeType(path);
  if (!mime) return undefined;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return undefined;
}

function isWsl(): boolean {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function convertWindowsPath(path: string): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolvePromise) => {
    const child = spawn("wslpath", ["-u", path], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolvePromise(null));
    child.on("close", (code) => {
      resolvePromise(code === 0 ? stdout.trim() : null);
    });
  });
}
