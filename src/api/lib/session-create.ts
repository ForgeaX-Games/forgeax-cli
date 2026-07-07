/** session-create —— 「建 session + bootstrap 入口 agent」的单一实现(SSOT)。
 *
 *  两个消费者:①`POST /api/sessions` 路由(api/sessions.ts);②UI 语义操作层的
 *  headless handler(kernel/ui-headless-actions.ts 的 `session.create`,UI 不在线时
 *  ui_invoke 回落执行)。抽到独立模块(而非留在 sessions.ts)是为了避免
 *  sessions.ts → forgeax-builtin-tools → ui-headless-actions → sessions.ts 的环。
 *  逻辑从路由原样搬入(方案 §5 硬约束:headless 路径必须调与 UI 相同的实现)。
 */
import { readFileSync } from 'node:fs';
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getSessionManager } from '../../core/session-manager';
import type { AgentJson, ModelsConfig } from '../../core/types';
import { ensureAgentScaffold, isValidAgentName } from '../../core/agent-scaffold';
import { resolvePersonaForAgent } from '../../agents/loader';
import { findMarketplaceManifest } from './marketplace-manifest';

/** 终极 fallback —— marketplace manifest 缺 / 解析失败时回到泛用 'root' path。
 *  e2e 测试(`makeSidWithRootAgent`)也走这条 path,保持兼容。 */
export const FALLBACK_BOOTSTRAP_AGENT = 'root';

/** 真正的「默认入口 agent」—— marketplace manifest 里 `default: true` 的那个
 *  agent id(当前是 forge)。读盘成本可忽略,每次建 session 才命中一次。
 *  失败回 root —— 跟 ref agenteam `cmdChat` 拿不到 agent context 时的兜底
 *  policy 同款(不阻塞 session 创建,让用户后续手动 pin)。 */
export function resolveManifestMainAgent(): string {
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

export interface CreateSessionBody {
  displayName?: string;
  defaultModels?: ModelsConfig;
  timezone?: string;
  autoStart?: boolean;
  /** undefined = 解析 manifest 默认 agent;"<name>" 指定;false/''/null = 不 bootstrap。 */
  bootstrapAgent?: string | false | null;
}

/** 建 session(永久绑当前 active game,PR2)+ bootstrap 入口 agent。
 *  与历史 `POST /api/sessions` 路由逐行同义(注释随迁)。 */
export async function createSessionWithBootstrap(
  body: CreateSessionBody,
): Promise<{ sid: string; bootstrappedAgent: string | null }> {
  const sm = getSessionManager();
  // Permanent binding (plan B PR2): the new session is bound to the current
  // active game by the injected SessionLayout (paths.allocate) — its home
  // becomes <games>/<activeSlug>/sessions/<sid>/. No defaultDir is passed/stored.
  const session = await sm.create({
    displayName: body.displayName,
    defaultModels: body.defaultModels,
    timezone: body.timezone,
    autoStart: body.autoStart,
  });
  // **先** scheduler.start() 让它先订阅 tree.onChange,**再** scaffold root
  // —— scaffold 写盘后 FSWatcher 派发 rename → tree.onChange("added") →
  // scheduler.attachAndStart。如果倒过来,写盘那一刻 scheduler 还没订阅,
  // 派发会落空(虽然 start 内同步扫盘 tree.list() 也会 attach root,但保
  // 持事件链单一更易排错)。
  session.scheduler.start();

  // Bootstrap default agent —— 创建 session 时必须先有一个入口 agent,
  // 否则 AgentSwitcher 看到空列表就显示 "agent: 未指定"。语义见 CreateSessionBody。
  let bootstrappedAgent: string | null = null;
  if (body.bootstrapAgent !== false && body.bootstrapAgent !== null && body.bootstrapAgent !== '') {
    const agentPath = typeof body.bootstrapAgent === 'string' ? body.bootstrapAgent : resolveManifestMainAgent();
    try {
      let personaFile: string | undefined;
      let memoryDir: string | undefined;
      let hostTools: string[] | undefined;
      const isSimpleName = !agentPath.includes('/') && !agentPath.includes('#') && isValidAgentName(agentPath);
      if (isSimpleName && agentPath !== FALLBACK_BOOTSTRAP_AGENT) {
        // 走和 messages 端一样的 marketplace 解析。解析失败不阻塞 bootstrap ——
        // 落到 root-style 空 persona 兜底,比拒绝建 session 更顺手。
        try {
          const persona = await resolvePersonaForAgent(agentPath);
          if (persona) {
            personaFile = persona.personaPath;
            memoryDir = persona.memoryDir;
            hostTools = persona.tools;
          }
        } catch (e: any) {
          process.stderr.write(`[sessions] bootstrap persona resolve for '${agentPath}' failed: ${e?.message ?? e}\n`);
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
      process.stderr.write(`[sessions] bootstrap agent '${agentPath}' for ${session.sid} failed: ${err?.message ?? err}\n`);
    }
  }

  return { sid: session.sid, bootstrappedAgent };
}
