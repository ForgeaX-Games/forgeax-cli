import { describe, test, expect } from 'bun:test';
import { createSettingsRouter } from '../src/api/settings';

// PUT /api/settings/env writes only SAFE_ENV_KEYS through to .env, dropping
// everything else. When ZERO recognized keys are present in the body we want
// a structured 400 so the UI can surface "you tried to set FOO but only
// these are writable". Locks the response shape (error + allowed: [N])
// — the Settings drawer parses .allowed[] to render the editable-keys list.
// EXPECTED_ALLOWED_COUNT mirrors SAFE_ENV_KEYS.size in src/api/settings.ts;
// bump it when a new multimodal key joins the allowlist.
// 16 base keys + FORGEAX_UPLOAD_GITHUB_TOKEN + FORGEAX_UPLOAD_REPO +
// FORGEAX_UPLOAD_BRANCH (workspace upload, 2026-07-09; repo is user-configurable —
// users may upload to any repo their token can write, the shared org repo is just
// the default) = 19.
const EXPECTED_ALLOWED_COUNT = 19;
describe('PUT /api/settings/env — SAFE_ENV_KEYS allowlist', () => {
  async function putEnv(body: unknown): Promise<Response> {
    const r = createSettingsRouter();
    return r.fetch(
      new Request('http://test/env', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  }

  test('unknown key → 400 with allowed list', async () => {
    const resp = await putEnv({ FOO: 'bar' });
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error: string; allowed: string[] };
    expect(j.error).toBe('no recognized keys in body');
    expect(j.allowed).toContain('ANTHROPIC_API_KEY');
    expect(j.allowed).toContain('OPENAI_API_KEY');
    expect(j.allowed).toContain('FORGEAX_MODEL');
    expect(j.allowed).toContain('ARK_IMAGE_KEY');
    expect(j.allowed).toContain('DEEPSEEK_API_KEY');
    // workspace upload: token + repo + branch are all writable (2026-07-09)
    expect(j.allowed).toContain('FORGEAX_UPLOAD_GITHUB_TOKEN');
    expect(j.allowed).toContain('FORGEAX_UPLOAD_BRANCH');
    expect(j.allowed).toContain('FORGEAX_UPLOAD_REPO');
    expect(j.allowed.length).toBe(EXPECTED_ALLOWED_COUNT);
  });

  test('empty body → 400 with allowed list', async () => {
    const resp = await putEnv({});
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { allowed: string[] };
    expect(j.allowed.length).toBe(EXPECTED_ALLOWED_COUNT);
  });

  test('non-string value for known key → silently dropped → 400', async () => {
    // settings.ts:129 `if (typeof v !== 'string') continue` so a number value
    // for ANTHROPIC_API_KEY counts as "no touched" and falls into the 400 path.
    const resp = await putEnv({ ANTHROPIC_API_KEY: 42 });
    expect(resp.status).toBe(400);
  });

  test('invalid json body → 400 (caught at parse)', async () => {
    const r = createSettingsRouter();
    const resp = await r.fetch(
      new Request('http://test/env', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: 'not json {{{',
      }),
    );
    expect(resp.status).toBe(400);
    const j = (await resp.json()) as { error: string };
    expect(j.error).toBe('invalid json');
  });
});
