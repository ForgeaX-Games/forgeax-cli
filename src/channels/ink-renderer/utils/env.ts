// Stub: env utils (replaces claude-code src/utils/env.ts)
// Exposes only what theme.ts, markdown.ts etc. need.

type Platform = 'win32' | 'darwin' | 'linux'

function detectPlatform(): Platform {
  if (process.platform === 'win32' || process.platform === 'darwin') return process.platform
  return 'linux'
}

function detectTerminal(): string {
  return (
    process.env['TERM_PROGRAM'] ??
    process.env['TERM'] ??
    'unknown'
  )
}

export const env = {
  platform: detectPlatform() as Platform,
  arch: process.arch,
  nodeVersion: process.version,
  terminal: detectTerminal(),
  isCI: !!(process.env['CI']),
  isSSH: !!(process.env['SSH_CLIENT'] || process.env['SSH_TTY']),
}

export const IS_CI = env.isCI
export const DISABLE_SYNTAX_HIGHLIGHTING =
  process.env['CLAUDE_DISABLE_SYNTAX_HIGHLIGHTING'] === '1'

export function isTest(): boolean {
  return process.env['NODE_ENV'] === 'test'
}
