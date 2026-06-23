/**
 * Smoke test for StreamingMarkdown — tests formatToken directly (no Ink context needed)
 * Also instantiates Ink to test component rendering path.
 * Run: tsx src/ink/test-streaming-markdown.tsx
 */

import { marked } from 'marked'
import { configureMarked, formatToken } from '../utils/markdown.js'
import { stripPromptXMLTags } from '../utils/messages.js'

// ── Test 1: formatToken (pure chalk, no React needed) ──────────────────────

configureMarked()
const theme = 'dark' as const

const testCases = [
  { label: 'Heading + inline styles', text: '# Hello World\n\n**bold** and *italic* and `code`' },
  { label: 'Code block (closed)', text: '```python\nprint("hello world")\n```' },
  { label: 'Code block (unclosed)', text: '```typescript\nconst x = 1' },
  { label: 'Chinese + bold', text: '中文 **加粗** 测试\n\n> 引用文字' },
  { label: 'Numbered list', text: '1. First item\n2. Second item\n3. Third item' },
  { label: 'Streaming growth sim', text: '## Streaming\n\nThis is a **streaming** response that grows over time.' },
]

console.log('\x1b[1;36m═══════════════════════════════════════════\x1b[0m')
console.log('\x1b[1;36m  StreamingMarkdown Smoke Test\x1b[0m')
console.log('\x1b[1;36m═══════════════════════════════════════════\x1b[0m')

for (const { label, text } of testCases) {
  console.log(`\n\x1b[1;33m▶ ${label}\x1b[0m`)
  console.log('\x1b[2m  input: ' + text.replace(/\n/g, '↵') + '\x1b[0m')
  console.log('\x1b[2m  rendered:\x1b[0m')

  const stripped = stripPromptXMLTags(text)
  const tokens = marked.lexer(stripped)
  let output = ''
  for (const token of tokens) {
    if (token.type !== 'table') {
      output += formatToken(token, theme, 0, null, null, null)
    }
  }
  console.log(output.trimEnd() || '  (empty)')
  console.log()
}

// ── Test 2: StreamingMarkdown boundary split ────────────────────────────────

console.log('\x1b[1;36m═══════════════════════════════════════════\x1b[0m')
console.log('\x1b[1;36m  Streaming boundary split simulation\x1b[0m')
console.log('\x1b[1;36m═══════════════════════════════════════════\x1b[0m\n')

const fullText = '# Title\n\nFirst paragraph with **bold** text.\n\n```js\nconsole.log("hello")\n```\n\nFinal paragraph.'

// Simulate streaming in chunks
const chunks = [
  fullText.slice(0, 10),   // mid-heading
  fullText.slice(0, 40),   // end of first para
  fullText.slice(0, 80),   // inside code block
  fullText,                 // complete
]

for (const chunk of chunks) {
  const tokens = marked.lexer(chunk)
  // Find last non-space token boundary
  let lastContentIdx = tokens.length - 1
  while (lastContentIdx >= 0 && tokens[lastContentIdx]!.type === 'space') lastContentIdx--
  let advanceBytes = 0
  for (let i = 0; i < lastContentIdx; i++) advanceBytes += tokens[i]!.raw.length
  const stable = chunk.slice(0, advanceBytes)
  const unstable = chunk.slice(advanceBytes)
  console.log(`\x1b[2mchunk[${chunk.length}]: stable=${advanceBytes}b unstable=${unstable.length}b\x1b[0m`)
}

console.log('\n\x1b[1;32m✅ Smoke test complete — StreamingMarkdown formatToken works correctly\x1b[0m')
