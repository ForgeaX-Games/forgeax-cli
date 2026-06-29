import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReelGame } from '../src/api/workbench';

// Locks the package-endpoint routing decision (POST /games/:slug/package):
// a game dir whose reel/scenarios.json has a non-empty activeId is an
// interactive film-game → packaged by the reel bundler; everything else
// stays on the 3D engine build-standalone path. isReelGame is the pure
// detector the route branches on.

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reel-pkg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeScenarios(db: unknown): void {
  mkdirSync(join(dir, 'reel'), { recursive: true });
  writeFileSync(join(dir, 'reel', 'scenarios.json'), JSON.stringify(db));
}

describe('isReelGame', () => {
  test('true when reel/scenarios.json has a non-empty activeId', () => {
    writeScenarios({ version: 1, activeId: 'scn-abc', items: [{ id: 'scn-abc' }] });
    expect(isReelGame(dir)).toBe(true);
  });

  test('false when activeId is null (no active scenario)', () => {
    writeScenarios({ version: 1, activeId: null, items: [] });
    expect(isReelGame(dir)).toBe(false);
  });

  test('false when activeId is an empty string', () => {
    writeScenarios({ version: 1, activeId: '', items: [] });
    expect(isReelGame(dir)).toBe(false);
  });

  test('false when there is no reel/ dir at all (3D engine game)', () => {
    expect(isReelGame(dir)).toBe(false);
  });

  test('false when scenarios.json is malformed JSON', () => {
    mkdirSync(join(dir, 'reel'), { recursive: true });
    writeFileSync(join(dir, 'reel', 'scenarios.json'), '{ not json');
    expect(isReelGame(dir)).toBe(false);
  });
});
