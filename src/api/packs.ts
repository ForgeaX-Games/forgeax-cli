/** /api/packs — Phase D7.
 *
 *   POST /api/packs/export   → produce .fxpack from existing plugin ids
 *   POST /api/packs/inspect  → return TrustDescriptor for a pack at <path>
 *                              or uploaded multipart body
 *   POST /api/packs/install  → install a pack to L1/L2, then trigger reload
 *
 * The export endpoint takes a JSON list of plugin ids — the server resolves
 * each one against the current PluginRegistry snapshot (so we know its
 * srcDir on disk) and hands the result to `exportPack()`. The client then
 * downloads the produced file via a follow-up GET (or `path` is returned for
 * the local-host case where the UI runs alongside the daemon). Streaming the
 * binary back over POST is reserved for a follow-up.
 *
 * inspect/install use a path on disk for now. multipart upload is reserved
 * for a follow-up — the dropzone in `interface/` will land in D6 (4/4) and
 * can write to a tmp path before calling /inspect.
 */
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { exportPack } from '../packs/exporter';
import { inspectPack, installPack } from '../packs/importer';
import { readInstalled, readTrust } from '../packs/ledger';
import { getPluginSnapshot, reloadPlugins } from '../plugins/registry';

interface ExportBody {
  pluginIds: string[];
  type: 'single' | 'bundle';
  outPath: string;
  bundleMeta?: {
    id?: string;
    version?: string;
    title?: { zh?: string; en?: string };
    description?: { zh?: string; en?: string };
    primary?: string;
    requires?: { forgeax?: string; models?: string[]; vendors?: string[] };
    author?: { name: string; email?: string; url?: string; publicKey?: string };
  };
}

interface InspectBody {
  path: string;
}

interface InstallBody {
  path: string;
  destRoot: string;
  destLayer: 'L1' | 'L2';
  conflictPolicy?: 'skip' | 'overwrite' | 'rename';
  reload?: boolean;
  userAcknowledgedUnsigned?: boolean;
}

export function createPacksRouter(): Hono {
  const r = new Hono();

  r.post('/export', async (c) => {
    const body = (await c.req.json().catch(() => null)) as ExportBody | null;
    if (!body || !Array.isArray(body.pluginIds) || !body.pluginIds.length || !body.outPath || !body.type) {
      return c.json(
        { ok: false, error: 'expected { pluginIds[], type, outPath, bundleMeta? }', code: 'bad_request' },
        400,
      );
    }
    const snap = getPluginSnapshot();
    const plugins: Array<{ id: string; srcDir: string }> = [];
    for (const id of body.pluginIds) {
      const m = snap.manifests.find((x) => x.manifest.id === id);
      if (!m) {
        return c.json({ ok: false, error: `plugin not found in snapshot: ${id}`, code: 'not_found' }, 404);
      }
      // originPath is the manifest path; the plugin dir is its parent.
      const srcDir = resolve(m.originPath, '..');
      plugins.push({ id, srcDir });
    }

    const meta = body.bundleMeta ?? {};
    const result = await exportPack({
      type: body.type,
      plugins,
      outPath: body.outPath,
      bundleMeta: {
        id: meta.id ?? (body.type === 'single' ? body.pluginIds[0] : 'bundle'),
        version: meta.version ?? '0.1.0',
        title: meta.title ?? { en: meta.id ?? body.pluginIds.join(', ') },
        description: meta.description,
        primary: meta.primary,
        requires: meta.requires,
        author: meta.author,
      },
    });
    return c.json(result, result.ok ? 200 : 400);
  });

  r.post('/inspect', async (c) => {
    const body = (await c.req.json().catch(() => null)) as InspectBody | null;
    if (!body?.path) {
      return c.json({ ok: false, error: 'expected { path }', code: 'bad_request' }, 400);
    }
    const result = await inspectPack(body.path);
    return c.json(result, result.ok ? 200 : 400);
  });

  r.post('/install', async (c) => {
    const body = (await c.req.json().catch(() => null)) as InstallBody | null;
    if (!body?.path || !body.destRoot || !body.destLayer) {
      return c.json(
        { ok: false, error: 'expected { path, destRoot, destLayer, conflictPolicy?, reload? }', code: 'bad_request' },
        400,
      );
    }
    const result = await installPack({
      zipPath: body.path,
      destRoot: body.destRoot,
      destLayer: body.destLayer,
      conflictPolicy: body.conflictPolicy,
      userAcknowledgedUnsigned: body.userAcknowledgedUnsigned,
    });
    if (result.ok && body.reload !== false) {
      await reloadPlugins();
    }
    return c.json(result, result.ok ? 200 : 400);
  });

  /** 10 §plugins-trust.yaml + installed.yaml — read-only listings for the
   *  pack-management UI. The same data is also surfaced under
   *  `/api/plugins/installed` and `/api/plugins/trust` for callers that
   *  already use the plugins router; we mirror it here so anything reaching
   *  for `/api/packs/...` finds it. */
  r.get('/installed', (c) => {
    const root = c.req.query('root') ?? process.cwd();
    return c.json({ entries: readInstalled(root) });
  });

  r.get('/trust', (c) => {
    const root = c.req.query('root') ?? process.cwd();
    return c.json({ entries: readTrust(root) });
  });

  return r;
}
