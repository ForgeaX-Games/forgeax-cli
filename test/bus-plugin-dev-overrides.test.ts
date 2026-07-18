import { describe, expect, it } from 'bun:test';
import { applyExtensionDevPortOverridesForTest } from '../src/extensions/slim-list';

describe('bus plugin dev port overrides', () => {
  it('overrides standalone ports by plugin id only', () => {
    const items = applyExtensionDevPortOverridesForTest(
      [
        {
          id: '@forgeax-extension/wb-scene-generator',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { zh: 'scene' },
          entry: { standalone: { start: 'pnpm dev', port: 9555, readyProbe: '/', embeddedAlso: false } },
        },
        {
          id: '@forgeax-extension/wb-3d-lowpoly',
          version: '0.1.0',
          kind: 'workbench',
          displayName: { zh: 'lowpoly' },
          entry: { standalone: { start: 'pnpm dev', port: 9565, readyProbe: '/', embeddedAlso: false } },
        },
      ],
      {
        plugins: {
          '@forgeax-extension/wb-scene-generator': { frontendPort: 9755, backendPort: 9757 },
        },
      },
    );

    expect(items[0].entry?.standalone?.port).toBe(9755);
    expect(items[1].entry?.standalone?.port).toBe(9565);
  });
});
