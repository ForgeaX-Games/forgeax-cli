/**
 * Phase B3 — /api/plugins router.
 *
 * Surfaces the new ManifestScanner+Merger+KindLoader pipeline. The legacy
 * `/api/bus/plugins` endpoint (api/bus.ts) stays for now and is consumed by
 * Sidebar/WorkbenchPluginHost; B4 retires it.
 *
 *   GET  /api/plugins/manifests   → full snapshot incl. kinds + issues
 *   POST /api/plugins/reload      → re-scan disk, return fresh snapshot
 */
import { Hono } from 'hono';
import { getPluginSnapshot, reloadPlugins } from '../plugins/registry';
import { forkPlugin } from '../plugins/fork';
import { readInstalled, readTrust, recordTrust, latestTrustFor } from '../packs/ledger';
import { recordAsSkill, distillRecordedSkill } from '../skills/record-as-skill';
import { complete as llmComplete } from '../lib/llm-gateway';
import { listPluginFiles, readPluginFile, writePluginFile } from '../plugins/files';

export function createPluginsRouter(): Hono {
  const router = new Hono();

  router.get('/manifests', (c) => {
    const snap = getPluginSnapshot();
    return c.json(serialize(snap));
  });

  router.post('/reload', async (c) => {
    const snap = await reloadPlugins();
    return c.json(serialize(snap));
  });

  /** D6 (2/4) — Fork an existing plugin to L1 or L2. */
  router.post('/fork', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      srcId?: string;
      newId?: string;
      destLayer?: 'L1' | 'L2';
      projectRoot?: string;
    } | null;
    if (!body?.srcId) {
      return c.json({ ok: false, code: 'bad_input', error: 'expected { srcId, newId?, destLayer?, projectRoot? }' }, 400);
    }
    const result = await forkPlugin({
      srcId: body.srcId,
      newId: body.newId,
      destLayer: body.destLayer,
      projectRoot: body.projectRoot,
    });
    if (result.ok) {
      // Refresh registry so the fork is immediately discoverable.
      await reloadPlugins();
    }
    return c.json(result, result.ok ? 200 : 400);
  });

  /** 10 §plugins-trust + installed ledger — read-only listing. */
  router.get('/installed', (c) => {
    const root = c.req.query('root') ?? process.cwd();
    return c.json({ entries: readInstalled(root) });
  });

  router.get('/trust', (c) => {
    const root = c.req.query('root') ?? process.cwd();
    const id = c.req.query('id');
    if (id) {
      return c.json({ latest: latestTrustFor(root, id) ?? null });
    }
    return c.json({ entries: readTrust(root) });
  });

  /** TrustPanel posts here after the user clicks Allow / Deny on the
   *  signature-or-permission dialog. The ack is append-only; UIs fold by id
   *  and pick the newest entry. */
  router.post('/trust', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          root?: string;
          id?: string;
          decision?: 'allow' | 'deny';
          signed?: boolean;
          publicKey?: string;
          reason?: string;
        }
      | null;
    if (!body?.id || (body.decision !== 'allow' && body.decision !== 'deny')) {
      return c.json({ ok: false, code: 'bad_input', error: 'expected { id, decision: "allow"|"deny", root?, signed?, publicKey?, reason? }' }, 400);
    }
    const root = body.root ?? process.cwd();
    const prev = latestTrustFor(root, body.id);
    recordTrust(root, {
      id: body.id,
      decision: body.decision,
      signed: !!body.signed,
      publicKey: body.publicKey,
      reason: body.reason,
      ts: new Date().toISOString(),
      supersedes: prev?.ts,
    });
    return c.json({ ok: true });
  });

  /** D6 — Record-as-skill (deterministic recorder + optional LLM distillation).
   *
   *  Body: { projectRoot?, pluginId, skillId, displayName, description?,
   *          recorded: [{ toolId, args }], requiresTools?,
   *          distill?: { model: string } }
   *
   *  Without `distill`: writes a new L2 plugin that re-plays the recorded
   *  calls verbatim (deterministic baseline).
   *  With `distill.model`: pipes the recording through `lib/llm-gateway`
   *  to enrich `description` + write a sidecar `skill.md`. LLM failure
   *  silently falls back to the deterministic path so the loop never
   *  fails on the polish step.
   */
  router.post('/record-skill', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          projectRoot?: string;
          pluginId?: string;
          skillId?: string;
          displayName?: { zh: string; en: string };
          description?: { zh: string; en: string };
          recorded?: Array<{ toolId: string; args?: unknown }>;
          requiresTools?: string[];
          distill?: { model?: string };
        }
      | null;
    if (!body?.pluginId || !body.skillId || !body.displayName || !Array.isArray(body.recorded)) {
      return c.json(
        {
          ok: false,
          code: 'bad_input',
          error: 'expected { pluginId, skillId, displayName:{zh,en}, recorded:[{toolId,args}], description?, requiresTools?, projectRoot?, distill? }',
        },
        400,
      );
    }
    const baseInput = {
      projectRoot: body.projectRoot ?? process.cwd(),
      pluginId: body.pluginId,
      skillId: body.skillId,
      displayName: body.displayName,
      description: body.description,
      recorded: body.recorded.map((r) => ({ toolId: r.toolId, args: r.args })),
      requiresTools: body.requiresTools,
    };
    const result = body.distill?.model
      ? await distillRecordedSkill({ ...baseInput, model: body.distill.model }, llmComplete)
      : recordAsSkill(baseInput);
    if (result.ok) {
      // Refresh registry so the freshly-recorded skill is callable immediately.
      await reloadPlugins();
      return c.json(result);
    }
    return c.json(result, result.code === 'bad_input' ? 400 : 409);
  });

  /** Doc 09 §2.1 — wb-plugin-author backend. List / read / write files
   *  inside an L2 plugin directory. Path-jail + extension whitelist + size
   *  cap live in plugins/files.ts. */
  router.get('/files', (c) => {
    const root = c.req.query('root') ?? process.cwd();
    const slug = c.req.query('slug') ?? '';
    const path = c.req.query('path');
    if (path) {
      const r = readPluginFile(root, slug, path);
      return c.json(r, r.ok ? 200 : codeToHttp(r.code));
    }
    const r = listPluginFiles(root, slug);
    return c.json(r, r.ok ? 200 : codeToHttp(r.code));
  });

  router.put('/files', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { root?: string; slug?: string; path?: string; content?: string }
      | null;
    if (!body?.slug || !body.path || typeof body.content !== 'string') {
      return c.json(
        { ok: false, code: 'bad_input', error: 'expected { slug, path, content, root? }' },
        400,
      );
    }
    const r = writePluginFile(body.root ?? process.cwd(), body.slug, body.path, body.content);
    if (r.ok) {
      // Manifest edits should be visible immediately. Reload in the
      // background — we don't await it so the editor stays responsive.
      reloadPlugins().catch(() => { /* swallow; UI can hit /reload */ });
      return c.json(r);
    }
    return c.json(r, codeToHttp(r.code));
  });

  return router;
}

function codeToHttp(code: string): 400 | 403 | 404 | 409 | 413 | 500 {
  switch (code) {
    case 'bad_slug':
    case 'bad_input':
    case 'bad_ext': return 400;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'exists': return 409;
    case 'too_large': return 413;
    default: return 500;
  }
}

function serialize(snap: ReturnType<typeof getPluginSnapshot>) {
  return {
    generation: snap.generation,
    loadedAt: snap.loadedAt,
    counts: {
      manifests: snap.manifests.length,
      workbench: snap.kinds.workbench.length,
      agents: snap.kinds.agents.length,
      skills: snap.kinds.skills.length,
      cliProviders: snap.kinds.cliProviders.length,
      modelBindings: snap.kinds.modelBindings.length,
      tools: snap.kinds.tools.length,
    },
    manifests: snap.manifests.map((m) => ({
      id: m.manifest.id,
      version: m.manifest.version,
      kind: m.manifest.kind,
      layer: m.layer,
      originPath: m.originPath,
      shadowedBy: m.shadowedBy,
      displayName: m.manifest.displayName,
      description: m.manifest.description,
      icon: m.manifest.icon,
      experimental: m.manifest.experimental,
    })),
    workbench: snap.kinds.workbench,
    agents: snap.kinds.agents.map((a) => ({
      pluginId: a.pluginId,
      layer: a.layer,
      personaPath: a.personaPath,
      definition: a.definition,
    })),
    skills: snap.kinds.skills.map((s) => ({
      pluginId: s.pluginId,
      layer: s.layer,
      id: s.definition.id,
      triggers: s.definition.triggers,
      entry: s.definition.entry,
    })),
    issues: [
      ...snap.scanErrors.map((e) => ({ phase: 'scan' as const, ...e })),
      ...snap.mergeIssues.map((i) => ({ phase: 'merge' as const, ...i })),
      ...snap.kinds.issues.map((i) => ({ phase: 'kind' as const, ...i })),
    ],
  };
}
