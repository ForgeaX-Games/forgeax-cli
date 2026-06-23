/** GameDirResolutionError —— structured error for game-directory resolution failures.
 *
 *  Error codes:
 *    GAME_NOT_FOUND  — slug resolves to a path but the directory does not exist.
 *    INVALID_SLUG    — slug contains illegal characters (/, \, ..) rejected by safeSegment.
 *
 *  Structure example:
 *    new GameDirResolutionError('GAME_NOT_FOUND', '/tmp/.forgeax/games/nosuch', null,
 *      'Recreate game or switch session');
 *    // → code='GAME_NOT_FOUND', expected='/tmp/...', actual=null, hint='Recreate...'
 *
 *    new GameDirResolutionError('INVALID_SLUG', '<root>/.forgeax/games/<slug>',
 *      '../escape', 'Use only [a-z0-9-]');
 *    // → code='INVALID_SLUG', expected='<root>/.forgeax/games/<slug>',
 *    //   actual='../escape', hint='Use only [a-z0-9-]'
 *
 *  AI-user contract (charter P3):
 *    Consumers branch on `err.code` (property access, not string-match on message).
 *    Fields are ordered code → hint → expected → actual for progressive disclosure.
 */

export class GameDirResolutionError extends Error {
  /** Machine-readable category: GAME_NOT_FOUND | INVALID_SLUG. */
  readonly code: "GAME_NOT_FOUND" | "INVALID_SLUG";
  /** Absolute path the resolver expected to find / produce. */
  readonly expected: string;
  /** Raw user-supplied input (INVALID_SLUG) or null (GAME_NOT_FOUND). */
  readonly actual: string | null;
  /** Actionable hint suitable for feeding into downstream LLM prompts. */
  readonly hint: string;

  constructor(
    code: "GAME_NOT_FOUND" | "INVALID_SLUG",
    expected: string,
    actual: string | null,
    hint: string,
  ) {
    super(`GameDirResolutionError[${code}]: ${hint} (expected: ${expected})`);
    this.name = "GameDirResolutionError";
    this.code = code;
    this.expected = expected;
    this.actual = actual;
    this.hint = hint;
  }
}