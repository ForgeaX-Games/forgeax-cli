/**
 * cursor-kernel 真实 e2e —— 驱动本机已登录的 `cursor-agent`,验证首条消息提速修复:
 *  1. 首轮不再 spawn 冗余 `create-chat`(省 ~2s 冷启);turn 流自带 session_id 被回填。
 *  2. charter/persona 在首轮真注入(修了「预铸 id 让 isFirstTurn 恒 false → 不注入」)。
 *  3. 第二轮 `--resume` 真续接(记得首轮事实)。
 *
 * 跑:`bun test/cursor-kernel-e2e.ts`(需本机 `cursor-agent login` 已完成)。
 * 非 bun:test —— 自管时序/日志,真模型,不进 CI。
 */
import { CursorKernel } from '../src/kernel/cursor-kernel';
import type { TurnRequest, KernelEvent } from '@forgeax/agent-runtime';

const MARKER = 'ZX9Q7';
const FAV = 'forty-two (42)';

function makeReq(threadId: string, text: string): TurnRequest {
  return {
    session: { threadId, agentId: 'forge' },
    callId: `${threadId}-${Date.now()}`,
    input: { text },
    systemPrompt: {
      charter: `You are a terse test assistant. RULE: end EVERY reply with the exact marker "${MARKER}" on its own line.`,
      persona: '',
    },
    tools: [],
    budget: {},
  };
}

async function drainTurn(
  kernel: CursorKernel,
  req: TurnRequest,
): Promise<{ text: string; events: string[]; ms: number; done?: string; error?: string }> {
  const ac = new AbortController();
  const t0 = performance.now();
  let text = '';
  const events: string[] = [];
  let done: string | undefined;
  let error: string | undefined;
  for await (const ev of kernel.runTurn(req, ac.signal) as AsyncIterable<KernelEvent>) {
    events.push(ev.kind);
    if (ev.kind === 'message.delta') text += ev.text;
    else if (ev.kind === 'turn.done') done = ev.reason;
    else if (ev.kind === 'error') error = ev.error?.message;
  }
  return { text, events, ms: Math.round(performance.now() - t0), done, error };
}

const ok = (b: boolean) => (b ? '✅ PASS' : '❌ FAIL');
let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (!cond) failures++;
  console.log(`${ok(cond)} — ${label}${extra !== undefined ? `  ·  ${JSON.stringify(extra)}` : ''}`);
}

async function main(): Promise<void> {
  const kernel = new CursorKernel();

  console.log('— probe —');
  const health = await kernel.probe();
  console.log('  health:', health);
  if (!health.ok) {
    console.error('cursor-agent not ready — run `cursor-agent login` first. Aborting e2e.');
    process.exit(2);
  }

  const threadId = `e2e-cursor-${Date.now()}`;

  console.log('\n— TURN 1 (first message; no create-chat pre-spawn) —');
  const r1 = await drainTurn(kernel, makeReq(threadId, `My favorite number is ${FAV}. Acknowledge in one short sentence.`));
  console.log(`  ${r1.ms}ms · done=${r1.done} · events=${r1.events.join(',')}`);
  console.log(`  reply: ${JSON.stringify(r1.text.slice(0, 200))}`);
  if (r1.error) console.log(`  error: ${r1.error}`);

  check('turn 1 completed (stop)', r1.done === 'stop', { done: r1.done });
  check('turn 1 produced assistant text', r1.text.trim().length > 0);
  check('turn 1 INJECTED charter (reply contains marker — the bug we fixed)', r1.text.includes(MARKER), {
    marker: MARKER,
    seen: r1.text.includes(MARKER),
  });

  console.log('\n— TURN 2 (same thread; must --resume the captured session_id) —');
  const r2 = await drainTurn(kernel, makeReq(threadId, 'What is my favorite number? Answer with just the number.'));
  console.log(`  ${r2.ms}ms · done=${r2.done} · events=${r2.events.join(',')}`);
  console.log(`  reply: ${JSON.stringify(r2.text.slice(0, 200))}`);
  if (r2.error) console.log(`  error: ${r2.error}`);

  // 暴露内部 threadId→cursor chatId 映射,确认首轮 system.init 的 id 真被回填(供 resume)。
  const captured = (kernel as unknown as { threadToCursor: Map<string, string> }).threadToCursor.get(threadId);
  check('turn 1 captured cursor chat id from system.init (for --resume)', Boolean(captured), { captured });

  check('turn 2 completed (stop)', r2.done === 'stop', { done: r2.done });
  check('turn 2 RESUMED context (recalls "42" from turn 1)', /42|forty-two/i.test(r2.text), {
    reply: r2.text.slice(0, 80),
  });

  console.log(`\n— timing —\n  turn1=${r1.ms}ms  turn2=${r2.ms}ms`);
  console.log('  (turn1 no longer carries the extra ~2s create-chat cold-start spawn)');

  console.log(`\n${failures === 0 ? '🎉 ALL PASS' : `💥 ${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e crashed:', e);
  process.exit(3);
});
