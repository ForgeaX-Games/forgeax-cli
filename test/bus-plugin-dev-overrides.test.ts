import { describe, expect, it } from 'bun:test';
import { applyPluginDevPortOverridesForTest } from '../src/api/bus';

describe('bus plugin dev port overrides', () => {
  it('overrides standalone ports by plugin id only', () => {
    const items = applyPluginDevPortOverridesForTest(
      [
        {
          id: '@forgeax-plugin/wb-scene-generator',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { zh: 'scene' },
          entry: { standalone: { start: 'pnpm dev', port: 9555, readyProbe: '/', embeddedAlso: false } },
        },
        {
          id: '@forgeax-plugin/wb-3d-lowpoly',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { zh: 'lowpoly' },
          entry: { standalone: { start: 'pnpm dev', port: 9565, readyProbe: '/', embeddedAlso: false } },
        },
      ],
      {
        plugins: {
          '@forgeax-plugin/wb-scene-generator': { frontendPort: 9755, backendPort: 9757 },
        },
      },
    );

    expect(items[0].entry?.standalone?.port).toBe(9755);
    expect(items[1].entry?.standalone?.port).toBe(9565);
  });
});
