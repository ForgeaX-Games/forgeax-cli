// forgeax-cli — app seam (Stage0 scaffold).
//
// Reusable orchestration layer entry. The product shell (e.g. packages/server)
// injects product-specific context (resource/data roots, ports, brand) and the
// orchestration layer wires up the Hono router + boot sequence.
//
// 现状(2026-06):`createForgeaxApp(ctx)` boot 编排核心(path / session manager /
// cli-providers / plugins / brand)并挂载全部 /api/* 路由。产品壳 packages/server/
// src/main.ts **已走这条 (a) 路径**:build ctx -> createForgeaxApp(ctx) -> Bun.serve,
// 自己只负责 Bun.serve + 静态 SPA + engine/interface 进程 spawn + vite 代理。

import { Hono } from 'hono';

import { createFilesRouter } from './api/files';
import { createAssetsRouter } from './api/assets';
import { createWorkbenchRouter } from './api/workbench';
import { createProjectsRouter } from './api/projects';
import { createFsBrowserRouter } from './api/fs-browser';
import { createWorkspacesRouter } from './api/workspaces';
import { createSettingsRouter } from './api/settings';
import { createBootSplashRouter } from './api/boot-splash';
import { createVersionRouter } from './api/version';
import { createChangelogRouter } from './api/changelog';
import { createSessionsRouter } from './api/sessions';
import { createLogsRouter } from './api/logs';
import { createCommandsApiRouter } from './api/commands';
import { createCliRouter } from './api/cli/chat';
import { createBrandRouter, loadBrand } from './brand';
import { createBusRouter } from './api/bus';
import { createPluginsRouter } from './api/plugins';
import { reloadPlugins, onPluginsReloaded } from './plugins/registry';
import { syncEventTriggerBindings } from './skills/event-bridge';
import { createThreadsRouter } from './api/threads';
import { createCharacterRouter } from './api/wb-character';
import { createBgmRouter } from './api/wb-bgm';
import { createLlmTestRouter } from './api/llm-test';
import { createUsageRouter } from './api/usage';
import { createToolsRouter } from './api/tools';
import { createEventsRouter } from './api/events';
import { createSkillsRouter } from './api/skills';
import { createPacksRouter } from './api/packs';
import { createRuntimeRouter } from './api/runtime';
import { createObservatoryRouter } from './api/observatory';
import { createCeApiShimRouter, type UiAssetCleanup } from './api/ce-api-shim';
import { createGameAssetsRouter } from './api/game-assets';
import { createPrefsRouter } from './api/prefs';
import { sessionScope } from './api/lib/session-scope';
import { bootCliProviders } from './cli-providers';
import { initPathManager } from './fs/path-manager';
import { ensureUserDirDefaults } from './defaults/scaffold';
import { initSessionManager } from './core/session-manager';
import './llm/register-all';

/** Product-specific context injected by the shell into the orchestration layer. */
export interface ProductContext {
  /** Where read-only resources live (builtin assets, interface dist, marketplace). */
  resourceRoot?: string;
  /** Where mutable user/project data lives (.forgeax/...). */
  projectRoot: string;
  /** Port assignments for the product processes. */
  ports?: {
    server?: number;
    engine?: number;
    interface?: number;
  };
  /** Studio-wide version string. */
  version?: string;
  /** Optional brand id override. */
  brand?: string;
  /** Broadcast a message to connected WS clients (provided by the shell's WsHub). */
  broadcast?: (msg: unknown) => void;
  /** Rebind the filesystem watcher to a new root (provided by the shell). */
  rebindWatcher?: (root: string) => void;
  /** UI 资产清洗能力(marketplace 后端),由产品壳注入 —— 编排层不直接依赖 marketplace。
   *  缺省 ⇒ /__ce-api__ 的资产清洗步骤跳过(用原图)。 */
  uiAssetCleanup?: UiAssetCleanup;
}

export interface ForgeaxApp {
  /** The mounted Hono application (caller wires it into Bun.serve). */
  app: Hono;
}

/**
 * Boot the orchestration core and mount every /api/* router onto a fresh Hono
 * app. The caller (product shell) owns Bun.serve, the WS handler, static SPA
 * serving, and engine/interface process spawning + vite proxying.
 *
 * Stage0: minimal seam. Boot side-effects (path manager, session manager,
 * cli-providers, plugins) run here; product-specific plumbing stays in the
 * shell. Stage1-B will fold the remaining boot/serve glue from main.ts in.
 */
export async function createForgeaxApp(ctx: ProductContext): Promise<ForgeaxApp> {
  const { projectRoot } = ctx;

  try {
    loadBrand();
  } catch {
    /* non-fatal at boot; settings UI can fix brand */
  }

  const pm = initPathManager({ projectRoot });
  await ensureUserDirDefaults(pm);
  const sm = initSessionManager(pm);
  const restored = await sm.bootAutoStart();
  for (const s of restored) s.scheduler.start();

  // 组合根接线:把 skill 事件触发的 rewire 接到 plugins reload 后置钩子。
  // (registry 不直接 import event-bridge —— 断开 plugins→event-bridge→runner→plugins 环)
  onPluginsReloaded(syncEventTriggerBindings);
  await reloadPlugins();
  await bootCliProviders();

  const app = new Hono();

  // 给每个 /api/* 请求建立 ALS session 作用域(从 query/path/JSON body 解析 sid),
  // 让 handler(含 streamSSE 流体)里的 console.* 经 logger bridge 落对应 session
  // 的 <sid>/logs/debug.log —— turn-trace 等诊断日志据此持久化到正确位置。
  app.use('/api/*', sessionScope());

  app.route('/api/files', createFilesRouter());
  app.route('/api/games', createGameAssetsRouter());
  app.route('/api/assets', createAssetsRouter());
  app.route('/api/workbench', createWorkbenchRouter());
  app.route('/api/projects', createProjectsRouter());
  app.route('/api/fs', createFsBrowserRouter());
  app.route('/api/workspaces', createWorkspacesRouter({
    broadcast: ctx.broadcast,
    rebindWatcher: ctx.rebindWatcher,
  }));
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/boot-splash', createBootSplashRouter());
  app.route('/api/version', createVersionRouter());
  app.route('/api/changelog', createChangelogRouter());
  app.route('/api/sessions', createSessionsRouter());
  app.route('/api/logs', createLogsRouter(projectRoot));
  app.route('/api/prefs', createPrefsRouter(projectRoot));
  app.route('/api/commands', createCommandsApiRouter());
  app.route('/api/cli', createCliRouter());
  app.route('/api/brand', createBrandRouter());
  app.route('/api/bus', createBusRouter());
  app.route('/api/plugins', createPluginsRouter());
  app.route('/api/threads', createThreadsRouter());
  app.route('/api/wb/character', createCharacterRouter({
    projectRoot,
    env: process.env as Record<string, string | undefined>,
  }));
  app.route('/api/llm', createLlmTestRouter());
  app.route('/api/usage', createUsageRouter());
  app.route('/api/tools', createToolsRouter());
  app.route('/api/events', createEventsRouter());
  app.route('/api/skills', createSkillsRouter());
  app.route('/api/packs', createPacksRouter());
  app.route('/api/runtime', createRuntimeRouter());
  app.route('/api/observatory', createObservatoryRouter());
  app.route('/api/wb/bgm', createBgmRouter());
  app.route('/__ce-api__', createCeApiShimRouter({
    projectRoot,
    env: process.env as Record<string, string | undefined>,
    uiAssetCleanup: ctx.uiAssetCleanup,
  }));

  return { app };
}
