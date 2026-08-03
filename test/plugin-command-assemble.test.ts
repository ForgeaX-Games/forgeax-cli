import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleCapabilities } from '../src/runtime/assemble';
import { EventBus } from '../src/events/event-bus';

const tmp = mkdtempSync(join('/tmp', 'forgeax-plugin-command-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('plugin command integration', () => {
  test('plugin commands enter the shared Skill dispatcher', async () => {
    const pluginsRoot = join(tmp, 'plugins');
    const pluginRoot = join(pluginsRoot, 'example-plugin');
    const commandsRoot = join(pluginRoot, 'commands');
    mkdirSync(commandsRoot, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ name: 'example-plugin', version: '0.1.0' }),
    );
    writeFileSync(
      join(commandsRoot, 'from-plugin.md'),
      'Respond with exactly PLUGIN_COMMAND_OK.',
    );

    const assembled = await assembleCapabilities({
      bus: new EventBus(),
      pluginSources: [{ source: 'session', dir: pluginsRoot }],
    });
    try {
      const skill = assembled.tools.find((tool) => tool.name === 'Skill');
      expect(skill).toBeDefined();
      const schema = skill!.inputJSONSchema as {
        properties?: { skill?: { description?: string } };
      };
      expect(String(schema.properties?.skill?.description)).toContain(
        'from-plugin',
      );
      const result = await skill!.call(
        { skill: 'from-plugin' },
        { signal: new AbortController().signal } as never,
      );
      expect(result.data).toMatchObject({
        success: true,
        commandName: 'from-plugin',
        status: 'inline',
      });
      expect((result.data as { prompt: string }).prompt).toContain(
        'PLUGIN_COMMAND_OK',
      );
    } finally {
      for (const dispose of assembled.disposers) await dispose();
    }
  });
});
