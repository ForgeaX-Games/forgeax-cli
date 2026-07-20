/**
 * forgeax-core `--serve` —— 把 forgeax-core 内核以**子进程 + 双向 JSON-RPC**形态暴露,
 * 供 sidecar(agent-host)托管、server 侧 adapter 直连(R3 内核归一)。
 *
 * 本进程在 per-session unix-sock 上起 RPC server,**自家代码原生
 * 实现协议层**(比 headless CLI 的 stdout-JSONL 更高契合:全双工、反向 host-tool/取消)。
 *
 * 控制面方法(adapter → serve):
 *   - `runTurn(wireReq)`     跑一轮;KernelEvent 经 `event` 通知流回;请求 resolve = 轮终。
 *   - `cancel(callId)` / `interrupt(callId)`  取消在飞轮(abort signal + facade handle)。
 *   - `setModel` / `setPermissionMode`        透传 facade handle(headless 上限同 facade)。
 *   - `ping`                                  健康探测。
 * 反向(serve → adapter):
 *   - `hostTool({name,args,sid})` 请求       **所有工具执行回调宿主**——宿主复跑 checkKernelTool
 *     (信任边界钉在 host;serve 不持危险工具本地实现)。详见评审稿 §3.1。
 *   - `askUser({toolName,toolUseId,input,message})` 请求  in-core 交互式 'ask' 回宿主裁决,
 *     应答 `{granted:boolean}`。当前仅 ExitPlanMode(007 plan 出口人类闸)走此路;宿主未实现
 *     → loud 降级为放行(旧行为)。
 *
 * 凭据:provider 从 **env 的 scoped token** 造(真 key 只在 sidecar cred-vault);serve 进程
 * 不持真 upstream key。
 *
 * Boundary: 仅 core 相对 + node:。
 */
import { existsSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:net';
import type { TurnRequest, KernelEvent, ForkExtractRequest } from '@forgeax/agent-runtime/contract';
import { ForgeaxCoreKernel, type ExecuteToolFn } from '../kernel-facade/forgeax-core-kernel';
import { InProcessScheduler } from '../inject/in-process-scheduler';
import { InProcessTeammateExecutor } from '../inject/in-process-teammate-executor';
import { EventBus } from '../events/event-bus';
import { buildChildSpawnFn } from './peer';
import { listenRpc, type RpcConnection } from './rpc';
import { resolveProviderFromEnv } from './provider-env';
import type { LLMProvider, ProviderRequest } from '../provider/types';
import type { AgentTool } from '../capability/types';
import { builtinToolsPack } from '../capability/builtin-tools/index';
import { notebookToolsPack } from '../capability/builtin-tools/notebook-tools';
import { NodeSandboxFs, NodeTerminal } from './io';
import { makeImageDownscaler } from './image-scale';
import { makeNodeObservability } from './observability';
import { loadPermissionRulesFromSettings } from './permission-settings';
import { isExitPlanTool } from '../permission/engine';
import type { TelemetryRecord } from '@forgeax/types';

/** runTurn 的线上入参 = TurnRequest 的**可序列化子集**(去掉 requestPermission/hooks 等函数)。 */
type WireTurnRequest = Omit<TurnRequest, 'requestPermission' | 'hooks'>;

/** 扩展思考配置:默认 `adaptive`(对齐重构前的 working 配置——旧请求即 thinking:adaptive,
 *  且能持续吐 thinking 增量,避免长轮在首 token 前长时间静默)。重构曾整段丢了这条接线。
 *  env `FORGEAX_THINKING`:`off|0|disabled|none` → 关;`enabled[:budget]` → 固定预算;
 *  其余(含缺省)→ `adaptive`。 */
function resolveThinkingConfig(): ProviderRequest['thinking'] | undefined {
  const v = (process.env.FORGEAX_THINKING ?? 'adaptive').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'disabled' || v === 'none') return undefined;
  if (v.startsWith('enabled')) {
    const b = Number(v.split(':')[1]);
    return { type: 'enabled', budgetTokens: Number.isFinite(b) && b > 0 ? b : 8192 };
  }
  // display:'summarized' → 流式吐 thinking 增量(UI 可见思考),对齐旧 working 请求。
  return { type: 'adaptive', display: 'summarized' };
}

function buildProvider(model: string): LLMProvider {
  // env 统一解析(provider-env):LiteLLM 代理优先,否则直连(scoped token 经 env 注入)。
  return resolveProviderFromEnv(model);
}

/** 起 serve:在 sockPath 上 listen,每条连接绑定一个 forgeax-core facade。返回 net.Server。 */
export async function startServe(sockPath: string): Promise<Server> {
  // 清理陈旧 sock(同款 listen-before-use)。
  if (existsSync(sockPath)) {
    try { unlinkSync(sockPath); } catch { /* ignore */ }
  }

  const peerAgents = process.env.FORGEAX_PEER_AGENTS !== '0';

  // B 路径(own 安全工具本地直跑):core builtin 实现表 + 本地 IO(NodeSandboxFs/Terminal)。
  //   host 经 `ToolSpec.delivery==='local'` 决定哪些工具走本地;facade wrapTools 按名取本表实现,
  //   在本进程内直跑(满速 + crash 隔离),不回宿主。注入全量 builtin 无害——未标 local 的仍走
  //   host 桥。serve 是 HOST 层,引 capability/io 合法(机制层不碰 node:fs 的约束不破)。
  const localToolImpls: AgentTool[] = [
    ...(builtinToolsPack().tools ?? []),
    ...(notebookToolsPack().tools ?? []),
  ];
  const downscaleImage = makeImageDownscaler();
  const localToolContext: Record<string, unknown> = {
    sandboxFs: new NodeSandboxFs(),
    terminal: new NodeTerminal(),
    cwd: process.cwd(),
    // 图片进 context 前缩图(对齐 CC):local 直跑的 read_file 经 ctx 消费。
    ...(downscaleImage ? { downscaleImage } : {}),
  };

  // 扩展思考:默认 adaptive,对齐重构前 working 配置(旧 working 请求即 thinking:adaptive)。
  const thinkingCfg = resolveThinkingConfig();

  // 权限规则(楔子1 · 046):从分层 settings 的 permissions 段载出。Studio 经 sidecar 驱动 core 时,
  //   askUser defer 只拦 in-core 的 'ask'(交 host 弹卡),**in-core deny 仍核内强制**(见下 kernel
  //   注释)——故「在 .forgeax/settings.json 里写一条 deny」经此对 Studio 生效。无 permissions →
  //   三空桶(默认 tier 行为不变)。启动读一次(settings 会话级缓存)。
  const settingsRules = loadPermissionRulesFromSettings();

  const server = await listenRpc(sockPath, (conn: RpcConnection, sock) => {
    // 反向 host-tool 桥:serve 的所有工具执行都回调宿主(adapter 复跑 checkKernelTool)。
    const executeTool: ExecuteToolFn = async (name, args, sid, agentId, callId) =>
      conn.request('hostTool', { name, args, sid, agentId, callId });

    // ★ 可观测性(v3/B 档):exporter `send` → 独立 `telemetry` RPC 通知回流 server(与 turn 解耦,
    //   不开自己的 WS、不落盘——落盘+广播在 host/server 端)。FORGEAX_OTEL=off 时 makeNodeObservability
    //   内部不挂 exporting processor(span 不出),logger 仍出 LogRecord;通知本身 best-effort 吞错。
    const observability = makeNodeObservability({
      send: (records: TelemetryRecord[]) => {
        try {
          conn.notify('telemetry', { records });
        } catch {
          /* 诊断绝不影响主流程(§9) */
        }
      },
    });
    // 连接关闭:刷尽残留批 + 关 OTLP exporter(否则丢最后一批 / 泄漏 exporter)。
    sock.on('close', () => void observability.shutdown());

    // ★ M2 team 接线(plan-strategy D-2 / m2-t6):per-connection 一个 team —— 共享 bus +
    //   InProcessTeammateExecutor(进程内 mailbox 两平面)。子 agent 经 buildChildSpawnFn 登记
    //   可寻址、拿 inbox 闭包(数据面进 LLM / 控制面进 handler,闭包在 host 侧 peer.ts 构造,
    //   不改 agent.ts)。peerAgents 关时不建(退化为单 agent + 父子树,§9)。
    const teamExecutor = peerAgents ? new InProcessTeammateExecutor() : undefined;
    const teamBus = peerAgents ? new EventBus() : undefined;

    const kernel = new ForgeaxCoreKernel({
      provider: buildProvider('claude-opus-4-8'),
      executeTool,
      observability,
      // B 路径:本地工具实现表 + 本地 IO。delivery==='local' 的工具经此本进程直跑(不回宿主);
      //   其余仍走上面的 executeTool 桥(host 把闸)。
      toolContext: localToolContext,
      localToolImpls,
      // 用户附件图进 context 前缩图(facade buildUserPayload 消费;undefined → degrade)。
      ...(downscaleImage ? { downscaleImage } : {}),
      // 权限规则(楔子1 · 046):settings.permissions.{deny,ask,allow} 载出的规则集。
      //   engine ① deny 在 dispatch 派发前就闸(先于本地/回宿主的执行路由),故 deny 对
      //   local-delivery 与 host-bridged 工具一律生效;'ask' 由下方 askUser defer 交 host。
      rules: settingsRules,
      // 扩展思考(重构丢了这条接线 → 旧版有 thinking 显示、新版没有)。默认 adaptive。
      ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
      // 信任边界钉在 host(评审稿 §3.1):serve 的所有工具都回调宿主,宿主 host-tool-bridge
      //   复跑 checkKernelTool **并在 `ask` 档弹权限卡**(own 危险操作 / imported)。因此 in-core
      //   的交互式 'ask' 一律 **defer 给 host**——askUser 恒 allow,让工具落到 host 闸由用户裁决;
      //   in-core 的 **deny**(规则 / plan 只读)仍照常在核内强制(askUser 只拦 'ask',不影响 deny)。
      //   若不传 askUser,in-core 对 'ask' 会 fail-closed deny(agent.ts:131),Bash/写等永远到不了
      //   host 卡 —— 故这里必须显式 defer。
      //   **例外:ExitPlanMode**(007 出口人类闸)——它是 in-core 工具,不过 hostTool 桥,
      //   blanket-allow 会把出口人类确认整个吞掉。改为经 `askUser` RPC 回宿主裁决;宿主未实现
      //   该方法(或请求失败)→ loud 降级为放行(= 旧「自动退出 plan」行为,§9 优雅降级,零回归)。
      askUser: async (perm, use) => {
        if (!isExitPlanTool(use.name)) return true;
        try {
          const r = await conn.request('askUser', {
            toolName: use.name,
            toolUseId: use.id,
            input: use.input,
            message: perm.message,
          });
          return (r as { granted?: boolean } | undefined)?.granted === true;
        } catch (e) {
          process.stderr.write(
            `[forgeax-core serve] host 未应答 askUser(${use.name}),降级为自动放行(旧行为)。` +
              `宿主实现 'askUser' RPC 后即获出口人类闸。err=${e instanceof Error ? e.message : String(e)}\n`,
          );
          return true;
        }
      },
      // peer 多 agent:每轮工厂用本轮 provider/model/host 工具建调度器(子 agent 同源回调宿主)。
      //   M2:把 team 接线(共享 bus + executor)透进 spawn 工厂,子 agent 走共享 bus + mailbox
      //   inbox 闭包(可寻址 + 收 SendMessage 真投递);scheduler 也接同一 bus 供 sleep{event}。
      ...(peerAgents
        ? {
            handoff: ({ provider, model, tools }) =>
              new InProcessScheduler({
                spawnFn: buildChildSpawnFn(provider, tools, model, 20, {
                  executor: teamExecutor!,
                  bus: teamBus!,
                }),
                bus: teamBus,
              }),
          }
        : {}),
    });

    /** callId → 在飞轮的 AbortController(供 cancel/interrupt)。 */
    const inflight = new Map<string, AbortController>();

    conn.setRequestHandler(async (method, params) => {
      switch (method) {
        case 'ping':
          return { ok: true };
        case 'runTurn': {
          const req = params as WireTurnRequest;
          const callId = req.callId ?? req.session?.threadId ?? 'turn';
          const ac = new AbortController();
          inflight.set(callId, ac);
          try {
            for await (const ev of kernel.runTurn(req as TurnRequest, ac.signal)) {
              conn.notify('event', { callId, event: ev as KernelEvent });
            }
            return { ok: true };
          } finally {
            inflight.delete(callId);
          }
        }
        case 'cancel':
        case 'interrupt': {
          const { callId } = (params as { callId: string }) ?? { callId: '' };
          inflight.get(callId)?.abort(method);
          await kernel.openHandle(callId)[method === 'cancel' ? 'cancel' : 'interrupt']();
          return { ok: true };
        }
        case 'setModel': {
          const { callId, model } = params as { callId: string; model: string };
          await kernel.openHandle(callId).setModel(model);
          return { ok: true };
        }
        case 'setPermissionMode': {
          const { callId, mode } = params as { callId: string; mode: 'gated' | 'autoEdits' | 'planning' | 'unrestricted' };
          await kernel.openHandle(callId).setPermissionMode(mode);
          return { ok: true };
        }
        case 'forkExtract': {
          // cache-safe fork 提取(编排层 turnEnd 驱动):复用上一轮缓存前缀做后台记忆抽取。
          if (!kernel.forkExtract) throw Object.assign(new Error('kernel has no forkExtract'), { code: -32601 });
          const ac = new AbortController();
          const res = await kernel.forkExtract(params as ForkExtractRequest, ac.signal);
          return res;
        }
        default:
          throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
      }
    });
  });

  // ready 行(纯日志;adapter 靠连接探测就绪,不解析 stdout)。
  process.stdout.write(`${JSON.stringify({ ready: true, sock: sockPath, pid: process.pid })}\n`);

  const shutdown = (): void => {
    try { server.close(); } catch { /* ignore */ }
    try { if (existsSync(sockPath)) unlinkSync(sockPath); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return server;
}
