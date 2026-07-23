import { afterEach, describe, expect, test } from 'bun:test';
import {
  CLEAR_AND_HOME,
  ENTER_ALTERNATE_SCREEN,
  EXIT_ALTERNATE_SCREEN,
  enterAlternateScreen,
} from '../../src/tui/alternate-screen';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('alternate screen lifecycle', () => {
  test('real TTY enters once and idempotently restores', () => {
    const writes: string[] = [];
    const restore = enterAlternateScreen({ isTTY: true, write: chunk => writes.push(chunk) });
    cleanups.push(restore);

    expect(writes).toEqual([`${ENTER_ALTERNATE_SCREEN}${CLEAR_AND_HOME}`]);
    restore();
    restore();
    expect(writes).toEqual([`${ENTER_ALTERNATE_SCREEN}${CLEAR_AND_HOME}`, EXIT_ALTERNATE_SCREEN]);
  });

  test('non-TTY output is untouched', () => {
    const writes: string[] = [];
    const restore = enterAlternateScreen({ isTTY: false, write: chunk => writes.push(chunk) });
    restore();
    expect(writes).toEqual([]);
  });

  test('process exit fallback restores a still-owned screen', () => {
    const writes: string[] = [];
    const restore = enterAlternateScreen({ isTTY: true, write: chunk => writes.push(chunk) });
    cleanups.push(restore);

    process.emit('exit', 0);
    expect(writes).toEqual([`${ENTER_ALTERNATE_SCREEN}${CLEAR_AND_HOME}`, EXIT_ALTERNATE_SCREEN]);
  });
});
