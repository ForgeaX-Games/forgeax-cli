// Resolve a CLI binary path with the same precedence every provider follows:
//   1. ProviderConfig.options.binary (explicit, e.g. set by /api/settings)
//   2. <ENV_VAR_NAME> env (operator override)
//   3. `which <defaultBinary>` (PATH lookup via Bun.spawn — avoids importing
//      child_process)
//   4. defaultBinary literal (let spawn fail loudly if it's not on PATH)
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
    const proc = Bun.spawn({
      cmd: ['which', opts.defaultBinary],
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const txt = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    if (txt) return txt;
  } catch {
    /* fall through to defaultBinary literal */
  }
  return opts.defaultBinary;
}
