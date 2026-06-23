/** name-lookup —— qualified-or-bare 名字匹配。
 *
 *  Kit / tool / directive 在 registry 里是 `pkg/kind/name` 的全名，但 LLM 看到
 *  的（以及 tool_call 里写回来的）是 bare 末段；当末段在 registry 里唯一时直接命中。
 *
 *  与 agenteam ref 1:1（micro-compaction 找 ToolDefinition.compactResult 时用）。 */

export function bareName(qualified: string): string {
  const i = qualified.lastIndexOf("/");
  return i >= 0 ? qualified.slice(i + 1) : qualified;
}

/** Find by exact qualified name 优先；否则 unique bare 匹配；多于一个 bare 命中
 *  视为 ambiguous → undefined。 */
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
