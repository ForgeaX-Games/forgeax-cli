/** @desc GatewayServer — HTTP + WebSocket server for external program integration */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import { join, extname } from "node:path";
import { lookup as mimeType } from "mime-types";
import type { GatewayContext } from "../types.js";
import { WsHandler } from "./ws-handler.js";

import * as instRoutes from "./routes/instance.js";
import * as commandsRoutes from "./routes/commands.js";
import * as teamRoutes from "./routes/team.js";
import * as packRoutes from "./routes/pack.js";
import * as keyRoutes from "./routes/key.js";
import * as agentRoutes from "./routes/agent.js";
import * as sessionRoutes from "./routes/session.js";

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  token?: string;
}

export class GatewayServer {
  private ctx: GatewayContext | null = null;
  private server: Server | null = null;
  private ws: WsHandler | null = null;
  private readonly startTime = Date.now();
  private readonly host: string;
  private readonly port: number;
  private readonly token: string | undefined;
  private uiDistDir: string | null = null;

  constructor(opts?: GatewayServerOptions) {
    this.host = opts?.host ?? "127.0.0.1";
    this.port = opts?.port ?? 3700;
    this.token = opts?.token;
  }

  attach(ctx: GatewayContext): void {
    this.ctx = ctx;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.removeListener("error", reject);
        console.log(`[GatewayServer] listening on http://${this.host}:${this.port}`);
        resolve();
      });
    });

    this.ws = new WsHandler({
      server: this.server,
      ctx: this.ctx!,
      token: this.token,
    });
  }

  /** Delegate to WsHandler so newly added instances get their events broadcast. */
  subscribeInstance(instanceId: string): void {
    this.ws?.subscribeInstance(instanceId)
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  // ─── Router ───

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const ctx = this.ctx!;

    if (url === "/health" && method === "GET") {
      return this.handleHealth(res);
    }

    if (url.startsWith("/admin")) {
      return this.serveAdminUI(req, res);
    }

    if (!this.checkAuth(req, res)) return;

    const result = this.dispatch(ctx, req, res, url, method);

    if (result && typeof (result as any).catch === "function") {
      (result as Promise<void>).catch((e) => {
        if (!res.headersSent) {
          json(res, 500, { error: String(e) });
        }
      });
    }
  }

  private dispatch(
    ctx: GatewayContext,
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    method: string,
  ): void | Promise<void> {
    // --- Instance management ---
    if (url === "/api/instances" && method === "GET") return instRoutes.handleInstancesList(ctx, res);
    if (url === "/api/instances" && method === "POST") return instRoutes.handleInstanceAdd(ctx, req, res);

    const urlPath = url.split("?")[0];
    const instMatch = urlPath.match(/^\/api\/instances\/([^/]+)(?:\/(.+))?$/);
    if (instMatch) {
      const instId = decodeURIComponent(instMatch[1]);
      const action = instMatch[2];

      if (!action && method === "GET") return instRoutes.handleInstanceDetail(ctx, res, instId);
      if (action === "start" && method === "POST") return instRoutes.handleInstanceStart(ctx, res, instId);
      if (action === "stop" && method === "POST") return instRoutes.handleInstanceStop(ctx, res, instId);
      if (action === "restart" && method === "POST") return instRoutes.handleInstanceRestart(ctx, res, instId);
      if (action === "free" && method === "POST") return instRoutes.handleInstanceFree(ctx, res, instId);
      if (action === "shutdown" && method === "POST") return instRoutes.handleInstanceShutdown(ctx, res, instId);
      if (action === "sync" && method === "POST") return instRoutes.handleInstanceSync(ctx, res, instId);
      if (action === "interrupt" && method === "POST") {
        const qs = url.includes("?") ? new URLSearchParams(url.split("?")[1]) : undefined;
        return instRoutes.handleInstanceInterrupt(ctx, res, instId, qs);
      }
      if (action === "ports" && method === "GET") return instRoutes.handleInstancePorts(ctx, res, instId);
      if (action === "emit" && method === "POST") return agentRoutes.handleInstanceEmit(ctx, req, res, instId);

      // ── Multi-session API (P3+) ──
      // POST   /api/instances/:id/sessions              → create
      // GET    /api/instances/:id/sessions              → list
      // POST   /api/instances/:id/sessions/:sid/emit    → publish event
      // DELETE /api/instances/:id/sessions/:sid         → dispose
      if (action === "sessions" && method === "POST") return sessionRoutes.handleSessionCreate(ctx, req, res, instId);
      if (action === "sessions" && method === "GET")  return sessionRoutes.handleSessionList(ctx, res, instId);
      const sessionMatch = action?.match(/^sessions\/([^/]+)(?:\/(.+))?$/);
      if (sessionMatch) {
        const sid = decodeURIComponent(sessionMatch[1]);
        const sub = sessionMatch[2];
        if (sub === "emit" && method === "POST") return sessionRoutes.handleSessionEmit(ctx, req, res, instId, sid);
        if (!sub && method === "DELETE") return sessionRoutes.handleSessionDelete(ctx, req, res, instId, sid);
      }

      // ── Commands HTTP transport (replaces 9 separate agent-level routes) ──
      // GET  /api/instances/:id/commands?agent=X            → list
      // POST /api/instances/:id/commands/:name/query        → query
      // POST /api/instances/:id/commands/:name/execute      → execute
      if (action === "commands" && method === "GET") return commandsRoutes.handleCommandsList(ctx, req, res, instId);
      const cmdCallMatch = action?.match(/^commands\/([^/]+)\/(query|execute)$/);
      if (cmdCallMatch && method === "POST") {
        const [, cmdName, kind] = cmdCallMatch;
        return kind === "query"
          ? commandsRoutes.handleCommandQuery(ctx, req, res, instId, decodeURIComponent(cmdName))
          : commandsRoutes.handleCommandExecute(ctx, req, res, instId, decodeURIComponent(cmdName));
      }

      // ── NOTE ──
      // The 8 introspection routes that lived here (capabilities / skills /
      // templates / backups) have been removed. Clients (UI / gateway-ctl /
      // wechat / business) now go through the commands HTTP transport:
      //   POST /api/instances/:id/commands/fetch_{capabilities,skills,templates,backups,...}/query
      // See commands/introspect.ts.

      // NOTE: legacy `/sessions/:aid/events` endpoint removed. Session events
      // (full history) are now reached via the commands HTTP transport:
      //   POST /api/instances/:id/commands/fetch_session_events_jsonl/query
      //                                  body { args: { agentId } }
      // forgeax-server must update to this transport (independent cross-repo change).

      // team sub-routes
      if (action === "team" && method === "GET") return teamRoutes.handleTeamInfo(ctx, res, instId);
      if (action === "team/load" && method === "POST") return teamRoutes.handleTeamLoad(ctx, req, res, instId);
      if (action === "team/save" && method === "POST") return teamRoutes.handleTeamSave(ctx, req, res, instId);
      if (action === "team/restore" && method === "POST") return teamRoutes.handleTeamRestore(ctx, req, res, instId);
      if (action === "team/manifest" && method === "GET") return teamRoutes.handleTeamManifest(ctx, res, instId);
      if (action === "team/manifest" && method === "PUT") return teamRoutes.handleTeamManifestUpdate(ctx, req, res, instId);
      if (action === "team/update" && method === "POST") return teamRoutes.handleTeamUpdate(ctx, res, instId);
      if (action === "team/backup" && method === "DELETE") return teamRoutes.handleTeamDeleteBackup(ctx, req, res, instId);
      if (action === "team/containers" && method === "DELETE") return teamRoutes.handleTeamRemoveContainers(ctx, res, instId);
      if (action === "team/sync-preview" && method === "POST") return teamRoutes.handleTeamSyncPreview(ctx, res, instId);
      if (action === "team/sync" && method === "POST") return teamRoutes.handleTeamSyncExecute(ctx, req, res, instId);
    }

    // --- Packs ---
    if (url === "/api/packs" && method === "GET") return packRoutes.handlePacksList(ctx, res);
    if (url === "/api/packs/install" && method === "POST") return packRoutes.handlePacksInstall(ctx, req, res);
    if (url === "/api/packs/create" && method === "POST") return packRoutes.handlePacksCreate(ctx, req, res);
    if (url === "/api/packs/fork" && method === "POST") return packRoutes.handlePacksFork(ctx, req, res);
    const buildMatch = url.match(/^\/api\/packs\/([^/]+)\/build$/);
    if (buildMatch && method === "POST") return packRoutes.handlePacksBuild(ctx, req, res, buildMatch[1]);
    const packPullMatch = urlPath.match(/^\/api\/packs\/([^/]+)\/pull$/);
    if (packPullMatch && method === "POST") return packRoutes.handlePacksPull(ctx, res, decodeURIComponent(packPullMatch[1]));
    const packPushMatch = urlPath.match(/^\/api\/packs\/([^/]+)\/push$/);
    if (packPushMatch && method === "POST") return packRoutes.handlePacksPush(ctx, res, decodeURIComponent(packPushMatch[1]));
    const packCleanImageMatch = urlPath.match(/^\/api\/packs\/([^/]+)\/image$/);
    if (packCleanImageMatch && method === "DELETE") return packRoutes.handlePacksCleanImage(ctx, res, decodeURIComponent(packCleanImageMatch[1]));
    const packRemoveMatch = url.match(/^\/api\/packs\/([^/]+)$/);
    if (packRemoveMatch && method === "DELETE") return packRoutes.handlePacksRemove(ctx, res, decodeURIComponent(packRemoveMatch[1]));

    // --- Gateway control ---
    if (url === "/api/shutdown" && method === "POST") {
      return this.handleShutdown(res);
    }

    // --- Keys & Models ---
    const sd = ctx.stateDir;
    if (url === "/api/keys/llm" && method === "GET") return keyRoutes.handleKeysLlmList(sd, res);
    if (url === "/api/keys/llm" && method === "POST") return keyRoutes.handleKeysLlmAdd(sd, req, res);
    const llmTestMatch = urlPath.match(/^\/api\/keys\/llm\/([^/]+)\/test$/);
    if (llmTestMatch && method === "POST") return keyRoutes.handleKeysLlmTest(sd, res, decodeURIComponent(llmTestMatch[1]));
    const llmSectionMatch = urlPath.match(/^\/api\/keys\/llm\/([^/]+)$/);
    if (llmSectionMatch && method === "PUT") return keyRoutes.handleKeysLlmUpdate(sd, req, res, decodeURIComponent(llmSectionMatch[1]));
    if (llmSectionMatch && method === "DELETE") return keyRoutes.handleKeysLlmDelete(sd, res, decodeURIComponent(llmSectionMatch[1]));

    if (url === "/api/models" && method === "GET") return keyRoutes.handleModelsList(sd, res);
    const modelMatch = urlPath.match(/^\/api\/models\/([^/]+)$/);
    if (modelMatch && method === "PUT") return keyRoutes.handleModelsUpdate(sd, req, res, decodeURIComponent(modelMatch[1]));
    if (modelMatch && method === "DELETE") return keyRoutes.handleModelsDelete(sd, res, decodeURIComponent(modelMatch[1]));

    if (url === "/api/keys/tools" && method === "GET") return keyRoutes.handleKeysToolsList(sd, res);
    if (url === "/api/keys/tools" && method === "POST") return keyRoutes.handleKeysToolsAdd(sd, req, res);
    const toolKeyMatch = urlPath.match(/^\/api\/keys\/tools\/([^/]+)$/);
    if (toolKeyMatch && method === "PUT") return keyRoutes.handleKeysToolsUpdate(sd, req, res, decodeURIComponent(toolKeyMatch[1]));
    if (toolKeyMatch && method === "DELETE") return keyRoutes.handleKeysToolsDelete(sd, res, decodeURIComponent(toolKeyMatch[1]));

    json(res, 404, { error: "Not found" });
  }

  // ─── Health ───

  private handleHealth(res: ServerResponse): void {
    const ctx = this.ctx!;
    json(res, 200, {
      status: "running",
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      instances: ctx.listInstances(),
    });
  }

  // ─── Gateway control ───

  private handleShutdown(res: ServerResponse): void {
    json(res, 200, { shutdown: true });
    setTimeout(() => this.ctx!.shutdownGateway(), 100);
  }

  // ─── Admin UI static file serving ───

  private serveAdminUI(_req: IncomingMessage, res: ServerResponse): void {
    if (!this.uiDistDir) {
      this.uiDistDir = join(process.cwd(), "ui", "dist");
    }
    const uiDistDir = this.uiDistDir;

    if (!existsSync(uiDistDir)) {
      json(res, 404, { error: "Admin UI not built. Run `npm run build` in ui/" });
      return;
    }

    const urlPath = (_req.url ?? "/admin").split("?")[0];
    let filePath = urlPath.replace(/^\/admin\/?/, "");
    if (!filePath) filePath = "index.html";

    const fullPath = join(uiDistDir, filePath);

    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      const indexPath = join(uiDistDir, "index.html");
      if (!existsSync(indexPath)) {
        json(res, 404, { error: "index.html not found" });
        return;
      }
      const contentType = "text/html";
      res.writeHead(200, { "Content-Type": contentType });
      createReadStream(indexPath).pipe(res);
      return;
    }

    const ext = extname(fullPath);
    const contentType = mimeType(ext) || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    createReadStream(fullPath).pipe(res);
  }

  // ─── Auth ───

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.token) return true;
    const header = req.headers.authorization;
    if (header === `Bearer ${this.token}`) return true;
    json(res, 401, { error: "Unauthorized" });
    return false;
  }
}

// ─── Helpers ───

export function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}
