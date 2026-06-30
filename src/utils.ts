// @desc Shared tiny utilities — sleep, isPlainObject, formatBytes

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Request cancelled")); return; }
    const timeout = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("Request cancelled")); }, { once: true });
    }
  });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  return `${(kib / 1024).toFixed(1)} MB`;
}
