/** /api/tools — Phase D1.
 *
 *  GET  /api/tools          → ToolDescriptor[] (catalog)
 *  POST /api/tools/call     → { toolId, args, caller? } body → ToolResult
 *
 *  ToolCall.caller defaults to `{ kind:'user' }` when omitted, mirroring the
 *  Settings · Tools palette entry point. AI sub-process callers (cli driver
 *  + skill runner in D4) MUST set caller.kind='ai' explicitly so the
 *  exposedToAI gate in registry.callTool() applies. */
import { Hono } from 'hono';
import { z } from 'zod';
import { ToolCallSchema } from '@forgeax/types';
import { callTool, listTools } from '../tools/registry';
import { getEventBus } from '../events/bus';

/** D-8: body schema for POST /api/tools/confirm */
const ConfirmBodySchema = z.object({
  token: z.string(),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
});

export function createToolsRouter() {
  const r = new Hono();

  r.get('/', (c) => c.json({ tools: listTools() }));

  r.post('/call', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ ok: false, error: 'JSON body required', code: 'bad_request' }, 400);
    }
    const merged = {
      toolId: body.toolId,
      args: body.args,
      caller: body.caller ?? { kind: 'user' },
    };
    const parsed = ToolCallSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join('; '), code: 'bad_request' },
        400,
      );
    }
    const result = await callTool(parsed.data);
    return c.json(result);
  });

  /** 07 §9.5 — host UI posts here after the user clicks Allow / Deny on a
   *  `tool.confirm-required` toast. Body: { token, decision, reason? }.
   *  We just relay onto the bus; ToolRegistry.awaitConfirm() is already
   *  subscribed (D-8). */
  r.post('/confirm', async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = ConfirmBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join('; '), code: 'bad_request' },
        400,
      );
    }
    const { token, decision, reason } = parsed.data;
    getEventBus().emit('tool.confirm-acked', { token, decision, reason });
    return c.json({ ok: true });
  });

  return r;
}
