// Resolve a CLI binary path with the same precedence every provider follows:
//   1. ProviderConfig.options.binary (explicit, e.g. set by /api/settings)
//   2. <ENV_VAR_NAME> env (operator override)
//   3. Bun.which(defaultBinary) — cross-platform PATH lookup
//   4. defaultBinary literal (let spawn fail loudly if it's not on PATH)
//
// Why Bun.which, not `which <name>`: on Windows `which` (a git-bash util) is
// often absent and, when present, returns the **extensionless POSIX-style
// script** (`/c/.../claude`) that Node's child_process.spawn can't exec. The
// real launcher is `claude.cmd`. Bun.which honours PATHEXT and returns the
// genuine Windows executable with a native path (`C:\...\claude.cmd`), which
// the agent-host's node spawn runs as-is — fixing claude-code / codex /
// cursor-agent / codebuddy on Windows in one place. On POSIX it returns the
// same path `which` would.
//
// Extracted because ClaudeCodeProvider + CodexProvider had byte-for-byte
// identical resolveBinary() blocks differing only in env-var name and default.
// Any future provider (Gemini, Hermes, ...) reuses the same shape.

export interface ResolveBinaryOptions {
  /** Explicit override (e.g. cfg.options.binary from /api/settings). */
  configured?: string;
  /** Env var operators can use to point at a non-PATH binary (e.g. ANTHROPIC_CLI_PATH). */
  envVarName: string;
  /** Literal binary name (e.g. 'claude', 'codex') passed to `which`. */
  defaultBinary: string;
}

export async function resolveBinary(opts: ResolveBinaryOptions): Promise<string> {
  if (opts.configured) return opts.configured;
  const fromEnv = process.env[opts.envVarName];
  if (fromEnv) return fromEnv;
  try {
    const resolved = Bun.which(opts.defaultBinary);
    if (resolved) return resolved;
  } catch {
    /* fall through to defaultBinary literal */
  }
  return opts.defaultBinary;
}
