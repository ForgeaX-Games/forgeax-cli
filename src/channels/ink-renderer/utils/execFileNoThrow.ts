// Stub: execFileNoThrow (replaces claude-code version that depends on execa)
// Not needed for terminal rendering — only used by OSC clipboard/hyperlink features.

export interface ExecResult {
  exitCode: number
  code: number   // alias for exitCode (used by osc.ts)
  stdout: string
  stderr: string
}

export async function execFileNoThrow(
  _file: string,
  _args: string[],
  _opts?: Record<string, unknown>,
): Promise<ExecResult> {
  return { exitCode: 1, code: 1, stdout: '', stderr: 'not implemented (stub)' }
}
