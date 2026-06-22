// hash utility — ESM-safe version (no require())
import crypto from 'crypto'

/**
 * Returns a stable hex string hash of the given content.
 * Used as cache key in StreamingMarkdown's token cache.
 */
export function hashContent(content: string): string {
  if (typeof Bun !== 'undefined' && typeof (Bun as any).hash === 'function') {
    return (Bun as any).hash(content).toString()
  }
  return crypto.createHash('sha256').update(content).digest('hex')
}
