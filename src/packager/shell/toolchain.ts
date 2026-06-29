/**
 * Isolated Rust toolchain bootstrap for engine WASM core compilation.
 *
 * Tools are installed into `~/.forgeax/toolchains/rust/` — no global
 * PATH or VS / MSVC mutation.  Only needed when the user toggles
 * "Rebuild Engine Core" (rebuildEngine: true).
 *
 * Required binaries after bootstrap:
 *   rustc  (stable, gnu target on Windows)
 *   wasm-pack
 *   target: wasm32-unknown-unknown
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform as osPlatform } from 'node:os';
import { assetRoot } from '@forgeax/platform-io';

/** Monorepo root (`forgeax-studio/`), NOT the user's game instance dir. */
function studioRoot(): string {
  return resolve(assetRoot(), '..');
}

export interface ToolchainPaths {
  rustupHome: string;
  cargoHome: string;
  cargoBin: string;
}

export interface ToolchainStatus {
  available: boolean;
  rustc?: string;
  wasmPack?: boolean;
  paths: ToolchainPaths;
}

function getPaths(): ToolchainPaths {
  const base = join(homedir(), '.forgeax', 'toolchains', 'rust');
  return {
    rustupHome: join(base, 'rustup'),
    cargoHome: join(base, 'cargo'),
    cargoBin: join(base, 'cargo', 'bin'),
  };
}

function buildEnv(p: ToolchainPaths): Record<string, string> {
  return {
    RUSTUP_HOME: p.rustupHome,
    CARGO_HOME: p.cargoHome,
    PATH: `${p.cargoBin}${osPlatform() === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
  };
}

async function run(
  cmd: string[],
  env: Record<string, string>,
  onProgress?: (phase: string, line?: string) => void,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  onProgress?.('toolchain', `$ ${cmd.join(' ')}`);
  const proc = Bun.spawn({ cmd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stdout.trim()) onProgress?.('toolchain', stdout.trim().split('\n').pop()!);
  if (code !== 0) onProgress?.('toolchain', `exit ${code}: ${stderr.trim().split('\n').pop()}`);
  return { ok: code === 0, stdout, stderr };
}

export async function detect(onProgress?: (phase: string, line?: string) => void): Promise<ToolchainStatus> {
  const paths = getPaths();
  const env = buildEnv(paths);
  const ext = osPlatform() === 'win32' ? '.exe' : '';

  const rustcBin = join(paths.cargoBin, `rustc${ext}`);
  const wasmPackBin = join(paths.cargoBin, `wasm-pack${ext}`);

  if (!existsSync(rustcBin)) {
    onProgress?.('toolchain', 'rustc not found in isolated toolchain');
    return { available: false, paths };
  }

  const r = await run([rustcBin, '--version'], env, onProgress);
  if (!r.ok) return { available: false, paths };

  return {
    available: true,
    rustc: r.stdout.trim(),
    wasmPack: existsSync(wasmPackBin),
    paths,
  };
}

export async function ensureRust(onProgress?: (phase: string, line?: string) => void): Promise<ToolchainPaths> {
  const paths = getPaths();
  const env = buildEnv(paths);
  mkdirSync(paths.rustupHome, { recursive: true });
  mkdirSync(paths.cargoHome, { recursive: true });

  const ext = osPlatform() === 'win32' ? '.exe' : '';
  const rustcBin = join(paths.cargoBin, `rustc${ext}`);

  if (existsSync(rustcBin)) {
    onProgress?.('toolchain', 'rustc already installed');
  } else {
    onProgress?.('toolchain', 'installing Rust (isolated) …');
    if (osPlatform() === 'win32') {
      await installRustWindows(paths, env, onProgress);
    } else {
      await installRustUnix(paths, env, onProgress);
    }
  }

  // wasm32 target
  const rustup = join(paths.cargoBin, `rustup${ext}`);
  await run([rustup, 'target', 'add', 'wasm32-unknown-unknown'], env, onProgress);

  // wasm-pack
  const wasmPackBin = join(paths.cargoBin, `wasm-pack${ext}`);
  if (!existsSync(wasmPackBin)) {
    onProgress?.('toolchain', 'installing wasm-pack …');
    const cargo = join(paths.cargoBin, `cargo${ext}`);
    await run([cargo, 'install', 'wasm-pack'], env, onProgress);
  }

  return paths;
}

async function installRustWindows(
  paths: ToolchainPaths,
  env: Record<string, string>,
  onProgress?: (phase: string, line?: string) => void,
): Promise<void> {
  const initExe = join(paths.cargoHome, 'rustup-init.exe');

  if (!existsSync(initExe)) {
    onProgress?.('toolchain', 'downloading rustup-init.exe …');
    const resp = await fetch('https://win.rustup.rs/x86_64');
    if (!resp.ok) throw new Error(`failed to download rustup-init: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    writeFileSync(initExe, Buffer.from(buf));
  }

  // Use GNU target to bypass MSVC requirement
  await run(
    [initExe, '-y', '--no-modify-path', '--default-host', 'x86_64-pc-windows-gnu'],
    env, onProgress,
  );
}

async function installRustUnix(
  paths: ToolchainPaths,
  env: Record<string, string>,
  onProgress?: (phase: string, line?: string) => void,
): Promise<void> {
  const initSh = join(paths.cargoHome, 'rustup-init.sh');

  if (!existsSync(initSh)) {
    onProgress?.('toolchain', 'downloading rustup-init.sh …');
    const resp = await fetch('https://sh.rustup.rs');
    if (!resp.ok) throw new Error(`failed to download rustup-init: ${resp.status}`);
    writeFileSync(initSh, await resp.text());
    chmodSync(initSh, 0o755);
  }

  await run(['sh', initSh, '-y', '--no-modify-path'], env, onProgress);
}

/**
 * Run `wasm-pack build` for the engine WASM core (wgpu-wasm).
 */
export async function buildWasmCore(
  onProgress?: (phase: string, line?: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const paths = await ensureRust(onProgress);
  const env = buildEnv(paths);
  const ext = osPlatform() === 'win32' ? '.exe' : '';

  const wasmPack = join(paths.cargoBin, `wasm-pack${ext}`);
  const wasmDir = join(studioRoot(), 'packages', 'wgpu-wasm');

  if (!existsSync(wasmDir)) {
    return { ok: false, error: `wgpu-wasm not found at ${wasmDir}` };
  }

  onProgress?.('engine-rebuild', 'wasm-pack build --target web …');
  const r = await run(
    [wasmPack, 'build', '--target', 'web', '--release'],
    { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([_, v]) => v !== undefined)) as Record<string, string> },
    onProgress,
  );
  r.ok
    ? onProgress?.('engine-rebuild', 'wasm core rebuilt ✓')
    : onProgress?.('engine-rebuild', `wasm core build failed: ${r.stderr.split('\n').pop()}`);

  return { ok: r.ok, error: r.ok ? undefined : r.stderr };
}
