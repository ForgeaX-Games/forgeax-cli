/**
 * Interactive TUI screen ownership.
 *
 * Ink's mutable frame cannot be kept out of the normal terminal scrollback on resize: the terminal
 * may reflow rows into history before SIGWINCH reaches Ink, after which no cursor erase can reach
 * them. Keep the full REPL in DEC's alternate buffer instead. The normal buffer (including the
 * user's shell history) is restored byte-for-byte when the REPL exits.
 *
 * This is deliberately owned by the HOST lifecycle rather than Ink's renderer. The returned cleanup
 * is idempotent so every success/error path can safely call it.
 */

const ESC = String.fromCharCode(27);
export const ENTER_ALTERNATE_SCREEN = `${ESC}[?1049h`;
export const CLEAR_AND_HOME = `${ESC}[2J${ESC}[H`;
export const EXIT_ALTERNATE_SCREEN = `${ESC}[?1049l`;

interface ScreenOutput {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

/** Enter the alternate buffer for a real interactive terminal and return an idempotent restore. */
export function enterAlternateScreen(stdout: ScreenOutput = process.stdout): () => void {
  if (!stdout.isTTY) return () => {};

  let entered = false;
  const restore = () => {
    if (!entered) return;
    entered = false;
    process.off('exit', restore);
    try {
      stdout.write(EXIT_ALTERNATE_SCREEN);
    } catch {
      // Best effort during terminal teardown.
    }
  };

  try {
    // DEC 1049 switches buffers but terminal behavior around the initial cursor position is not
    // uniform (notably terminals that preserve a viewport-relative cursor). Establish full-screen
    // ownership explicitly so Ink's first frame always starts at row 1, column 1.
    stdout.write(`${ENTER_ALTERNATE_SCREEN}${CLEAR_AND_HOME}`);
    entered = true;
    // Covers process.exit() and the default uncaught-exception path in addition to runTui's finally.
    // SIGINT remains owned by Ink/Repl and reaches the same finally path.
    process.once('exit', restore);
  } catch {
    // If the terminal disappeared during startup, rendering/cleanup retain their existing behavior.
  }

  return restore;
}
