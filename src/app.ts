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

import { createFilesRouter } from '@forgeax/platform-io';
import { createProjectsRouter } from '@forgeax/platform-io';
import { createFsBrowserRouter } from '@forgeax/platform-io';
import { createWorkspacesRouter } from './api/workspaces';
import { createSettingsRouter } from './api/settings';
import { createMemorySettingsRouter } from './api/memory-settings';
import { createBootSplashRouter } from '@forgeax/platform-io';
import { createVersionRouter } from '@forgeax/platform-io';
import { createChangelogRouter } from '@forgeax/platform-io';
import { createSessionsRouter } from './api/sessions';
import { createLogsRouter } from '@forgeax/platform-io';
import { createCommandsApiRouter } from './api/commands';
import { createCliRouter } from './api/cli/chat';
import { createBrandRouter, loadBrand } from './brand';
import { createBusRouter } from './api/bus';
import { createExtensionsRouter } from './api/extensions';
import { reloadExtensions, onExtensionsReloaded } from './extensions/registry';
import { syncEventTriggerBindings } from './skills/event-bridge';
import { createThreadsRouter } from './api/threads';
import { createLlmTestRouter } from './api/llm-test';
import { createUsageRouter } from './api/usage';
import { createToolsRouter } from './api/tools';
import { createEventsRouter } from './api/events';
import { createSkillsRouter } from './api/skills';
import { createPacksRouter } from './api/packs';
import { createRuntimeRouter } from './api/runtime';
import { createObservatoryRouter } from './api/observatory';
import { createGameAssetsRouter } from '@forgeax/platform-io';
import { createPrefsRouter } from '@forgeax/platform-io';
import { sessionScope } from './api/lib/session-scope';
import { bootCliProviders } from './cli-providers';
import { initPathManager } from './fs/path-manager';
import type { SessionLayout } from './fs/session-layout';
import {
  initOrchestrationSeams,
  type SystemPromptComposer,
  type HostToolSpec,
  type HostUiActionHandler,
  type AssetPathPolicy,
} from './orchestration-seams';
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
  /** How session state trees land + how sessions are enumerated, as a **factory**
   *  keyed by project root. Injected by the product shell (studio = game-nested
   *  `.forgeax/games/<slug>/sessions/<sid>`). A factory (not a single instance) so
   *  a workspace/project-root switch can rebuild the layout for the new root —
   *  re-initing the PathManager with a bare projectRoot would otherwise drop the
   *  layout back to the flat default and hide game-nested sessions. Omitted ⇒
   *  generic flat layout (`<userRoot>/sessions/<sid>`), i.e. forgeax-cli runs
   *  game-agnostic as a standalone CLI. */
  sessionLayoutFactory?: (projectRoot: string) => SessionLayout;
  /** Movable runtime-state root (cache / checkpoints / SM debug.log), as a
   *  **factory** keyed by project root — same shape and reason as
   *  `sessionLayoutFactory`: a workspace/project-root switch must rebuild it
   *  for the new root; a boot-time string would stay pinned to the old
   *  project. (The SessionManager debug.log stream still binds its path at
   *  boot — it re-points on process restart, not on switch.) Omitted ⇒ state
   *  stays under the user root (`~/.forgeax`), i.e. standalone-CLI behavior.
   *  Keys / kits / settings never follow this root. */
  stateRootFactory?: (projectRoot: string) => string;
  /** Business routers injected by the shell, mounted after the static cli routers
   *  (order/path unchanged for the static set). Replaces the per-feature static
   *  mounts as business migrates out of cli (Stage A §3). Each entry mounts at
   *  its `path`; `needsAssetPolicy` marks asset-serving routers that REQUIRE
   *  `assetPathPolicy` (boot throws if missing — §3.4 fail-fast). */
  routers?: Array<{ path: string; router: Hono; needsAssetPolicy?: boolean }>;
  /** System-prompt charter composer (charter + environment + note, fixed order,
   *  typed stable/dynamic split for prompt-cache). Omitted ⇒ cli uses its
   *  generic built-in prompt. (Stage A §3.2) */
  systemPromptComposer?: SystemPromptComposer;
  /** Host-only tool specs (list_games / query_world / capture_frame …) exposed
   *  to agents and gated by the host-tool bridge. (Stage A §3, §2.4) */
  hostTools?: HostToolSpec[];
  /** UI 语义操作层的 headless 等价 handler(surface:'both'|'server' 的 action,UI
   *  不在线时 ui_invoke 回落到这里执行;server 是行为 SSOT,方案 §5)。 */
  hostUiActions?: HostUiActionHandler[];
  /** Asset path policy replacing the `.forgeax/games` whitelist. Default CLOSED;
   *  the shell opens roots explicitly. Conditionally required + fail-fast when
   *  asset routers are injected (§3.4). */
  assetPathPolicy?: AssetPathPolicy;
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

  const pm = initPathManager({
    projectRoot,
    stateRoot: ctx.stateRootFactory?.(projectRoot),
    layout: ctx.sessionLayoutFactory?.(projectRoot),
  });
  // Install shell-injected orchestration seams once at boot (same idiom as the
  // path/session managers above). Read-only on the hot path thereafter.
  initOrchestrationSeams({
    systemPromptComposer: ctx.systemPromptComposer,
    hostTools: ctx.hostTools,
    hostUiActions: ctx.hostUiActions,
    assetPathPolicy: ctx.assetPathPolicy,
  });
  await ensureUserDirDefaults(pm);
  const sm = initSessionManager(pm);
  const restored = await sm.bootAutoStart();
  for (const s of restored) s.scheduler.start();

  // 组合根接线:把 skill 事件触发的 rewire 接到 plugins reload 后置钩子。
  // (registry 不直接 import event-bridge —— 断开 plugins→event-bridge→runner→plugins 环)
  onExtensionsReloaded(syncEventTriggerBindings);
  await reloadExtensions();
  await bootCliProviders();

  const app = new Hono();

  // 给每个 /api/* 请求建立 ALS session 作用域(从 query/path/JSON body 解析 sid),
  // 让 handler(含 streamSSE 流体)里的 console.* 经 logger bridge 落对应 session
  // 的 <sid>/logs/debug.log —— turn-trace 等诊断日志据此持久化到正确位置。
  app.use('/api/*', sessionScope());

  app.route('/api/files', createFilesRouter());
  app.route('/api/games', createGameAssetsRouter());
  app.route('/api/projects', createProjectsRouter());
  app.route('/api/fs', createFsBrowserRouter());
  app.route('/api/workspaces', createWorkspacesRouter({
    broadcast: ctx.broadcast,
    rebindWatcher: ctx.rebindWatcher,
    // Rebuild the session layout for the switched-to root so /api/sessions keeps
    // enumerating game-nested sessions after a workspace change (else it drops to
    // the flat default layout and the UI sees an empty list → loses history).
    sessionLayoutFactory: ctx.sessionLayoutFactory,
    // Same factory the boot init used — a workspace switch must re-derive the
    // movable state root for the new root (terminal cache & checkpoint stores
    // resolve lazily via getPathManager()).
    stateRootFactory: ctx.stateRootFactory,
  }));
  app.route('/api/settings', createSettingsRouter());
  app.route('/api/memory-settings', createMemorySettingsRouter());
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
  app.route('/api/extensions', createExtensionsRouter());
  app.route('/api/threads', createThreadsRouter());
  app.route('/api/llm', createLlmTestRouter());
  app.route('/api/usage', createUsageRouter());
  app.route('/api/tools', createToolsRouter());
  app.route('/api/events', createEventsRouter());
  app.route('/api/skills', createSkillsRouter());
  app.route('/api/packs', createPacksRouter());
  app.route('/api/runtime', createRuntimeRouter());
  app.route('/api/observatory', createObservatoryRouter());

  // Shell-injected business routers (mounted after the static cli set). As
  // business migrates out of cli (§3) the static mounts above shrink and these
  // grow — the product's overall route table stays identical. §3.4 fail-fast:
  // an asset-serving router that forgot its policy must crash boot, not run open.
  for (const r of ctx.routers ?? []) {
    if (r.needsAssetPolicy && !ctx.assetPathPolicy) {
      throw new Error(
        `createForgeaxApp: injected router "${r.path}" needs assetPathPolicy but none was provided ` +
          `(asset path whitelist must be explicit — refusing to boot open). See Stage A §3.4.`,
      );
    }
    app.route(r.path, r.router);
  }

  return { app };
}
