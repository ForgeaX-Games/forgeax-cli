import type { ContentPart, EventContent } from "../../../core/types.js";
import { fileToContentPart, isBinaryFile, isFileMediaContentPart } from "../../../core/types.js";
import type { InputSegment } from "../../shared/input-segments.js";
import { lookup } from "mime-types";

export async function inputSegmentsToEventContent(segments: InputSegment[]): Promise<EventContent> {
  const hasAttachments = segments.some((seg) => seg.type === "file" || seg.type === "media");
  const text = segmentsToPlainText(segments);

  if (!hasAttachments) return text;

  const parts: ContentPart[] = [];
  let pendingText = "";

  const flushText = () => {
    if (!pendingText) return;
    parts.push({ type: "text", text: pendingText });
    pendingText = "";
  };

  for (const seg of segments) {
    if (seg.type === "media") {
      flushText();
      parts.push({ type: seg.modality, data: seg.data, mimeType: seg.mimeType } as ContentPart);
      continue;
    }
    if (seg.type !== "file") {
      pendingText += seg.content;
      continue;
    }

    flushText();
    const mimeType = seg.mimeType || lookup(seg.path) || "application/octet-stream";
    const binary = await isBinaryFile(seg.path).catch(() => true);
    const part = fileToContentPart(seg.path, mimeType, binary);
    // User-supplied path originates on the host — mark media part so readMediaBytes
    // skips the sandbox bridge.
    parts.push(isFileMediaContentPart(part) ? { ...part, inContainer: false } : part);
  }

  flushText();
  return parts.length > 0 ? parts : text;
}

export function segmentsToPlainText(segments: InputSegment[]): string {
  return segments
    .filter((seg): seg is Extract<InputSegment, { type: "text" | "paste" }> => seg.type === "text" || seg.type === "paste")
    .map((seg) => seg.content)
    .join("");
}

export function hasSubmittableSegments(segments: InputSegment[]): boolean {
  if (segments.some((seg) => seg.type === "file" || seg.type === "media")) return true;
  return segmentsToPlainText(segments).trim().length > 0;
}
