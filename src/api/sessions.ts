/** /api/sessions —— 最小入口：list / create / open / close / post-message / abort。
 *
 *  Plumbing 验证用：让外部 (curl / UI) 能创建 session、激活 scheduler、往 EventBus
 *  发事件、整 session 或 per-agent 取消。Observe 走 ws.ts 上的 ?sid= 订阅。
 *
 *  寻址（对齐 agenteam ref `ctl-command/gateway-ctl/agent.ts::cmdChat`）：caller
 *  传 `to` 时 emit 走路由（path 或 fullId："root#1" 由 AgentTree 解回 path）；不传
 *  `to` 就是普通 emit —— EventBus 仅向 observers 广播，不入任何 queue。这与 ref 的
 *  `instance.emit(event)` 行为一致。
 *
 *  abort 寻址（对齐 ref `core/scheduler.interruptAgents`）：POST `/:sid/abort` 不带
 *  `agent` query → 整 session 所有 agent.stop()；带 `?agent=<path>` → 只 stop 那一个。
 *  Session 不持 abortController，cancel 一律走 scheduler 派给 per-agent。 */

import { Hono } from 'hono';
import { getSessionManager } from '../core/session-manager';
import type { Session } from '../core/session';
import type { Event } from '../core/types';
import { ensureAgentScaffold, isValidAgentName } from '../core/agent-scaffold';
import { resolvePersonaForAgent } from '../agents/loader';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getPathManager } from '../fs/path-manager';
import { resolveAsk } from '../core/ask-user-registry';
import { randomUUID } from 'node:crypto';
import { registerPermission, resolvePermission } from '../core/permission-registry';
import { registerPerception, resolvePerception, pushPerceptionNote } from './lib/perception-registry';
import { acquireUiLease, setUiManifest, uiInvokeTimeoutMs, resolveFirstClassUiTool } from './lib/ui-manifest-registry';
import { createSessionWithBootstrap } from './lib/session-create';
import { getHostTool } from '../orchestration-seams';
import type { PerceptionKind } from '../kernel/forgeax-builtin-tools';
import { executeTool } from '../kits/tool/tool-executor';
import { isForgeaxBuiltinTool, runForgeaxBuiltinTool, hostToolRunCtx } from '../kernel/forgeax-builtin-tools';
import { checkKernelTool } from '../kernel/trust-gate';
import { requestToolApproval, applyRememberOnReply } from '../kernel/tool-approval';
import { getCheckpointManager, type RewindMode } from '../checkpoint/checkpoint-manager';
import { loadAgentRecord } from '../soul';
import { appendToolAudit } from '../kernel/tool-audit';
import { consultTurnGate } from '../kernel/cc-profile';

function resolveAgentPath(session: Session, to: string): string {
  if (to.includes('#')) {
    const node = session.tree.getByFullId(to);
    if (!node) throw new Error(`agent fullId not found: ${to}`);
    return node.path;
  }
  if (!session.tree.get(to)) {
    throw new Error(`agent path not found: ${to}`);
  }
  return to;
}

export function createSessionsRouter() {
  const r = new Hono();

  r.get('/', (c) => {
    const sm = getSessionManager();
    // Scope the list to a single game (整个 session 面板按 game 收口). `?game=<slug>`
    // wins; absent → fall back to the active game so every surface (TopBar dropdown
    // / TabStrip) only ever shows the current game's sessions. The bound game slug
    // is the path-derived `defaultDir` carried on each list entry. No game resolvable
    // (generic / brand-new workspace with no active game) → return everything,
    // preserving the un-scoped behaviour.
    const game = c.req.query('game') || getPathManager().resolveScope() || null;
    const all = sm.list();
    const sessions = game ? all.filter((e) => e.defaultDir === game) : all;
    return c.json({ sessions });
  });

  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    // 「建 session + bootstrap 入口 agent」的实现抽在 lib/session-create.ts(SSOT):
    // headless 的 `session.create` UI action(ui-headless-actions)与本路由共用同一份。
    const out = await createSessionWithBootstrap(body);
    return c.json(out);
  });

  r.post('/:sid/open', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    session.scheduler.start();
    return c.json({ sid: session.sid });
  });

  r.post('/:sid/close', async (c) => {
    const sm = getSessionManager();
    await sm.close(c.req.param('sid'));
    return c.json({ ok: true });
  });

  // DELETE /:sid —— 关掉 + rm -rf session 目录（含 ledger / blobs / scaffold 全清）。
  // 跟 close 的区别：close 软释放（只解除 in-memory bindings，盘上不动），delete
  // 把这个 sid 整个从盘上抹掉，sm.delete 内部对 unknown sid 是 idempotent（不抛）。
  //
  // 路线对齐：session 容器 CRUD 走纯 REST（list/create/delete/close/abort），与
  // `/api/commands/*` 的 query/execute 模式互不重叠 —— 用户在 2026-05-20 钉死「session
  // 本体的控制不走 commands」之后，原 `builtin/commands/sessions.ts` 整个模块被删，
  // 只留下 agent 树 + 历史查询（list_agents / fetch_session_events / fetch_blob）在 commands。
  r.delete('/:sid', async (c) => {
    const sm = getSessionManager();
    const sid = c.req.param('sid');
    try {
      await sm.delete(sid);
      return c.json({ ok: true, sid });
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message ?? String(err) }, 500);
    }
  });

  // ─── File-activity ledger query (SSOT for "who touched what") ────────────
  // GET /:sid/file-activity?path=&agent=&limit=&since=
  // - path:  abs path filter (matches record.path or record.fromPath)
  // - agent: agentPath filter
  // - limit: 1..1000, default 50
  // - since: unix-ms lower bound
  // Returns newest-first array. Reads `<sid>/file-activity.jsonl` directly via
  // the ledger; no caching — caller should poll at most every 2s.
  r.get('/:sid/file-activity', (c) => {
    const sm = getSessionManager();
    const sid = c.req.param('sid');
    const session = sm.peek(sid);
    if (!session) return c.json({ error: `session not open: ${sid}` }, 404);
    const path = c.req.query('path') || undefined;
    const agent = c.req.query('agent') || undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;
    const since = c.req.query('since') ? Number(c.req.query('since')) : undefined;
    const records = session.fileActivity.query({
      ...(path ? { path } : {}),
      ...(agent ? { agent } : {}),
      ...(Number.isFinite(limit) ? { limit } : {}),
      ...(since != null && Number.isFinite(since) ? { sinceTs: since } : {}),
    });
    return c.json({ sid, records, mtime: session.fileActivity.mtimeMs() });
  });

  // GET /:sid/file-locks — current in-memory lock map. Snapshots `Map<absPath,
  // {agentPath, op, since}>` as plain object for UI rendering of 🔒 indicator.
  r.get('/:sid/file-locks', (c) => {
    const sm = getSessionManager();
    const sid = c.req.param('sid');
    const session = sm.peek(sid);
    if (!session) return c.json({ error: `session not open: ${sid}` }, 404);
    const locks: Record<string, { agentPath: string; op: string; since: number }> = {};
    for (const [path, snap] of session.fileLocks.entries()) {
      locks[path] = { agentPath: snap.agentPath, op: snap.op, since: snap.since };
    }
    return c.json({ sid, locks });
  });

  r.post('/:sid/abort', async (c) => {
    const sm = getSessionManager();
    const sid = c.req.param('sid');
    const agent = c.req.query('agent') || undefined;
    const session = sm.peek(sid);
    if (!session) return c.json({ error: `session not open: ${sid}` }, 404);
    if (agent && !session.tree.get(agent)) {
      return c.json({ error: `agent path not found: ${agent}` }, 404);
    }
    session.scheduler.interruptAgents(agent);
    return c.json({ ok: true, sid, agent: agent ?? null });
  });

  r.post('/:sid/messages', async (c) => {
    const sm = getSessionManager();
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const content = body.content;
    if (typeof content !== 'string' || !content) {
      return c.json({ error: 'content (string) required' }, 400);
    }
    // 写时迁移(plan B PR2-compat):这是 UI 的主发消息端点。若 sid 还是 pre-PR2 老 session
    // (home/扁平),先把整份目录迁进当前项目 games/<bound-slug>/sessions/<sid>/,确保老历史 +
    // 新记录都落项目下。幂等;已在项目内 / 非老 session → no-op。必须在 open 之前(迁移会先
    // close 再 move,open 随后从新位置 hydrate)。
    await sm.prepareForWrite(sid);
    const session = await sm.open(sid);
    session.scheduler.start();

    let target: string | undefined;
    if (typeof body.to === 'string' && body.to) {
      // Auto-scaffold persona sub-agent: when `to` is a single segment that
      // the tree doesn't yet have, treat it as a marketplace persona id and
      // try to scaffold `<sid>/agents/<id>/` with `personaFile` pre-filled.
      // Falls through to plain resolveAgentPath for nested paths or fullIds.
      const candidate = body.to as string;
      const isSimpleName =
        !candidate.includes('/') && !candidate.includes('#') && isValidAgentName(candidate);
      if (isSimpleName && !session.tree.get(candidate)) {
        try {
          const persona = await resolvePersonaForAgent(candidate);
          if (persona) {
            await ensureAgentScaffold(session.sid, candidate, {
              agentType: 'conscious',
              overrides: {
                personaFile: persona.personaPath,
                ...(persona.memoryDir ? { memoryDir: persona.memoryDir } : {}),
                ...(persona.tools && persona.tools.length > 0
                  ? { kits: { config: { 'host-tools': { allow: persona.tools } } } }
                  : {}),
              },
            });
            // Eagerly attach + start so the EventBus queue is registered
            // before we emit. Without this we'd race the FSWatcher → tree
            // → scheduler.attachAndStart pipeline and the first event
            // would route into a void.
            await session.scheduler.attachAgent(candidate);
            await session.scheduler.startAgent(candidate);
          } else {
            // 找不到 persona —— 既不在 plugin agent 列表，也不在 marketplace
            // manifest. 不静默吃掉错误：把消息当成「发去不存在的 sub-agent」
            // 显式 400 给前端，让 ChatPanel 渲染 system 红字而不是把消息塞进
            // root agent。这能避免「点击 mochi 头像但 forge 接管对话」的
            // 困惑（现象上是 #91 的另一面：persona 解析失败时旧路径会 fall-
            // through 到 resolveAgentPath，因为 simple-name 不会命中任何节
            // 点，最终 target 仍 undefined，事件不带 `to`，被当 root 兜底）。
            return c.json({
              error:
                `persona '${candidate}' 未找到 —— 不在 marketplace 或 plugin 列表里。` +
                `请确认 plugin 已安装、id 拼写正确，或换一个已知 agent。`,
              code: 'persona_not_found',
              candidate,
            }, 404);
          }
        } catch (err: any) {
          process.stderr.write(
            `[sessions] persona auto-scaffold for '${candidate}' failed: ${err?.message ?? err}\n`,
          );
          return c.json({
            error: `auto-scaffold 失败: ${err?.message ?? String(err)}`,
            code: 'scaffold_failed',
            candidate,
          }, 500);
        }
      }
      try {
        target = resolveAgentPath(session, candidate);
      } catch (err: any) {
        return c.json({ error: err?.message ?? String(err) }, 404);
      }
    }

    // Ensure the consuming agent is actually attached + scheduled BEFORE we
    // emit. `scheduler.start()` above is a no-op once `started` is true, and a
    // *restored* session's root agent may never have been attached: its dir
    // already existed on disk, so no tree "added" change fired to trigger
    // attachAndStart, and if the tree wasn't fully listed when start() first
    // ran the agent was skipped. The event would then route into a queue that
    // nobody consumes → the turn hangs forever at "正在思考". attachAgent /
    // startAgent are idempotent (attach early-returns when already present,
    // start re-runs harmlessly), so this is safe for already-running agents.
    const ensurePath = target ?? session.tree.list().find((n) => n.depth === 1)?.path;
    if (ensurePath) {
      try {
        await session.scheduler.attachAgent(ensurePath);
        await session.scheduler.startAgent(ensurePath);
      } catch (err: any) {
        process.stderr.write(
          `[sessions] ensure attach+start '${ensurePath}' for ${session.sid} failed: ${err?.message ?? err}\n`,
        );
      }
    }

    // ── root 兜底必须显式写进 `to` ──
    // EventBus.emit 只路由带 `to` 的事件(event-bus.ts route);不带 to 的事件只过
    // observers(headless log 记一笔),不进任何 agent 队列 → turn 永不启动、消息
    // 静默丢失。上面的 attach+start 只保证兜底 agent 的队列存在,不改变路由——
    // 所以「无 to → root 兜底」这个语义必须在这里落成 event.to,不能指望总线
    // (它保持 dumb,不做 type-based 路由)。树上一个 agent 都没有 → 409 fail-fast。
    target ??= ensurePath;
    if (!target) {
      return c.json(
        { error: 'session has no agents — message would be silently dropped', code: 'no_agent' },
        409,
      );
    }

    // ── checkpoint 回退点 ──
    // 仅 user_input:① 有挂起的软回退 → 先定格(此后 cancel 失效,UI 移除置灰段);
    // ② emit 前打消息锚点快照(失败不阻塞聊天)。msgId 是回退体系的稳定外键。
    const isUserInput = (body.type ?? 'user_input') === 'user_input';
    const msgId: string | undefined = isUserInput ? randomUUID() : undefined;
    if (isUserInput && msgId) {
      const cpm = getCheckpointManager();
      try { cpm.finalizePending(session); } catch (err: any) {
        process.stderr.write(`[checkpoint] finalizePending failed: ${err?.message ?? err}\n`);
      }
      try { cpm.snapshotForMessage(session, msgId); } catch (err: any) {
        process.stderr.write(`[checkpoint] snapshotForMessage failed: ${err?.message ?? err}\n`);
      }
    }

    const event: Event = {
      source: 'user',
      type: body.type ?? 'user_input',
      payload: { content, ...(msgId ? { msgId } : {}), ...(body.payload ?? {}) },
      to: target,
      handoff: body.handoff ?? 'turn',
      ts: Date.now(),
    };
    session.eventBus.emit(event);
    return c.json({ ok: true, to: target, msgId });
  });

  // ── checkpoint 回退点路由 ────────────────────────────────────────────────
  r.get('/:sid/checkpoints', async (c) => {
    const sm = getSessionManager();
    let session: Session;
    try {
      session = await sm.open(c.req.param('sid'));
    } catch {
      return c.json({ error: 'session not found' }, 404);
    }
    const cpm = getCheckpointManager();
    return c.json({ checkpoints: cpm.list(session), pending: cpm.pendingOf(session) });
  });

  r.post('/:sid/rewind/preview', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.msgId !== 'string') return c.json({ error: 'msgId required' }, 400);
    const result = getCheckpointManager().preview(session, body.msgId);
    if ('error' in result) return c.json({ error: result.error }, result.status as 404);
    return c.json(result);
  });

  r.post('/:sid/rewind', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.msgId !== 'string') return c.json({ error: 'msgId required' }, 400);
    const mode: RewindMode = body.mode === 'code' || body.mode === 'conversation' ? body.mode : 'both';
    const result = await getCheckpointManager().rewind(session, body.msgId, mode);
    if ('error' in result) return c.json({ error: result.error }, result.status as 404);
    return c.json(result);
  });

  r.post('/:sid/rewind/cancel', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.boundaryId !== 'string') return c.json({ error: 'boundaryId required' }, 400);
    const result = await getCheckpointManager().cancel(session, body.boundaryId);
    if ('error' in result) return c.json({ error: result.error }, result.status as 409);
    return c.json(result);
  });

  r.post('/:sid/rewind/overwrite-dirty', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.boundaryId !== 'string') return c.json({ error: 'boundaryId required' }, 400);
    const result = await getCheckpointManager().overwriteDirty(session, body.boundaryId);
    if ('error' in result) return c.json({ error: result.error }, result.status as 409);
    return c.json(result);
  });

  r.post('/:sid/rewind/undo-overwrite', async (c) => {
    const sm = getSessionManager();
    const session = await sm.open(c.req.param('sid'));
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.boundaryId !== 'string') return c.json({ error: 'boundaryId required' }, 400);
    const result = await getCheckpointManager().undoOverwrite(session, body.boundaryId);
    if ('error' in result) return c.json({ error: result.error }, result.status as 409);
    return c.json(result);
  });

  // POST /:sid/ask-reply —— 解开 `ask_user` 工具阻塞的 Promise。前端在用户选完
  // 选项后调用。键 = sid::agent(agent 默认串行,同一 agent 同刻至多一个 ask
  // pending,见 core/ask-user-registry.ts)。未命中(已超时/已答/键不对)返回
  // ok:false,前端忽略即可——不报错、不污染聊天历史、不触发新 turn。
  r.post('/:sid/ask-reply', async (c) => {
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : null;
    const values = Array.isArray(body.values)
      ? body.values.filter((v: unknown): v is string => typeof v === 'string')
      : null;
    if (!agent || !values) {
      return c.json({ error: 'agent (string) and values (string[]) required' }, 400);
    }
    const ok = resolveAsk(sid, agent, values);
    return c.json({ ok, ...(ok ? {} : { reason: 'no-pending' }) });
  });

  // POST /:sid/permission-request —— 命令审批闭环的「弹卡 + 阻塞」端。由 spawn 出来
  // 的 MCP permission-server.mjs(permission-prompt 工具)在 CLI 要权限时 HTTP 调
  // 进来。我们经 EventBus 弹一张 permission:request 卡到前端,注册一个阻塞 Promise,
  // **hold 住本 HTTP 响应**直到用户在 UI 点「允许/拒绝」(走 /permission-reply 解开)
  // 或超时(fail closed=deny)。响应 {allow} 回灌给 MCP → 命令据此执行或拦下。见
  // core/permission-registry.ts。
  const PERMISSION_TIMEOUT_MS = 10 * 60_000;
  // AskUserQuestion answer side-channel: the registry only carries the allow/deny
  // boolean. For AskUserQuestion the user picks an answer, not just allow —
  // /permission-reply stashes the chosen answers here keyed by reqId;
  // /permission-request reads + clears them after the await and returns them so
  // the MCP can inject updatedInput.answers back into the CLI.
  const permissionAnswers = new Map<string, Record<string, string>>();
  // POST /:sid/kernel-tool —— host-tool 桥(T-A)。内核 CC 经 fxt MCP server 把对
  // host-tool 的调用 HTTP 回调到这里:定位活 agent → 信任闸 → host 侧执行 → 回结果。
  // 信任闸(T-D)在此**唯一闸口**:trustTier 权威 = R6 loadAgentRecord 按加载路径定,
  // 不信子进程上报。fail-closed:任何缺失/异常都按 deny / error 返回(不静默放行)。
  r.post('/:sid/kernel-tool', async (c) => {
    const sid = c.req.param('sid');
    const start = Date.now();
    const body = await c.req.json().catch(() => ({}));
    const agentPath = typeof body.agentPath === 'string' && body.agentPath ? body.agentPath : 'forge';
    let toolName = typeof body.toolName === 'string' ? body.toolName : '';
    let args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    if (!toolName) return c.json({ ok: false, error: 'toolName required' }, 400);
    // P1-9 一等工具化:ui_act_* 在信任闸**之前**反解回 ui_invoke(actionId),使权限
    // (per-action 闸)/审计/执行全程只认识 ui_invoke 一条路(与 host-tool-bridge 同口径)。
    const fcTool = resolveFirstClassUiTool(sid, toolName);
    if (fcTool) {
      args = { actionId: fcTool.actionId, args };
      toolName = 'ui_invoke';
    }

    const session = getSessionManager().peek(sid) ?? (await getSessionManager().open(sid));
    const agent = session.scheduler.getAgent(agentPath);
    if (!agent) {
      // agent 不在线 —— 审计记录 allow=false
      appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier: 'unknown', allow: false, error: `agent '${agentPath}' not live in session`, durationMs: Date.now() - start, ts: start });
      return c.json({ ok: false, error: `agent '${agentPath}' not live in session` });
    }

    // 信任闸:own=full;imported=deny 危险集。权威 trustTier 按加载路径求。
    let trustTier: 'own' | 'imported' = 'imported';
    try {
      trustTier = (await loadAgentRecord(agentPath, { projectRoot: defaultProjectRoot() })).trustTier;
    } catch {
      /* fail-closed → imported */
    }
    // R2-08:imported 写禁但「该 session 绑定的 game 目录内」豁免。永久绑定(PR2)下豁免基准
    // 必须是 session 自己绑的 game(config.defaultDir 由路径派生),**不是**全局 active game——
    // 否则绑 A、active 切 B 时会误判 A 自己的写。session 未绑则回落 active game。
    const projectRoot = defaultProjectRoot();
    const scopeGame = session.config?.defaultDir ?? getPathManager().resolveScope();
    // sid 供 ui_invoke 的 per-action capability 查表(manifest 缓存按 sid 存,见 trust-gate)。
    const decision = checkKernelTool(trustTier, toolName, { args, projectRoot, activeGame: scopeGame, sid });
    if (decision.outcome === 'deny') {
      // 信任闸硬拒 —— 审计记录 allow=false
      appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier, allow: false, error: decision.reason ?? 'denied by trust tier', durationMs: Date.now() - start, ts: start });
      return c.json({ ok: false, error: decision.reason ?? 'denied by trust tier' });
    }
    // ask:弹权限卡阻塞等用户(命中本会话 remember 直放);拒绝/超时 → 审计 + 拒。
    if (decision.outcome === 'ask') {
      const approved = await requestToolApproval({
        eventBus: session.eventBus,
        sid,
        agent: agentPath,
        toolName,
        ...(decision.capability ? { capability: decision.capability } : {}),
        args,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      if (!approved) {
        appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier, allow: false, error: 'denied by user', durationMs: Date.now() - start, ts: start });
        return c.json({ ok: false, error: `denied by user: ${toolName}` });
      }
    }

    try {
      // 执行解析顺序(与 host-tool-bridge 同口径,对称的两个 host 工具执行口):
      //   ①内置 forgeax 工具走宿主侧实现;②产品壳 seam 注入且带 run 的 host 工具
      //   (list_games/query_world/capture_frame,P1-7)走 `HostToolSpec.run`;
      //   ③其余查 agent kit 注册表。租用内核(外部 CLI 内核)的内置批在 .mjs 本地跑,
      //   但 ui_snapshot/ui_invoke 例外 —— 它们经 .mjs → 此路由,以复用这里的 per-action
      //   信任闸(ui_invoke 可触达 delete 级 action,必须过闸)。seam 工具无 .mjs 本地
      //   实现 → 经 BRIDGED specs 桥到本路由执行。
      const seamTool = getHostTool(toolName);
      const builtinCtx = {
        projectRoot,
        agentId: agentPath,
        ...(scopeGame ? { game: scopeGame } : {}),
        eventBus: session.eventBus,
        sid,
      };
      const out = isForgeaxBuiltinTool(toolName)
        ? await runForgeaxBuiltinTool(toolName, args, builtinCtx)
        : seamTool?.run
          ? await seamTool.run(args, hostToolRunCtx(builtinCtx))
          : await executeTool(toolName, args, agent.agentContext.tools.list(), agent.agentContext);
      if (out && typeof out === 'object' && !Array.isArray(out) && 'error' in out) {
        const errMsg = String((out as { error: unknown }).error);
        // 工具执行返回 error 字段 —— ok=false
        appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier, allow: true, ok: false, error: errMsg, durationMs: Date.now() - start, ts: start });
        return c.json({ ok: false, error: errMsg });
      }
      // 工具执行成功
      appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier, allow: true, ok: true, durationMs: Date.now() - start, ts: start });
      return c.json({ ok: true, result: out });
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      // 工具执行抛出异常
      appendToolAudit({ sid, agent: agentPath, tool: toolName, trustTier, allow: true, ok: false, error: errMsg, durationMs: Date.now() - start, ts: start });
      return c.json({ ok: false, error: errMsg });
    }
  });

  r.post('/:sid/permission-request', async (c) => {
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const toolName = typeof body.toolName === 'string' ? body.toolName : 'tool';
    const command = typeof body.command === 'string' ? body.command : '';
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : 'forge';
    const reqId = randomUUID();
    const session = getSessionManager().peek(sid);
    if (!session) return c.json({ allow: false, reason: 'no-session' }, 200);

    // A1#4 — 先咨询本轮中立权限闸(TurnRequest.requestPermission,经 cc-profile 的
    // per-turn registry 按真 sid 登记)。命中即直接回执,免去弹卡;这让「编排层的
    // checkTool/requestPermission 成为 CC 内核的唯一闸」真正闭合。未登记(无内核闸
    // 或非内核路径)→ undefined → 回落到下面既有的「弹卡 + 阻塞」流程,行为不变。
    // fail-closed:闸内部抛错时 consultTurnGate 已返回 deny(不静默放行)。
    const gateDecision = await consultTurnGate(sid, {
      name: toolName,
      args: body.input ?? (command ? { command } : null),
    });
    if (gateDecision) {
      const allowed = gateDecision.behavior === 'allow';
      return c.json({
        allow: allowed,
        ...(allowed ? {} : { reason: gateDecision.message || 'denied by turn gate' }),
      });
    }

    // Pop the approval card in the Studio UI. Reuses the per-session WS fan-out
    // (same channel as file-activity:*); the client's permission-stream handler
    // renders a modal keyed by reqId.
    session.eventBus.publish(
      {
        type: 'permission:request',
        ts: Date.now(),
        source: `agent:${agent}`,
        payload: { reqId, toolName, command, input: body.input ?? null, agent },
      },
      agent,
    );

    // Own the request by (sid, agent) so a turn abort/end can release it.
    // sid here == FORGEAX_SID the MCP server posted to == threadId; agent ==
    // FORGEAX_AGENT. cli/chat.ts's turn-end hook recomputes the identical pair.
    const handle = registerPermission(reqId, PERMISSION_TIMEOUT_MS, { sid, agent });
    let allow = false;
    try {
      allow = await handle.promise;
    } finally {
      handle.dispose();
      // Tell the UI to dismiss the card regardless of how it settled (reply /
      // timeout / abort) so a stale prompt never lingers.
      session.eventBus.publish(
        {
          type: 'permission:resolved',
          ts: Date.now(),
          source: `agent:${agent}`,
          payload: { reqId, allow },
        },
        agent,
      );
    }
    // For AskUserQuestion: hand back the user's chosen answers so the MCP can
    // inject updatedInput.answers (without these, CC gets "did not answer").
    const answers = permissionAnswers.get(reqId);
    permissionAnswers.delete(reqId);
    return c.json({ allow, ...(answers ? { answers } : {}) });
  });

  // POST /:sid/permission-reply —— 前端审批卡上点「允许/拒绝」后调用,解开上面
  // hold 住的 /permission-request。未命中(已超时/已答)返回 ok:false,前端忽略。
  r.post('/:sid/permission-reply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reqId = typeof body.reqId === 'string' ? body.reqId : '';
    const allow = body.allow === true;
    if (!reqId) return c.json({ error: 'reqId (string) required' }, 400);
    // AskUserQuestion: the reply carries `answers` ({ [questionText]: label });
    // stash before resolving so /permission-request can return them.
    if (allow && body.answers && typeof body.answers === 'object') {
      const a: Record<string, string> = {};
      for (const [k, v] of Object.entries(body.answers as Record<string, unknown>)) {
        if (typeof v === 'string') a[k] = v;
      }
      if (Object.keys(a).length > 0) permissionAnswers.set(reqId, a);
    }
    // 「记住本会话」:allow && remember → 记住该 agent 的该 capability,本会话内同类免卡。
    // 必须在 resolvePermission 之前(此时 pendingCtx 仍在)。
    applyRememberOnReply(reqId, allow, body.remember === true);
    const ok = resolvePermission(reqId, allow);
    return c.json({ ok, ...(ok ? {} : { reason: 'no-pending' }) });
  });

  // ── 感知接地(R5 §C / M8 L1)——————————————————————————————————————————
  // 取数往返(host-forced verification, "仅取数, 不当裁判"):内核 turn 调
  // query_world/capture_frame → fxt MCP server HTTP 回打这里 → 经 EventBus 把
  // perception:query 推给 interface → interface 向 preview iframe postMessage 取真值
  // → 拿到后 POST /perception-reply 解开本 hold 住的响应。镜像 permission 往返,但
  // 回的是 snapshot;超时 fail-soft(取数失败不挂死 turn,只是少一份证据)。
  const PERCEPTION_TIMEOUT_MS = 8_000;
  /** ui_invoke 通道默认超时(略宽:要等 action 执行/受理);manifest 声明 timeoutMs 可放宽。 */
  const UI_INVOKE_TIMEOUT_MS = 10_000;
  const PERCEPTION_KINDS: ReadonlySet<string> = new Set(['world', 'frame', 'ui_snapshot', 'ui_invoke']);
  r.post('/:sid/perception-query', async (c) => {
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const kind = (PERCEPTION_KINDS.has(body.kind) ? body.kind : 'world') as PerceptionKind;
    const isUiKind = kind === 'ui_snapshot' || kind === 'ui_invoke';
    const agent = typeof body.agent === 'string' && body.agent ? body.agent : 'forge';
    const reqId = typeof body.reqId === 'string' && body.reqId ? body.reqId : randomUUID();
    const session = getSessionManager().peek(sid);
    if (!session) return c.json({ ok: false, reason: 'no-session', snapshot: { unavailable: true, reason: 'no-session' } }, 200);

    // 推 perception:query 给前端(同 permission:request 的 per-session WS fan-out)。
    session.eventBus.publish(
      {
        type: 'perception:query',
        ts: Date.now(),
        source: `agent:${agent}`,
        payload: { reqId, kind, query: body.query ?? null, agent },
      },
      agent,
    );

    // ui_invoke:超时按 manifest 声明放宽;ui_* 回灌须持有效 lease(声明与执行方同源)。
    const timeoutMs =
      kind === 'ui_invoke'
        ? uiInvokeTimeoutMs(sid, (body.query as { actionId?: unknown } | null)?.actionId, UI_INVOKE_TIMEOUT_MS)
        : PERCEPTION_TIMEOUT_MS;
    const handle = registerPerception(reqId, timeoutMs, isUiKind ? { requireLease: { sid } } : {});
    let snapshot: unknown;
    try {
      snapshot = await handle.promise;
    } finally {
      handle.dispose();
    }
    return c.json({ ok: true, reqId, snapshot });
  });

  // 前端把 preview iframe 回的 VAG_WORLD_STATE/VAG_FRAME(或 ActionRegistry 的 ui_* 应答)
  // 经此回灌,解开 /perception-query。ui_* 类 pending 要求 body.leaseId 有效(lease 校验
  // 不通过时不消费 pending,真正持有者仍可回灌)。
  r.post('/:sid/perception-reply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reqId = typeof body.reqId === 'string' ? body.reqId : '';
    if (!reqId) return c.json({ error: 'reqId (string) required' }, 400);
    const ok = resolvePerception(reqId, body.snapshot ?? null, body.leaseId);
    return c.json({ ok, ...(ok ? {} : { reason: 'no-pending-or-bad-lease' }) });
  });

  // ── UI 语义操作层(产品 AI 化 P0)—————————————————————————————————————
  // lease:多标签同 sid 时「最后获焦 tab」持有;manifest 权威来源与 ui_* 应答方都
  // 绑定到持有者(displace 语义,心跳续期)。会话鉴权与 perception-reply 同级
  // (session 绑定);manifest 是 trust-gate 的权限输入,故写入必须持有效 lease,
  // 且这两个端点**不进** MCP 桥出面(.mjs 不暴露)。
  //
  // Origin 收口(架构师嘱咐,B6):这两个写端点是权限闸的信任锚——浏览器跨站发起
  // 的写一律拒(防「恶意页面骗本机 server 改写权限声明」)。规则:无 Origin 头
  // (curl / 同进程 / 非浏览器)放行;有 Origin 时 hostname 须为 loopback、与本次
  // 请求 Host 同名,或落在 FORGEAX_UI_BRIDGE_ORIGINS(逗号分隔,给桌面 tauri://
  // 等形态)白名单内。fail-closed 403。
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const EXTRA_UI_ORIGINS = new Set(
    (process.env.FORGEAX_UI_BRIDGE_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  const uiWriteOriginAllowed = (c: { req: { header: (n: string) => string | undefined } }): boolean => {
    const origin = c.req.header('origin');
    if (!origin) return true; // 非浏览器调用(无 Origin)——与 perception-reply 同级信任面
    if (EXTRA_UI_ORIGINS.has(origin)) return true;
    try {
      const o = new URL(origin);
      if (LOOPBACK_HOSTS.has(o.hostname)) return true;
      const host = c.req.header('host') ?? '';
      const hostName = host.includes(':') && !host.startsWith('[') ? host.slice(0, host.indexOf(':')) : host;
      return !!hostName && o.hostname === hostName;
    } catch {
      return false; // Origin 不可解析 → fail-closed
    }
  };

  r.post('/:sid/ui-lease', async (c) => {
    const sid = c.req.param('sid');
    if (!uiWriteOriginAllowed(c)) return c.json({ ok: false, reason: 'origin-not-allowed' }, 403);
    const body = await c.req.json().catch(() => ({}));
    const clientId = typeof body.clientId === 'string' && body.clientId ? body.clientId : '';
    if (!clientId) return c.json({ ok: false, reason: 'clientId (string) required' }, 400);
    if (!getSessionManager().peek(sid)) return c.json({ ok: false, reason: 'no-session' }, 200);
    const lease = acquireUiLease(sid, clientId);
    return c.json({ ok: true, ...lease });
  });

  r.post('/:sid/ui-manifest', async (c) => {
    const sid = c.req.param('sid');
    if (!uiWriteOriginAllowed(c)) return c.json({ ok: false, reason: 'origin-not-allowed' }, 403);
    const body = await c.req.json().catch(() => ({}));
    if (!getSessionManager().peek(sid)) return c.json({ ok: false, reason: 'no-session' }, 200);
    const res = setUiManifest(sid, body.actions, body.leaseId);
    return c.json(res, res.ok ? 200 : 403);
  });

  // L1 错误回灌:游戏运行期 console error / preview error → per-sid 环形缓冲,
  // 下一轮 composeTurnRequest drain 进 dynamicSuffix(轮间 user 后缀注入)。
  r.post('/:sid/perception', async (c) => {
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const level = body.level === 'warn' ? 'warn' : body.level === 'error' ? 'error' : null;
    const text = typeof body.text === 'string' ? body.text : '';
    if (!level || !text.trim()) return c.json({ ok: false, reason: 'level(error|warn)+text required' }, 200);
    pushPerceptionNote(sid, { level, text: text.slice(0, 2000), ts: Date.now() });
    return c.json({ ok: true });
  });

  return r;
}
