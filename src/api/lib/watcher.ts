import chokidar, { type FSWatcher } from 'chokidar';

export interface FileChangeEvent {
  type: 'file-event';
  path: string;
  change: 'add' | 'update' | 'unlink';
}

type Listener = (ev: FileChangeEvent) => void;

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
