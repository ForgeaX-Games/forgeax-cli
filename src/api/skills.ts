/** /api/skills — Phase D4.
 *
 *  GET  /api/skills                  → SkillDescriptor[]
 *  POST /api/skills/run              → JSON one-shot { ok, ... }
 *  POST /api/skills/run-stream       → SSE: skill.starting / tool.* / skill.completed
 *
 *  The streaming endpoint subscribes to `tool.*` and `skill.*` for the
 *  duration of the run so a UI client sees nested tool calls without a
 *  separate /api/events/stream. */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { listSkills, runSkill, type SkillRunRequest, type SkillRunResult } from '../skills/runner';
import { getEventBus, type EventEnvelope } from '../events/bus';

function parseRunBody(body: any): SkillRunRequest | null {
  if (!body || typeof body.skillId !== 'string') return null;
  const caller = body.caller;
  const callerKind = caller?.kind;
  if (!callerKind || !['user', 'ai', 'cli', 'workbench'].includes(callerKind)) return null;
  return {
    skillId: body.skillId,
    pluginId: typeof body.pluginId === 'string' ? body.pluginId : undefined,
    input: body.input,
    caller: {
      kind: callerKind,
      sessionId: typeof caller.sessionId === 'string' ? caller.sessionId : undefined,
      threadId: typeof caller.threadId === 'string' ? caller.threadId : undefined,
      agentId: typeof caller.agentId === 'string' ? caller.agentId : undefined,
    },
  };
}

export function createSkillsRouter() {
  const r = new Hono();

  r.get('/', (c) => c.json({ skills: listSkills() }));

  r.post('/run', async (c) => {
    const body = await c.req.json().catch(() => null);
    const req = parseRunBody(body);
    if (!req) {
      return c.json({ ok: false, error: 'skillId + caller.kind required', code: 'bad_request' }, 400);
    }
    const result: SkillRunResult = await runSkill(req);
    return c.json(result);
  });

  r.post('/run-stream', async (c) => {
    const body = await c.req.json().catch(() => null);
    const req = parseRunBody(body);
    if (!req) {
      return c.json({ ok: false, error: 'skillId + caller.kind required', code: 'bad_request' }, 400);
    }
    return streamSSE(c, async (stream) => {
      const events: EventEnvelope[] = [];
      const flush = async (env: EventEnvelope) => {
        events.push(env);
        await stream.writeSSE({ event: env.topic, data: JSON.stringify(env) });
      };
      const off1 = getEventBus().subscribe('tool.*', flush);
      const off2 = getEventBus().subscribe('skill.*', flush);
      try {
        const result = await runSkill(req);
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) });
      } finally {
        off1();
        off2();
      }
    });
  });

  return r;
}
