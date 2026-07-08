/** Orchestration seams — the injection registry the product shell uses to feed
 *  business-specific behavior into the (business-agnostic) orchestration layer.
 *
 *  Stage A (forgeax-cli-stage-a-decouple): cli stops hard-coding game business.
 *  The shell (packages/server) builds these and injects them at boot via
 *  `createForgeaxApp(ctx)`; the orchestration hot-path reads them through the
 *  getters below. We reuse the existing init/get boot-singleton idiom
 *  (cf. initPathManager/getPathManager, initSessionManager) rather than threading
 *  a new mutable context — so these are "boot contracts at the same level as the
 *  path manager", not a freshly-introduced implicit global (守 §4 Pipeline
 *  Isolation: written once at createForgeaxApp boot, read-only on the hot path).
 *
 *  Every seam is OPTIONAL at the type level so a standalone, game-agnostic cli
 *  keeps booting with zero injection. The ONE exception is asset path policy:
 *  when a shell injects asset-serving routers it MUST also inject the policy, or
 *  boot throws (§3.4 — a security whitelist must fail loud, never silently open
 *  or silently break). That conditional check lives at the app.ts mount site,
 *  not here. */

/** Single injected composer for the system-prompt building blocks. Replaces a
 *  loose `Array<contributor>` deliberately (§3.2): the composer OWNS the content
 *  of each piece so the four consumers (compose-turn-request, the claude-code
 *  spawn kernel, and the native-agent game_charter / environment slots) can never
 *  drift from one SSOT. Granular methods (rather than one concatenated string)
 *  because the native-agent slots inject `charter` and `environment` as SEPARATE
 *  prompt slots, while compose-turn-request concatenates all three.
 *
 *  Cache contract: `charter()` is the byte-STABLE prefix (depends only on ports,
 *  fixed at composer construction) — same bytes every turn, so it anchors the
 *  prompt cache. `environment()` / `activeGameNote()` are the per-scope DYNAMIC
 *  parts. Each consumer keeps the historical order (charter, environment, note),
 *  so the assembled bytes are identical to the pre-seam build. */
export interface SystemPromptComposer {
  /** The game-authoring charter. Byte-stable across turns (cache prefix). */
  charter(): string;
  /** The active-game scoping note for a slug ('' when no active game). */
  activeGameNote(slug: string | undefined): string;
  /** The `# Environment` section (paths / game info / workbench plugins /
   *  skills). Mirrors the historical renderEnvironmentText opts so each caller
   *  passes exactly what it always did (byte-identical). */
  environment(opts: { cwd: string; projectRoot?: string; slug?: string | null }): string;
}

/** 宿主侧工具执行上下文(seam run 的显式输入,Pipeline Isolation)。`perception` 是
 *  编排层通用感知往返(EventBus→WS→UI→回灌)的绑定句柄——机制业务无关,shell 注入的
 *  工具(query_world/capture_frame)用它向浏览器里的真值源取数;UI 未连时 fail-soft
 *  返回 `{ unavailable }`。 */
export interface HostToolRunCtx {
  sid?: string;
  agentId: string;
  projectRoot: string;
  /** 会话绑定的业务作用域 slug(studio 语境 = game)。 */
  game?: string;
  perception?: (kind: 'world' | 'frame', query?: unknown) => Promise<unknown>;
}

/** A host-only tool spec the shell exposes to agents (list_games / query_world /
 *  capture_frame …). Structurally a neutral ToolSpec — the orchestration layer
 *  broadcasts it into the prompt/allowedTools and the host-tool bridge gates the
 *  actual call. Shape matches `TurnRequest['tools'][number]` without importing it
 *  here (keep this module dependency-light). */
export interface HostToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  /** 宿主侧执行体(forgeax-core 原生路径:两个 host 工具执行口在信任闸放行后调用)。
   *  缺省 = 仅声明,执行回落 agent kit 注册表(历史行为)。注意:spec 出墙给内核时
   *  只序列化 name/description/inputSchema,`run` 永不过 wire。 */
  run?: (args: Record<string, unknown>, ctx: HostToolRunCtx) => Promise<unknown> | unknown;
}

/** UI 语义操作层的 headless 等价 handler(方案 §5 surface:'both'|'server'):UI 不在线
 *  时 `ui_invoke` 回落到这里。返回值应为 ActionResult 形({status, reason?, stateDigest?})。
 *  硬约束:handler 必须调与 UI run() 相同的内部实现/HTTP API(server 是行为 SSOT),
 *  不许长出第二份业务逻辑。 */
export interface HostUiActionHandler {
  actionId: string;
  run: (args: Record<string, unknown>, ctx: HostToolRunCtx) => Promise<unknown> | unknown;
}

/** Asset path policy — replaces the `.forgeax/games` whitelist baked into
 *  safe-path / fs-browser. Default is CLOSED; the shell explicitly opens roots.
 *  Conditional-required + fail-fast: see app.ts mount site (§3.4). */
export interface AssetPathPolicy {
  /** Absolute roots under which asset reads/writes are permitted. */
  allowRoots: string[];
  /** Optional deny globs applied within the allowed roots. */
  denyGlobs?: string[];
}

/** marketplace UI asset-cleanup capability — injected by the product shell
 *  (server) so the orchestration layer does NOT depend on marketplace. Structural
 *  type (no marketplace import); when absent the cleanup step gracefully skips
 *  (uses the original image). Lives here (cli seam type) because ProductContext
 *  references it while the ce-api-shim business that USES it lives in the shell. */
export interface UiAssetCanvasReport {
  opaqueEdgePixels: number;
  transparentCornerDirtyPixels: number;
  fragmentationRatio: number;
  largestComponentRatio: number;
  opaqueBoundsFillRatio: number;
}
export interface UiAssetCleanup {
  normalizeStandaloneUiAsset(
    dataUrl: string,
    options?: { mode?: 'icon' | 'chrome'; fillRatio?: number; chromeEdgeRefine?: 'dark-ui' | undefined; pixelPerfect?: boolean },
  ): Promise<string>;
  inspectUiAssetCanvas(dataUrl: string): Promise<UiAssetCanvasReport>;
}

interface OrchestrationSeams {
  systemPromptComposer?: SystemPromptComposer;
  hostTools?: HostToolSpec[];
  hostUiActions?: HostUiActionHandler[];
  assetPathPolicy?: AssetPathPolicy;
}

let _seams: OrchestrationSeams = {};

/** Install the injected seams. Called once by createForgeaxApp at boot. */
export function initOrchestrationSeams(seams: OrchestrationSeams): void {
  _seams = seams;
}

/** The injected system-prompt composer, or undefined when no shell injected one
 *  (standalone cli → caller falls back to its built-in generic prompt). */
export function getSystemPromptComposer(): SystemPromptComposer | undefined {
  return _seams.systemPromptComposer;
}

/** Host-only tool specs the shell injected (empty array when none). */
export function getHostTools(): HostToolSpec[] {
  return _seams.hostTools ?? [];
}

/** 按名取 shell 注入的 host 工具(执行口用;undefined = 非 seam 工具)。 */
export function getHostTool(name: string): HostToolSpec | undefined {
  return _seams.hostTools?.find((t) => t.name === name);
}

/** 按 actionId 取 shell 注入的 headless UI action handler(ui_invoke 回落用)。 */
export function getHostUiAction(actionId: string): HostUiActionHandler | undefined {
  return _seams.hostUiActions?.find((h) => h.actionId === actionId);
}

/** The injected asset path policy, or undefined when none was injected. */
export function getAssetPathPolicy(): AssetPathPolicy | undefined {
  return _seams.assetPathPolicy;
}

/** Test-only — reset the registry between cases. */
export function resetOrchestrationSeams(): void {
  _seams = {};
}
