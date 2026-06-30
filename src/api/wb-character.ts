/**
 * /api/wb/character —— ForgeaX 角色编辑器统一 API(编排层薄代理)。
 *
 * 2026-06 解耦后:character 业务 SSOT 已迁入 `packages/marketplace/plugins/
 * wb-character/server/character-forge/`,编排层不再持有任何 character 业务。
 * 本路由对「角色操作」一律**薄代理**到 ToolRegistry 的 `callTool('character:*')`
 * —— 与 AI 路径(host_tool_bridge → callTool)走同一份插件后端 + 同一账本事件,
 * 图像生成由 ToolRegistry 注入的 ctx.imageGen 提供。
 *
 * 仍由编排层直接处理的,只有**与 character 领域无关的通用 per-game 文件 IO**:
 *   - GET  /asset            按白名单读取 .forgeax/games/<slug>/<module>/... 字节
 *   - POST /upload-asset     把客户端产出的字节写进同一白名单子树
 *   - GET/POST /active-character  跨工作台「当前角色」指针(纯指针,非 character 业务)
 *
 * dual-modality:每次成功代理后 dispatchToSurface('wb-character.host','reload',…)
 * 通知 iframe panel 刷新视图(best-effort)。
 */

import { Hono } from 'hono';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Context } from 'hono';
import { callTool } from '../tools/registry';
import type { ToolCall } from '@forgeax/types';
import { dispatchToSurface } from './bus';
import {
  getActiveCharacter,
  setActiveCharacter,
  type ActiveCharacterRole,
} from './lib/active-character';

export interface CharacterRouterCtx {
  /** forgeax project root, absolute */
  projectRoot: string;
  /** env reader(保留以兼容产品壳注入;通用路由本身不再读 env) */
  env?: Record<string, string | undefined>;
}

// Surface id must match the React panel's registration id in
// packages/marketplace/plugins/wb-character-host/panel.tsx — 'wb-character.host'.
const SURFACE_ID = 'wb-character.host';

function notifySurface(action: string, payload: Record<string, unknown>): void {
  try {
    dispatchToSurface(SURFACE_ID, action, payload);
  } catch {
    // Surface not registered (panel still mounting / closed) — silently drop.
  }
}

const CALLER: ToolCall['caller'] = { kind: 'user' };

/** callTool 结果 → HTTP 响应。成功回 result;失败按 code 映射状态码。 */
function toolToResponse(c: Context, r: Awaited<ReturnType<typeof callTool>>): Response {
  if (r.ok) return c.json(r.result as Record<string, unknown>);
  const status = r.code === 'not_found' ? 404
    : r.code === 'forbidden' ? 403
    : r.code === 'no_handler' ? 501
    : 500;
  return c.json({ error: r.code, message: r.error }, status as 400);
}

export function createCharacterRouter(ctx: CharacterRouterCtx): Hono {
  const r = new Hono();

  // ── 角色操作:薄代理到插件 ToolRegistry ───────────────────────────────
  r.post('/portrait', async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const res = await callTool({ toolId: 'character:generate-portrait', args: body, caller: CALLER });
    if (res.ok) notifySurface('reload', { slug: body.slug, kind: 'portrait' });
    return toolToResponse(c, res);
  });

  r.post('/sprite-sheet', async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const res = await callTool({ toolId: 'character:generate-sprite-sheet', args: body, caller: CALLER });
    if (res.ok) notifySurface('reload', { slug: body.slug, kind: 'sprite-sheet' });
    return toolToResponse(c, res);
  });

  r.get('/characters', async (c) => {
    const res = await callTool({
      toolId: 'character:list',
      args: { slug: c.req.query('slug') ?? '' },
      caller: CALLER,
    });
    return toolToResponse(c, res);
  });

  r.get('/characters/:charId', async (c) => {
    const res = await callTool({
      toolId: 'character:get',
      args: { slug: c.req.query('slug') ?? '', charId: c.req.param('charId') },
      caller: CALLER,
    });
    return toolToResponse(c, res);
  });

  r.post('/characters/:charId/rename', async (c) => {
    let body: { slug?: string; name?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const res = await callTool({
      toolId: 'character:rename',
      args: { slug: body.slug ?? '', charId: c.req.param('charId'), name: body.name ?? '' },
      caller: CALLER,
    });
    if (res.ok) notifySurface('reload', { charId: c.req.param('charId'), slug: body.slug, kind: 'rename' });
    return toolToResponse(c, res);
  });

  // /upsert-manifest —— 客户端管线产图 + /upload-asset 落盘后,登记/合并角色 manifest。
  // iframe(src/shared/GlobalState.ts)调此;代理到插件 character:upsert-manifest。
  r.post('/upsert-manifest', async (c) => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const res = await callTool({ toolId: 'character:upsert-manifest', args: body, caller: CALLER });
    if (res.ok) notifySurface('reload', { slug: body.slug, kind: 'manifest' });
    return toolToResponse(c, res);
  });

  // ── active-character pointer(通用跨工作台指针,非 character 业务)──────────
  r.get('/active-character', (c) => {
    const slug = c.req.query('slug') ?? '';
    const cur = getActiveCharacter(ctx.projectRoot, slug);
    return c.json(cur ?? { charId: null, role: null });
  });

  r.post('/active-character', async (c) => {
    let body: { slug?: string; charId?: string; role?: ActiveCharacterRole };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const slug = body.slug ?? '';
    const charId = body.charId ?? '';
    if (!slug || !charId) {
      return c.json({ error: 'missing-fields', message: 'slug, charId required' }, 400);
    }
    setActiveCharacter(ctx.projectRoot, slug, charId, body.role ?? 'hero');
    notifySurface('reload', { charId, slug, kind: 'active-character' });
    return c.json({ ok: true, charId, role: body.role ?? 'hero' });
  });

  // /asset —— raw byte stream for <img src> + AI fetch. Path must resolve under
  // <projectRoot>/.forgeax/games/<slug>/... (whitelist) so a confused caller
  // can't pull arbitrary files through us.
  r.get('/asset', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = safeAssetPath(ctx.projectRoot, rel);
    if (!abs) return c.json({ error: 'path outside character asset whitelist' }, 400);
    if (!existsSync(abs)) return c.json({ error: 'not-found' }, 404);
    const bytes = await readFile(abs);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': guessMime(abs), 'cache-control': 'no-cache' },
    });
  });

  // /upload-asset —— write client-generated bytes under the per-game asset whitelist.
  // Body: { slug, charId, rel, base64, mime?, module? }
  r.post('/upload-asset', async (c) => {
    let body: { slug?: string; charId?: string; rel?: string; base64?: string; mime?: string; module?: string };
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid-json' }, 400); }
    const slug = body.slug ?? '';
    const charId = body.charId ?? '';
    const rel = body.rel ?? '';
    const raw = body.base64 ?? '';
    const moduleSeg = body.module ?? 'characters';
    if (!slug || !charId || !rel || !raw) {
      return c.json({ error: 'missing-fields', message: 'slug, charId, rel, base64 required' }, 400);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(charId)) {
      return c.json({ error: 'invalid-slug-or-charid' }, 400);
    }
    if (!/^[a-z0-9-]{1,40}$/i.test(moduleSeg)) {
      return c.json({ error: 'invalid-module' }, 400);
    }
    if (rel.includes('\0') || rel.includes('..') || isAbsolute(rel)) {
      return c.json({ error: 'invalid-rel' }, 400);
    }
    const fullRel = `.forgeax/games/${slug}/${moduleSeg}/${charId}/${rel}`;
    const abs = safeAssetPath(ctx.projectRoot, fullRel);
    if (!abs) return c.json({ error: 'path outside asset whitelist' }, 400);
    const b64 = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
    let bytes: Buffer;
    try { bytes = Buffer.from(b64, 'base64'); }
    catch { return c.json({ error: 'invalid-base64' }, 400); }
    if (bytes.length === 0) return c.json({ error: 'empty-payload' }, 400);
    if (bytes.length > 32 * 1024 * 1024) return c.json({ error: 'payload-too-large' }, 413);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, bytes);
    } catch (e) {
      return c.json({ error: 'write-failed', message: (e as Error).message.slice(0, 500) }, 500);
    }
    notifySurface('reload', { charId, slug, kind: 'asset', rel, module: moduleSeg });
    return c.json({
      ok: true,
      path: friendly(abs, ctx.projectRoot),
      url: `/api/wb/character/asset?path=${encodeURIComponent(fullRel)}`,
      bytes: bytes.length,
    });
  });

  return r;
}

function friendly(abs: string, projectRoot: string): string {
  const r = relative(projectRoot, abs);
  return r.startsWith('..') ? abs : r;
}

function safeAssetPath(root: string, rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null;
  if (isAbsolute(rel)) return null;
  if (rel.includes('\0') || rel.includes('..')) return null;
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r.startsWith('..') || isAbsolute(r)) return null;
  const segs = r.split(/[/\\]/);
  // Whitelist: .forgeax/games/<slug>/<module>/... where <module> is a known
  // per-game asset root. Every workbench shares ONE validated write path.
  const ALLOWED_MODULES = new Set([
    'characters', 'skills', 'reel', 'narrative', 'lowpoly-characters', 'public', 'wb-scene',
  ]);
  if (segs[0] !== '.forgeax' || segs[1] !== 'games' || !ALLOWED_MODULES.has(segs[3])) return null;
  return abs;
}

function guessMime(p: string): string {
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
