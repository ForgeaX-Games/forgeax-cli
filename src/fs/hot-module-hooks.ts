// @desc ESM loader hooks — propagate cache-bust params to transitive deps

/**
 * When a parent module URL carries a cache-bust query param (?t= or ?v=),
 * propagate it to all child file:// imports (excluding node_modules).
 * This makes BaseLoader's ?t= cache bust work transitively through lib files.
 */
export async function resolve(
  specifier: string,
  context: { parentURL?: string; [k: string]: unknown },
  nextResolve: Function,
): Promise<{ url: string; [k: string]: unknown }> {
  const result = await nextResolve(specifier, context);

  if (context.parentURL) {
    const parent = new URL(context.parentURL);
    const bust = parent.searchParams.get("t") ?? parent.searchParams.get("v");
    if (bust) {
      const child = new URL(result.url);
      if (child.protocol === "file:" && !child.pathname.includes("/node_modules/")) {
        child.searchParams.set("v", bust);
        return { ...result, url: child.href };
      }
    }
  }

  return result;
}

/**
 * Strip ?t= and ?v= before passing to the next loader (tsx).
 * tsx uses fileURLToPath() which may choke on query params.
 * Node.js still uses the full URL (with params) as the module cache key.
 */
export async function load(
  url: string,
  context: { [k: string]: unknown },
  nextLoad: Function,
): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.searchParams.has("t") || parsed.searchParams.has("v")) {
    parsed.searchParams.delete("t");
    parsed.searchParams.delete("v");
    return nextLoad(parsed.href, context);
  }
  return nextLoad(url, context);
}
