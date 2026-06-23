/** Kit name helpers — qualified ↔ bare resolution.
 *
 *  Kit items are stored under qualified `kit/kind/name`. The LLM sees the bare
 *  last segment when it's unique across the loaded set, otherwise the full
 *  qualified name. Lookups therefore accept either form.
 *
 *  Ported 1:1 from agenteam-os-ref/src/registries/name-lookup.ts. */

/** Extract the bare name from `kit/kind/name` (no slash → returned as-is). */
export function bareName(qualified: string): string {
  const i = qualified.lastIndexOf("/");
  return i >= 0 ? qualified.slice(i + 1) : qualified;
}

/**
 * Find an item by qualified-or-bare-when-unique name. Direct hit wins;
 * bare match must be unambiguous (returns undefined if multiple items
 * share the same bare name).
 */
export function findByName<T extends { name: string }>(
  items: Iterable<T>,
  name: string,
): T | undefined {
  let bareMatch: T | undefined;
  let ambiguous = false;
  for (const item of items) {
    if (item.name === name) return item;
    if (bareName(item.name) === name) {
      if (bareMatch !== undefined) ambiguous = true;
      else bareMatch = item;
    }
  }
  return ambiguous ? undefined : bareMatch;
}
