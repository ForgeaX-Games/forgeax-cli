// useTerminalSize hook for forgeax-cli
// Returns current terminal dimensions, updating on SIGWINCH resize events.

import { useState, useEffect } from 'react'

export interface TerminalSize {
  columns: number
  rows: number
}

function getSize(): TerminalSize {
  return {
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  }
}

// Single stdout 'resize' listener fan-out: long sessions with many
// MarkdownTable instances would otherwise blow MaxListeners (>50).
const subs = new Set<(s: TerminalSize) => void>()
process.stdout.on('resize', () => { const s = getSize(); subs.forEach(fn => fn(s)) })

/**
 * Returns terminal { columns, rows }, updating on window resize.
 * Drop-in replacement for claude-code's useTerminalSize hook.
 */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>(getSize)
  useEffect(() => { subs.add(setSize); return () => { subs.delete(setSize) } }, [])
  return size
}
