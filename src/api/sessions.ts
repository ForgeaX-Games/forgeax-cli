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
import { readFileSync } from 'node:fs';
import { getSessionManager } from '../core/session-manager';
import type { Session } from '../core/session';
import type { AgentJson, Event } from '../core/types';
import { ensureAgentScaffold, isValidAgentName } from '../core/agent-scaffold';
import { resolvePersonaForAgent } from '../agents/loader';
import { findMarketplaceManifest } from './lib/marketplace-manifest';
import { defaultProjectRoot } from './lib/safe-path';
import { getActiveGame } from './lib/active-game';
import { resolveAsk } from '../core/ask-user-registry';
import { randomUUID } from 'node:crypto';
import { registerPermission, resolvePermission } from '../core/permission-registry';
import { registerPerception, resolvePerception, pushPerceptionNote } from './lib/perception-registry';
import { executeTool } from '../kits/tool/tool-executor';
import { checkKernelTool } from '../kernel/trust-gate';
import { requestToolApproval, applyRememberOnReply } from '../kernel/tool-approval';
import { getCheckpointManager, type RewindMode } from '../checkpoint/checkpoint-manager';
import { loadAgentRecord } from '../soul';
import { appendToolAudit } from '../kernel/tool-audit';
import { consultTurnGate } from '../kernel/cc-profile';

/** 终极 fallback —— marketplace manifest 缺 / 解析失败时回到泛用 'root' path。
 *  e2e 测试（`makeSidWithRootAgent`）也走这条 path，保持兼容。 */
const FALLBACK_BOOTSTRAP_AGENT = 'root';

/** 真正的「默认入口 agent」—— marketplace manifest 里 `default: true` 的那个
 *  agent id（当前是 forge）。读盘成本可忽略，每次 POST /sessions 才命中一次。
 *  失败回 root —— 跟 ref agenteam `cmdChat` 拿不到 agent context 时的兜底
 *  policy 同款（不阻塞 session 创建，让用户后续手动 pin）。 */
function resolveManifestMainAgent(): string {
  try {
    const found = findMarketplaceManifest(defaultProjectRoot());
    if (!found.path) return FALLBACK_BOOTSTRAP_AGENT;
    const raw = readFileSync(found.path, 'utf-8');
    const parsed = JSON.parse(raw) as { agents?: Array<{ id?: string; default?: boolean }> };
    const main = (parsed.agents ?? []).find((a) => a?.default && typeof a.id === 'string' && a.id.length > 0);
    return main?.id ?? FALLBACK_BOOTSTRAP_AGENT;
  } catch {
    return FALLBACK_BOOTSTRAP_AGENT;
  }
}

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
    return c.json({ sessions: sm.list() });
  });

  r.post('/', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const sm = getSessionManager();
    // defaultDir precedence: explicit body value → the workspace's active game
    // (so a new session's cli opens in whatever game the user is on) → 'default'.
    const session = await sm.create({
      displayName: body.displayName,
      defaultDir: body.defaultDir ?? getActiveGame(defaultProjectRoot()) ?? 'default',
      defaultModels: body.defaultModels,
      timezone: body.timezone,
      autoStart: body.autoStart,
    });
    // **先** scheduler.start() 让它先订阅 tree.onChange，**再** scaffold root
    // —— scaffold 写盘后 FSWatcher 派发 rename → tree.onChange("added") →
    // scheduler.attachAndStart。如果倒过来，写盘那一刻 scheduler 还没订阅，
    // 派发会落空（虽然 start 内同步扫盘 tree.list() 也会 attach root，但保
    // 持事件链单一更易排错）。
    session.scheduler.start();

    // Bootstrap default agent —— interface 创建 session 时必须先有一个入口
    // agent，否则 AgentSwitcher 看到空列表就显示 "agent: 未指定"。
    //
    // body.bootstrapAgent:
    //   - undefined / 不传  → 解析 marketplace manifest 找 default=true 的 agent
    //                         （当前为 forge），fallback 到 'root'。「主 agent」
    //                         概念跟「新 session 入口 agent」是同一个，不再分两套。
    //   - "<name>"         → 用该名（必须符合 isValidAgentName / Path）
    //   - false / "" / null → 显式不 bootstrap（保留给"想要纯空 session"的 API 调用方）
    //
    // 用户指定 simple-name (mochi/iori/...) 时同样跑 persona 解析（跟 POST
    // /messages 自动 scaffold 路径一致），让选择 mochi 当默认的用户开新 session
    // 立刻看到 mochi persona、不会落到「root agent 但没人格」。
    let bootstrappedAgent: string | null = null;
    if (body.bootstrapAgent !== false && body.bootstrapAgent !== null && body.bootstrapAgent !== '') {
      const agentPath = typeof body.bootstrapAgent === 'string'
        ? body.bootstrapAgent
        : resolveManifestMainAgent();
      try {
        let personaFile: string | undefined;
        let memoryDir: string | undefined;
        let hostTools: string[] | undefined;
        const isSimpleName =
          !agentPath.includes('/') && !agentPath.includes('#') && isValidAgentName(agentPath);
        if (isSimpleName && agentPath !== FALLBACK_BOOTSTRAP_AGENT) {
          // 走和 messages 端一样的 marketplace 解析。解析失败不阻塞 bootstrap ——
          // 落到 root-style 空 persona 兜底，比拒绝建 session 更顺手。
          try {
            const persona = await resolvePersonaForAgent(agentPath);
            if (persona) {
              personaFile = persona.personaPath;
              memoryDir = persona.memoryDir;
              hostTools = persona.tools;
            }
          } catch (e: any) {
            process.stderr.write(
              `[sessions] bootstrap persona resolve for '${agentPath}' failed: ${e?.message ?? e}\n`,
            );
          }
        }
        const overrides: Partial<AgentJson> = {};
        if (personaFile) overrides.personaFile = personaFile;
        if (memoryDir) overrides.memoryDir = memoryDir;
        if (hostTools && hostTools.length > 0) {
          overrides.kits = { config: { 'host-tools': { allow: hostTools } } };
        }
        await ensureAgentScaffold(session.sid, agentPath, {
          agentType: 'conscious',
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        });
        bootstrappedAgent = agentPath;
      } catch (err: any) {
        process.stderr.write(
          `[sessions] bootstrap agent '${agentPath}' for ${session.sid} failed: ${err?.message ?? err}\n`,
        );
      }
    }

    return c.json({ sid: session.sid, bootstrappedAgent });
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

    const event: Event = target
      ? {
          source: 'user',
          type: body.type ?? 'user_input',
          payload: { content, ...(msgId ? { msgId } : {}), ...(body.payload ?? {}) },
          to: target,
          handoff: body.handoff ?? 'turn',
          ts: Date.now(),
        }
      : {
          source: 'user',
          type: body.type ?? 'user_input',
          payload: { content, ...(msgId ? { msgId } : {}), ...(body.payload ?? {}) },
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
    const toolName = typeof body.toolName === 'string' ? body.toolName : '';
    const args = body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    if (!toolName) return c.json({ ok: false, error: 'toolName required' }, 400);

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
    // R2-08:imported 写禁但「当前游戏目录内」豁免 —— 传 args/projectRoot/activeGame 供作用域判定。
    const projectRoot = defaultProjectRoot();
    const decision = checkKernelTool(trustTier, toolName, { args, projectRoot, activeGame: getActiveGame(projectRoot) });
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
      const out = await executeTool(toolName, args, agent.agentContext.tools.list(), agent.agentContext);
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
  r.post('/:sid/perception-query', async (c) => {
    const sid = c.req.param('sid');
    const body = await c.req.json().catch(() => ({}));
    const kind = body.kind === 'frame' ? 'frame' : 'world';
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

    const handle = registerPerception(reqId, PERCEPTION_TIMEOUT_MS);
    let snapshot: unknown;
    try {
      snapshot = await handle.promise;
    } finally {
      handle.dispose();
    }
    return c.json({ ok: true, reqId, snapshot });
  });

  // 前端把 preview iframe 回的 VAG_WORLD_STATE/VAG_FRAME 经此回灌,解开 /perception-query。
  r.post('/:sid/perception-reply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const reqId = typeof body.reqId === 'string' ? body.reqId : '';
    if (!reqId) return c.json({ error: 'reqId (string) required' }, 400);
    const ok = resolvePerception(reqId, body.snapshot ?? null);
    return c.json({ ok, ...(ok ? {} : { reason: 'no-pending' }) });
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
