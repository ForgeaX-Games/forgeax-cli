import chokidar, { type FSWatcher } from 'chokidar';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface FileChangeEvent {
  type: 'file-event';
  path: string;
  change: 'add' | 'update' | 'unlink';
}

export interface AssetDiskChangedEvent {
  type: 'asset-disk-changed';
  path: string;
  change: FileChangeEvent['change'];
  gameSlug: string;
  /** Path relative to the game root, e.g. assets/scenes/main.pack.json. */
  gamePath: string;
  /** File category aligned with vite-plugin-pack's watched asset classes. */
  assetFileKind: 'pack' | 'meta' | 'source';
  /** Primary asset kind in the changed pack. Scene wins when present. */
  assetKind?: string;
  /** All top-level asset kinds declared by the pack, deduped in file order. */
  assetKinds?: string[];
  sceneGuid?: string;
  parseOk: boolean;
}

export type FsWatcherEvent = FileChangeEvent | AssetDiskChangedEvent;

type Listener = (ev: FsWatcherEvent) => void;

// Skip standard cache/vcs dirs everywhere. Inside .forgeax/ we specifically
// skip the high-churn runtime subtrees (agenteam-state has thousands of small
// session/terminal writes per minute; cache/ is transient) but NOT
// .forgeax/games/ — that's the instance-local game source directory the agent
// edits and we want every file change to surface.
const SKIP_RX = /(?:^|[\\/])(?:node_modules|\.git|dist|build|\.cache)(?:[\\/]|$)|(?:^|[\\/])\.forgeax[\\/](?:agenteam-state|cache)(?:[\\/]|$)/;

export class FsWatcher {
  private watcher?: FSWatcher;
  private listeners = new Set<Listener>();
  private rootDir = '';

  // Default to instance-local games dir under .forgeax/. Each studio dev /
  // release-forgeax instance owns its own .forgeax/games/, gitignored.
  start(rootDir: string, paths: string[] = ['.forgeax/games']): void {
    if (this.watcher) return;
    this.rootDir = rootDir;
    this.watcher = chokidar.watch(paths, {
      cwd: rootDir,
      ignored: (p: string) => SKIP_RX.test(p),
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
    });
    this.watcher.on('add', (p: string) => this.emit('add', p));
    this.watcher.on('change', (p: string) => this.emit('update', p));
    this.watcher.on('unlink', (p: string) => this.emit('unlink', p));
    this.watcher.on('error', (err: unknown) =>
      console.error('[fs-watcher]', (err as Error).message),
    );
    console.log(
      `[fs-watcher] watching ${paths.join(', ')} under ${rootDir}`,
    );
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-point the watcher at a new root (workspace hot-switch). Unlike
   *  stop()+start(), this preserves registered listeners — the hub.broadcast
   *  subscription wired at boot must survive the switch, otherwise file events
   *  from the new workspace would never reach live tabs. No-op if root is
   *  unchanged and a watcher is already running. */
  async rebind(rootDir: string, paths: string[] = ['.forgeax/games']): Promise<void> {
    if (this.watcher && this.rootDir === rootDir) return;
    await this.watcher?.close();
    this.watcher = undefined; // clears start()'s already-running guard; listeners survive
    this.start(rootDir, paths);
  }

  private emit(change: FileChangeEvent['change'], rawPath: string) {
    const norm = rawPath.split('\\').join('/');
    const ev: FileChangeEvent = { type: 'file-event', path: norm, change };
    this.broadcast(ev);
    void this.emitAssetDiskChanged(change, norm);
  }

  private async emitAssetDiskChanged(change: FileChangeEvent['change'], normPath: string): Promise<void> {
    const assetFileKind = this.assetFileKind(normPath);
    if (assetFileKind === null) return;
    const m = normPath.match(/^(?:\.forgeax\/games|games)\/([^/]+)\/(.+)$/);
    if (!m) return;
    const [, gameSlug, gamePath] = m;
    const ev: AssetDiskChangedEvent = {
      type: 'asset-disk-changed',
      path: normPath,
      change,
      gameSlug,
      gamePath,
      assetFileKind,
      parseOk: false,
    };
    if (change !== 'unlink' && (assetFileKind === 'pack' || assetFileKind === 'meta')) {
      try {
        const raw = await readFile(resolve(this.rootDir, normPath), 'utf8');
        const parsed = JSON.parse(raw) as { assets?: Array<{ kind?: unknown; guid?: unknown }> };
        const kinds: string[] = [];
        if (Array.isArray(parsed.assets)) {
          for (const asset of parsed.assets) {
            if (typeof asset?.kind !== 'string' || kinds.includes(asset.kind)) continue;
            kinds.push(asset.kind);
          }
          const scene = parsed.assets.find((asset) => asset?.kind === 'scene');
          ev.sceneGuid = typeof scene?.guid === 'string' ? scene.guid : undefined;
        }
        ev.assetKinds = kinds;
        ev.assetKind = kinds.includes('scene') ? 'scene' : kinds[0];
        ev.parseOk = true;
      } catch {
        ev.assetKind = 'unknown';
      }
    }
    this.broadcast(ev);
  }

  private assetFileKind(path: string): AssetDiskChangedEvent['assetFileKind'] | null {
    if (path.endsWith('.pack.json')) return 'pack';
    if (path.endsWith('.meta.json')) return 'meta';
    if (
      path.endsWith('.jpg') ||
      path.endsWith('.jpeg') ||
      path.endsWith('.png') ||
      path.endsWith('.gltf')
    ) return 'source';
    return null;
  }

  private broadcast(ev: FsWatcherEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('[fs-watcher] listener error:', (e as Error).message);
      }
    }
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }
}
