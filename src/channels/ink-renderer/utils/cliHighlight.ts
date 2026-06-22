// Stub: CLI syntax highlighting (replaces claude-code cliHighlight.ts)
// Syntax highlighting is disabled in forgeax-cli — returns null (no highlight)

export type CliHighlight = {
  highlight: (code: string, options?: { language?: string } | string) => string
  supportsLanguage: (lang: string) => boolean
}

/**
 * Returns null — no syntax highlighting in forgeax-cli.
 * StreamingMarkdown falls back to plain monospace rendering for code blocks.
 */
export function getCliHighlightPromise(): Promise<CliHighlight | null> {
  return Promise.resolve(null)
}
