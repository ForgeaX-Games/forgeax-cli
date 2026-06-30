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
import { join, resolve, dirname } from 'node:path';
import { homedir, platform as osPlatform, arch as osArch } from 'node:os';
import { assetRoot } from '@forgeax/platform-io';

/**
 * Pinned wasm-pack version. We download the official prebuilt binary instead
 * of `cargo install wasm-pack`, because compiling wasm-pack from source under
 * the isolated windows-gnu toolchain fails (missing MinGW `dlltool` when
 * building the transitive `windows-*` crates). The prebuilt msvc binary is a
 * standalone driver that simply shells out to cargo, so it works fine even on
 * a gnu cargo, and the engine itself targets wasm32-unknown-unknown.
 */
const WASM_PACK_VERSION = '0.13.1';

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
  cwd?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  onProgress?.('toolchain', `$ ${cmd.join(' ')}`);
  const proc = Bun.spawn({ cmd, cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
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

  // wasm-pack (prebuilt binary — see WASM_PACK_VERSION note above)
  const wasmPackBin = join(paths.cargoBin, `wasm-pack${ext}`);
  if (!existsSync(wasmPackBin)) {
    onProgress?.('toolchain', 'installing wasm-pack (prebuilt) …');
    await installWasmPack(paths, onProgress);
  }

  return paths;
}

/** GitHub release target triple for the prebuilt wasm-pack binary. */
function wasmPackTriple(): string {
  if (osPlatform() === 'win32') return 'x86_64-pc-windows-msvc';
  if (osPlatform() === 'darwin') return osArch() === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  return 'x86_64-unknown-linux-musl';
}

/**
 * Download + extract the official prebuilt wasm-pack binary into the isolated
 * cargo bin dir. Avoids the windows-gnu `cargo install` source-compile failure.
 *
 * Decompression + untar happen entirely in-process (Bun.gunzipSync + a minimal
 * ustar reader) rather than shelling out to a system `tar`: inside the server's
 * spawn environment the `tar` that wins on PATH may be GNU tar (e.g. Git for
 * Windows), which chokes on `C:\…` drive-letter paths and emits the opaque
 * "tar: Error is not recoverable: exiting now". In-process extraction is immune
 * to tar-flavour / path-quoting differences across platforms.
 */
async function installWasmPack(
  paths: ToolchainPaths,
  onProgress?: (phase: string, line?: string) => void,
): Promise<void> {
  const ext = osPlatform() === 'win32' ? '.exe' : '';
  const dest = join(paths.cargoBin, `wasm-pack${ext}`);
  const triple = wasmPackTriple();
  const asset = `wasm-pack-v${WASM_PACK_VERSION}-${triple}.tar.gz`;
  const url = `https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${asset}`;

  onProgress?.('toolchain', `downloading ${asset} …`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`failed to download wasm-pack: ${resp.status} ${url}`);
  const gz = Buffer.from(await resp.arrayBuffer());

  // Integrity guard: a valid .tar.gz starts with the gzip magic 0x1f 0x8b.
  // Catches truncated downloads / HTML error pages before we try to inflate.
  if (gz.length < 3 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
    throw new Error(`downloaded wasm-pack archive is not gzip (got ${gz.length} bytes); please retry`);
  }

  onProgress?.('toolchain', 'extracting wasm-pack …');
  const tar = Buffer.from(Bun.gunzipSync(gz));
  const exeBytes = extractTarEntry(tar, `wasm-pack${ext}`);
  if (!exeBytes) throw new Error('wasm-pack binary not found inside downloaded archive');

  mkdirSync(paths.cargoBin, { recursive: true });
  writeFileSync(dest, exeBytes);
  if (osPlatform() !== 'win32') chmodSync(dest, 0o755);
  onProgress?.('toolchain', 'wasm-pack installed ✓');
}

/**
 * Minimal in-process ustar reader: returns the bytes of the first regular-file
 * entry whose basename equals `basename`, or null. Sufficient for the flat
 * wasm-pack release tarball (`wasm-pack-v…-<triple>/wasm-pack[.exe]` + licenses).
 */
function extractTarEntry(tar: Buffer, basename: string): Buffer | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    // End-of-archive marker is an all-zero block.
    let allZero = true;
    for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
    if (allZero) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const typeflag = header[156];
    const dataStart = off + 512;

    const name = rawName.split('/').pop() ?? rawName;
    // typeflag '0' (0x30) or NUL (0x00) == regular file.
    if ((typeflag === 0x30 || typeflag === 0) && name === basename) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
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
  const wasmDir = join(studioRoot(), 'packages', 'engine', 'packages', 'wgpu-wasm');

  if (!existsSync(wasmDir)) {
    return { ok: false, error: `wgpu-wasm not found at ${wasmDir}` };
  }

  onProgress?.('engine-rebuild', 'wasm-pack build --target web …');
  const r = await run(
    [wasmPack, 'build', '--target', 'web', '--release', '--out-dir', join(wasmDir, 'pkg')],
    { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([_, v]) => v !== undefined)) as Record<string, string> },
    onProgress,
    wasmDir,
  );
  if (r.ok) {
    // Refresh the freshness sentinel so `bun run dev` (scripts/run.ts) does not
    // flag the freshly-built pkg/ as stale. Mirrors scripts/deploy.ts; the
    // anchor path must match run.ts's `join(ROOT, '.forgeax/sentinels/wgpu-wasm.built')`.
    const sentinel = join(studioRoot(), '.forgeax', 'sentinels', 'wgpu-wasm.built');
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, new Date().toISOString());
    onProgress?.('engine-rebuild', 'wasm core rebuilt ✓');
  } else {
    onProgress?.('engine-rebuild', `wasm core build failed: ${r.stderr.split('\n').pop()}`);
  }

  return { ok: r.ok, error: r.ok ? undefined : r.stderr };
}
