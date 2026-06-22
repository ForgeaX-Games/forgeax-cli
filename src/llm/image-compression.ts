import sharp from "sharp";
import { formatBytes } from "../utils.js";

export interface ImagePreflightPolicy {
  maxBytes?: number;
  maxBase64Bytes?: number;
  /** Reject images whose longest edge exceeds this many pixels (Anthropic multi-image limit = 2000). */
  maxLongEdge?: number;
  compressOversized?: boolean;
  supportedMimeTypes: ReadonlySet<string>;
}

const IMAGE_QUALITY_STEPS = [85, 75, 65, 55, 45];
const IMAGE_LONG_EDGE_STEPS = [2048, 1568, 1280, 1024, 768, 512];

export async function fitImageToPolicy(
  input: Buffer,
  inputMimeType: string,
  policy: ImagePreflightPolicy,
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const metadata = await safeMetadata(input);
  const longEdge = Math.max(metadata?.width ?? 0, metadata?.height ?? 0);
  const dimensionOk = !policy.maxLongEdge || longEdge === 0 || longEdge <= policy.maxLongEdge;

  const targets = uniqueNumbers([
    dimensionOk && longEdge > 0 ? longEdge : undefined,
    policy.maxLongEdge,
    ...IMAGE_LONG_EDGE_STEPS.filter((edge) => {
      if (edge >= longEdge && longEdge > 0) return false;
      if (policy.maxLongEdge && edge > policy.maxLongEdge) return false;
      return true;
    }),
  ]);

  if (dimensionOk && policy.supportedMimeTypes.has(inputMimeType) && !exceedsImageLimit(input, policy)) {
    return { bytes: input, mimeType: inputMimeType };
  }

  const formats = buildCandidateFormats(policy.supportedMimeTypes, inputMimeType);
  for (const targetLongEdge of targets) {
    for (const format of formats) {
      for (const quality of IMAGE_QUALITY_STEPS) {
        const candidate = await encodeImageCandidate(input, metadata, targetLongEdge, format, quality);
        if (candidate && !exceedsImageLimit(candidate, policy)) {
          return { bytes: candidate, mimeType: format };
        }
      }
    }
  }

  return null;
}

export function base64EncodedSize(bytes: Buffer): number {
  return 4 * Math.ceil(bytes.byteLength / 3);
}

export function exceedsImageLimit(bytes: Buffer, policy: ImagePreflightPolicy): boolean {
  if (policy.maxBytes !== undefined && bytes.byteLength > policy.maxBytes) {
    return true;
  }
  if (policy.maxBase64Bytes !== undefined && base64EncodedSize(bytes) > policy.maxBase64Bytes) {
    return true;
  }
  return false;
}

export async function exceedsImageDimensions(bytes: Buffer, policy: ImagePreflightPolicy): Promise<boolean> {
  if (!policy.maxLongEdge) return false;
  const metadata = await safeMetadata(bytes);
  const longEdge = Math.max(metadata?.width ?? 0, metadata?.height ?? 0);
  return longEdge > 0 && longEdge > policy.maxLongEdge;
}

export function describeImageLimit(policy: ImagePreflightPolicy): string {
  const parts: string[] = [];
  if (policy.maxBytes !== undefined) {
    parts.push(`${formatBytes(policy.maxBytes)} raw bytes`);
  }
  if (policy.maxBase64Bytes !== undefined) {
    parts.push(`${formatBytes(policy.maxBase64Bytes)} base64 payload`);
  }
  if (policy.maxLongEdge !== undefined) {
    parts.push(`${policy.maxLongEdge}px max edge`);
  }
  return parts.join(" / ") || "unknown";
}

export function describeImageSize(bytes: Buffer): string {
  return `${formatBytes(bytes.byteLength)} raw bytes / ${formatBytes(base64EncodedSize(bytes))} base64 payload`;
}

async function encodeImageCandidate(
  input: Buffer,
  metadata: sharp.Metadata | null,
  targetLongEdge: number,
  mimeType: string,
  quality: number,
): Promise<Buffer | null> {
  try {
    let pipeline = sharp(input, { animated: false, failOn: "none" });
    if (metadata?.width && metadata?.height && targetLongEdge > 0) {
      const landscape = metadata.width >= metadata.height;
      pipeline = pipeline.resize({
        width: landscape ? targetLongEdge : undefined,
        height: landscape ? undefined : targetLongEdge,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    switch (mimeType) {
      case "image/webp":
        pipeline = pipeline.webp({ quality });
        break;
      case "image/jpeg":
        pipeline = pipeline.flatten({ background: "#ffffff" }).jpeg({ quality, mozjpeg: true });
        break;
      case "image/png":
        pipeline = pipeline.png({ compressionLevel: 9, palette: true, quality });
        break;
      case "image/gif":
        pipeline = pipeline.gif();
        break;
      default:
        return null;
    }

    return await pipeline.toBuffer();
  } catch {
    return null;
  }
}

function buildCandidateFormats(
  supportedMimeTypes: ReadonlySet<string>,
  inputMimeType: string,
): string[] {
  const formats: string[] = [];
  if (supportedMimeTypes.has(inputMimeType)) formats.push(inputMimeType);
  if (supportedMimeTypes.has("image/webp")) formats.push("image/webp");
  if (supportedMimeTypes.has("image/jpeg")) formats.push("image/jpeg");
  if (supportedMimeTypes.has("image/png")) formats.push("image/png");
  return Array.from(new Set(formats));
}

async function safeMetadata(input: Buffer): Promise<sharp.Metadata | null> {
  try {
    return await sharp(input, { animated: false, failOn: "none" }).metadata();
  } catch {
    return null;
  }
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (!value || value <= 0 || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}
