/**
 * StreamingMarkdown.tsx — Markdown rendering for forgeax-cli terminal UI
 *
 * Ported from claude-code src/components/Markdown.tsx
 * Changes from original:
 *   - Removed useSettings / syntaxHighlightingDisabled (always renders markdown)
 *   - Removed Suspense / MarkdownWithHighlight (syntax highlight is always null)
 *   - Removed React Compiler (_c) — written as plain React hooks
 *   - Import paths adapted for forgeax-cli layout
 */

import { marked, type Token, type Tokens } from 'marked'
import React, { useMemo, useRef } from 'react'
import { Ansi, Box, useTheme } from '../ink-compat.js'
import { getCliHighlightPromise } from '../../utils/cliHighlight.js'
import { hashContent } from '../../utils/hash.js'
import { configureMarked, formatToken } from '../../utils/markdown.js'
import { stripPromptXMLTags } from '../../utils/messages.js'
import { MarkdownTable } from './MarkdownTable.js'

// ─────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────

export type MarkdownProps = {
  /** Markdown text content */
  children: string
  /** When true, render all text content as dim */
  dimColor?: boolean
}

export type StreamingMarkdownProps = {
  /** Streaming markdown text (grows over time) */
  text: string
}

// ─────────────────────────────────────────────────────────────────
// Token cache (module-level LRU, survives unmount/remount)
// Keyed by content hash to avoid retaining full strings.
// ─────────────────────────────────────────────────────────────────

const TOKEN_CACHE_MAX = 500
const tokenCache = new Map<string, Token[]>()

// Single regex: matches any MD marker or ordered-list start.
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /

function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s)
}

function cachedLexer(content: string): Token[] {
  // Fast path: plain text with no markdown syntax → single paragraph token.
  if (!hasMarkdownSyntax(content)) {
    return [
      {
        type: 'paragraph',
        raw: content,
        text: content,
        tokens: [{ type: 'text', raw: content, text: content }],
      } as Token,
    ]
  }
  const key = hashContent(content)
  const hit = tokenCache.get(key)
  if (hit) {
    // Promote to MRU
    tokenCache.delete(key)
    tokenCache.set(key, hit)
    return hit
  }
  const tokens = marked.lexer(content)
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const first = tokenCache.keys().next().value
    if (first !== undefined) tokenCache.delete(first)
  }
  tokenCache.set(key, tokens)
  return tokens
}

// ─────────────────────────────────────────────────────────────────
// MarkdownBody — renders tokens to Ansi + MarkdownTable elements
// ─────────────────────────────────────────────────────────────────

function MarkdownBody({ children, dimColor }: MarkdownProps): React.JSX.Element {
  const [theme] = useTheme()
  configureMarked()

  // highlight is always null in forgeax-cli (no cli-highlight dependency)
  const highlight = null

  const elements = useMemo(() => {
    const tokens = cachedLexer(stripPromptXMLTags(children))
    const result: React.ReactNode[] = []
    let nonTableContent = ''

    const flushNonTableContent = () => {
      if (nonTableContent) {
        result.push(
          <Ansi key={result.length} dimColor={dimColor}>
            {nonTableContent.trim()}
          </Ansi>
        )
        nonTableContent = ''
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flushNonTableContent()
        result.push(
          <MarkdownTable
            key={result.length}
            token={token as Tokens.Table}
            highlight={highlight}
          />
        )
      } else {
        nonTableContent += formatToken(token, theme, 0, null, null, highlight)
      }
    }
    flushNonTableContent()
    return result
  }, [children, dimColor, theme]) // highlight is always null, skip dep

  return (
    <Box flexDirection="column" gap={1}>
      {elements}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────
// Markdown — top-level component (no syntax highlighting)
// ─────────────────────────────────────────────────────────────────

/**
 * Renders markdown content.
 * Tables → MarkdownTable (React flexbox), other content → ANSI strings via formatToken.
 */
export function Markdown({ children, dimColor }: MarkdownProps): React.JSX.Element {
  return <MarkdownBody dimColor={dimColor}>{children}</MarkdownBody>
}

// ─────────────────────────────────────────────────────────────────
// StreamingMarkdown — streaming-optimised entry point
// ─────────────────────────────────────────────────────────────────

/**
 * Renders markdown during streaming by splitting at the last top-level block
 * boundary: everything before is stable (memoized, never re-parsed), only the
 * final block is re-parsed per delta.
 *
 * marked.lexer() correctly handles unclosed code fences as a single token,
 * so block boundaries are always safe.
 *
 * Props:
 *   text — the current full text received so far (grows monotonically)
 */
export function StreamingMarkdown({ text }: StreamingMarkdownProps): React.JSX.Element {
  // 'use no memo' — reads and writes stablePrefixRef.current during render
  // by design. The boundary only advances (monotonic), so the ref mutation
  // is idempotent under StrictMode double-render.
  configureMarked()

  const stripped = stripPromptXMLTags(text)
  const stablePrefixRef = useRef('')

  // Reset if text was replaced (defensive; normally unmount handles this)
  if (!stripped.startsWith(stablePrefixRef.current)) {
    stablePrefixRef.current = ''
  }

  // Lex only from current boundary — O(unstable length), not O(full text)
  const boundary = stablePrefixRef.current.length
  const tokens = marked.lexer(stripped.substring(boundary))

  // Last non-space token is the growing block; everything before is final
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') {
    lastContentIdx--
  }
  let advance = 0
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tokens[i]!.raw.length
  }
  if (advance > 0) {
    stablePrefixRef.current = stripped.substring(0, boundary + advance)
  }

  const stablePrefix = stablePrefixRef.current
  const unstableSuffix = stripped.substring(stablePrefix.length)

  return (
    <Box flexDirection="column" gap={1}>
      {stablePrefix && <Markdown>{stablePrefix}</Markdown>}
      {unstableSuffix && <Markdown>{unstableSuffix}</Markdown>}
    </Box>
  )
}
