/**
 * cbc 内核 e2e —— 验证「chat 真正经 codebuddy(a peer agent CLI Code)内核驱动」。
 * 走真实链路:resolveKernel(=codebuddy) → CbcKernel.runTurn → spawn `codebuddy -p`
 * 真模型(cbc 自管登录) → claude-code-mapper → KernelEvent → runKernelTurn → bus 事件。
 *
 * cbc 自管凭据(~/.codebuddy),**不需要** ANTHROPIC_API_KEY;但需本机已 `codebuddy` 登录。
 * 非 .test.ts(真 CLI + 真模型);手动跑:
 *   FORGEAX_KERNEL_IMPL=codebuddy bun packages/cli/test/cbc-e2e.ts
 * 退出码 = 失败数。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 选 cbc 内核(无 server / 无产品壳:cbc 是 cli-native 子进程内核,ensureRegistered 自注册)。
process.env.FORGEAX_KERNEL_IMPL = 'codebuddy';

// 干净的临时 project root —— cbc 以此为 cwd 运行。理由:从 forgeax-os 仓根直接跑会让
// cbc 吞入巨量噪声上下文(仓库 CLAUDE.md/AGENTS.md + 数万 token),模型行为非确定。
// 指到一个只含 `.forgeax/games/<两个demo>` 的空目录 → 上下文小、行为稳定,且 list_games
// 返回确定数量。必须在 import kernel/compose 前设好(defaultProjectRoot 读此 env)。
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'cbc-e2e-root-'));
for (const g of ['alpha', 'beta']) mkdirSync(join(TMP_ROOT, '.forgeax', 'games', g), { recursive: true });
process.env.FORGEAX_PROJECT_ROOT = TMP_ROOT;

const { runKernelTurn } = await import('../src/core/kernel-turn');
const { resolveKernel, listAvailableKernels } = await import('../src/kernel/resolve-kernel');
const { Hook } = await import('../src/hooks/types');
const { CbcKernel } = await import('../src/kernel/cbc-kernel');
const { randomUUID } = await import('node:crypto');
import type { KernelEvent, TurnRequest } from '@forgeax/agent-runtime';

/** 捕获 eventBus 的文本流(StreamLLM)+ 工具调用名 + 工具执行结果(ToolResult)。 */
function capturingBus() {
  const text: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: Array<{ name: string; ok: boolean; result: string }> = [];
  const bus = {
    hook(event: string, payload: unknown) {
      if (event === Hook.StreamLLM) {
        const chunk = (payload as { chunk?: { type?: string; text?: string; name?: string } }).chunk;
        if (chunk?.type === 'text' && chunk.text) text.push(chunk.text);
        if (chunk?.type === 'tool_call' && chunk.name) toolCalls.push(chunk.name);
      } else if (event === Hook.ToolResult) {
        const p = payload as { name?: string; ok?: boolean; result?: unknown };
        toolResults.push({ name: p.name ?? '', ok: p.ok !== false, result: JSON.stringify(p.result ?? '') });
      }
    },
  };
  return {
    bus: bus as never,
    text: () => text.join(''),
    toolCalls: () => toolCalls,
    toolResults: () => toolResults,
  };
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail: ok ? 'PASS' : detail });

async function safe(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>): Promise<void> {
  try {
    const { ok, detail } = await fn();
    check(name, ok, detail ?? '');
  } catch (e) {
    check(name, false, e instanceof Error ? e.message : String(e));
  }
}

async function main(): Promise<void> {
  // 1) 注册 + 选择:cbc 出现在可用内核列表,且 resolveKernel 命中它。
  await safe('register · listAvailableKernels 含 codebuddy', async () => {
    const ids = listAvailableKernels().map((k) => k.id);
    return { ok: ids.includes('codebuddy'), detail: `kernels=[${ids.join(',')}]` };
  });

  await safe('select · resolveKernel("forge").id === codebuddy', async () => {
    const id = resolveKernel('forge').id;
    return { ok: id === 'codebuddy', detail: `got ${id}` };
  });

  // 2) probe:二进制在 + 已登录。
  await safe('probe · codebuddy 二进制 + 登录就绪', async () => {
    const h = await resolveKernel('forge').probe();
    return { ok: h.ok, detail: h.detail ?? '' };
  });

  // 每个 turn 用**唯一 sessionId** → 确定性 threadId 也唯一 → 每轮都是 fresh `--session-id`,
  // 绝不 resume 上一轮/上次跑遗留的会话。理由:resume 被污染的会话(含 query_world/
  // capture_frame 等需宿主 server 回调的工具调用)在「无 server 的独立 e2e」里会让 cbc
  // 反复重试→30s stream timeout→error_during_execution。fresh 会话则模型直接作答,稳定。
  const runId = `cbc-e2e-${Date.now()}`;

  // 3) 文本 turn:真模型经 cbc 驱动,精确回 token。
  await safe('text turn · cbc → real model → CBC_E2E_OK', async () => {
    const cap = capturingBus();
    const r = await runKernelTurn({
      agentId: 'forge',
      sessionId: `${runId}-text`,
      userText: 'Reply with exactly this token and nothing else: CBC_E2E_OK',
      eventBus: cap.bus,
      signal: new AbortController().signal,
      turn: 0,
    });
    const out = cap.text();
    return { ok: !r.error && out.includes('CBC_E2E_OK'), detail: `err=${r.error} out=${out.slice(0, 120)}` };
  });

  // 4) 工具 turn(直驱内核,确定性):手搭最小 TurnRequest,只暴露 fxt 的 echo 工具 +
  //    hermetic(trustTier='imported' → cbc 加 `--strict-mcp-config --setting-sources ''`,
  //    丢弃用户全局 MCP / 操作系统 settings 噪声),replace 短 charter。提示词要求模型
  //    「调 echo 并原样回其返回串」——echo 返回带 `[forgeax_echo] ` 前缀,模型不调工具
  //    无从产出该前缀,故必然调用。直驱 kernel.runTurn 收集 KernelEvent,断言:
  //    tool.call(echo) + tool.result(ok, 含前缀+token)。这条**最干净地**验证
  //    spawn → cbc-profile argv → fxt MCP → claude-code-mapper → tool 事件 整条链路。
  await safe('tool turn · echo delivered → invoked → executed (fxt MCP round-trip)', async () => {
    const token = `CBCTOK-${randomUUID().slice(0, 8)}`;
    const req: TurnRequest = {
      session: { threadId: randomUUID(), agentId: 'forge' },
      input: {
        text: `Call the echo tool with text set to "${token}". Then reply with EXACTLY the string the tool returned, and nothing else.`,
      },
      systemPrompt: {
        charter: 'You are a terse test agent. When asked to use a tool, call it, then return its result verbatim.',
        persona: '',
        mode: 'replace',
      },
      tools: [{ name: 'echo', description: 'Echo back the given text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
      budget: { maxTurns: 4 },
      trustTier: 'imported',
    };
    const events: KernelEvent[] = [];
    for await (const ev of new CbcKernel().runTurn(req, new AbortController().signal)) events.push(ev);

    // cbc 把 MCP 工具名透出为带前缀的 `mcp__fxt__echo`(非裸 `echo`)。
    const call = events.find((e): e is Extract<KernelEvent, { kind: 'tool.call' }> => e.kind === 'tool.call' && e.name.includes('echo'));
    const result = events.find(
      (e): e is Extract<KernelEvent, { kind: 'tool.result' }> =>
        e.kind === 'tool.result' && e.ok && JSON.stringify(e.result ?? '').includes(`[forgeax_echo] ${token}`),
    );
    const errored = events.some((e) => e.kind === 'error');
    return {
      ok: Boolean(call) && Boolean(result),
      detail: `call=${Boolean(call)} result=${Boolean(result)} kernelError=${errored} token=${token}`,
    };
  });
}

main()
  .then(() => {
    console.log('\n========== cbc 内核 e2e ==========');
    let fails = 0;
    for (const r of results) {
      if (!r.ok) fails++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -- ' + r.detail}`);
    }
    console.log('==================================');
    console.log(`${results.length - fails}/${results.length} passed`);
    process.exit(fails);
  })
  .catch((e) => {
    console.error('e2e crashed:', e);
    process.exit(1);
  });
