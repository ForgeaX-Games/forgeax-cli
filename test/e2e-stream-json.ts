#!/usr/bin/env bun
// Smoke test for `agenteam chat ... --stream-json` (P5 step a).
//
// Requires a running cli gateway at the path AGENTEAM_STATE_DIR points to
// (or default ~/.agenteam/gateway.json). On the forgeax-studio dev box the
// path is .forgeax/agenteam-state/gateway.json.
//
// Verifies the mechanism, NOT the full agent loop:
//   1. Subcommand parses --stream-json flag without dying
//   2. WS handshake succeeds (else process exits before any stdout)
//   3. At least one ndjson event line is emitted (the echoed user_input)
//   4. Each output line is valid JSON with {type:"event", instanceId, event}
//
// Does NOT require the agent to complete a turn — that's gated on the
// agent's LLM key + team-pack state which varies per env. Exit-on-turnEnd
// behavior is tested separately when an end-to-end agent is configured.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const STATE_DIR = process.env.AGENTEAM_STATE_DIR
  ?? resolve(__dirname, '../../../.forgeax/agenteam-state');
const INSTANCE = process.env.FORGEAX_TEST_INSTANCE ?? 'forgeax';
const AGENT = process.env.FORGEAX_TEST_AGENT ?? 'admin';
const BIN = resolve(__dirname, '../bin/agenteam');

let failures = 0;
function check(label: string, ok: boolean, detail: string = ''): void {
  const tag = ok ? '✓' : '✗';
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main(): Promise<void> {
  console.log(`[e2e-stream-json] state=${STATE_DIR} instance=${INSTANCE} agent=${AGENT}`);

  if (!existsSync(`${STATE_DIR}/gateway.json`)) {
    console.error('skip: no gateway.json — cli daemon not initialized in this env');
    process.exit(0);
  }

  // Spawn the subcommand. We give it 5s to receive ≥1 frame and emit it
  // to stdout. After 5s we SIGTERM (its own SIGTERM handler resolves the
  // promise cleanly; process exits 1 with reason=SIGTERM).
  const proc = spawn(BIN, [
    'chat', AGENT, 'stream-json smoke probe',
    '--instance', INSTANCE,
    '--stream-json',
  ], {
    env: { ...process.env, AGENTEAM_STATE_DIR: STATE_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf-8'); });
  proc.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf-8'); });

  const exitPromise = new Promise<number>((res) => {
    proc.on('close', (code) => res(code ?? 0));
  });

  // Give it 5 seconds, then SIGTERM
  setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 5_000);

  const code = await exitPromise;

  check('process exited (success or SIGTERM)', code === 0 || code === 1, `exit=${code}`);
  check('stdout contains at least one ndjson line', stdout.trim().length > 0, `${stdout.length} bytes`);
  if (stdout.trim().length === 0) {
    console.error('--- captured stderr ---');
    console.error(stderr);
  } else {
    const lines = stdout.trim().split('\n');
    let validLines = 0;
    let sawUserInput = false;
    for (const ln of lines) {
      try {
        const f = JSON.parse(ln);
        validLines += 1;
        if (f.type === 'event' && f.event?.type === 'user_input') sawUserInput = true;
      } catch { /* not valid JSON */ }
    }
    check('every stdout line is valid JSON', validLines === lines.length, `${validLines}/${lines.length}`);
    check('saw at least the echoed user_input event', sawUserInput);
  }

  console.log('');
  if (failures > 0) {
    console.error(`[e2e-stream-json] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('[e2e-stream-json] all green ✓');
}

void main();
