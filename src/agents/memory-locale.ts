/** Locale-aware selection of long-term-memory files.
 *
 *  Memory files in an agent's `memoryDir` may ship in language variants that
 *  mirror the persona convention (`persona/zh.md` / `persona/en.md`):
 *
 *    lessons.zh.md   ← Chinese variant
 *    lessons.en.md   ← English variant
 *    lessons.md      ← legacy / language-neutral (still honoured)
 *
 *  Both the runtime prompt assemblers (persona `memory` slot + agent loader)
 *  and the wb-agent-persona viewer must pick exactly ONE file per base so a
 *  bilingual agent never gets both languages injected into the same prompt.
 *  This module is the single source of truth for that grouping so the two
 *  runtime paths stay in lockstep.
 */

export type MemLang = "en" | "zh";

/** Split a memory filename into its base and language variant.
 *  `lessons.en.md` → { base: "lessons", lang: "en" }
 *  `AGENTS.md`     → { base: "AGENTS",  lang: null } (neutral / legacy) */
export function parseMemoryFilename(name: string): {
  base: string;
  lang: MemLang | null;
} {
  const m = name.match(/^(.*)\.(en|zh)\.md$/i);
  if (m) return { base: m[1], lang: m[2].toLowerCase() as MemLang };
  return { base: name.replace(/\.md$/i, ""), lang: null };
}

/** Normalize an arbitrary locale hint to a supported memory language. */
export function toMemLang(hint: string | null | undefined): MemLang {
  return hint === "en" ? "en" : "zh";
}

/** Derive the memory language from an agent's `personaFile` path, so long-term
 *  memory follows the same language the persona was scaffolded in. Defaults to
 *  `zh` (the historical default) when the path is missing or language-neutral. */
export function memLangFromPersonaFile(personaFile: string | undefined): MemLang {
  if (personaFile && /(^|[\\/])en\.md$/i.test(personaFile.trim())) return "en";
  return "zh";
}

/** From the raw `.md` filenames in a memoryDir, pick exactly one file per base:
 *  prefer the requested language, then the neutral/legacy `base.md`, then the
 *  other language. Returns filenames sorted by base for stable prompt ordering. */
export function pickMemoryFilesForLang(
  mdFiles: string[],
  lang: MemLang,
): string[] {
  const byBase = new Map<string, Partial<Record<MemLang | "neutral", string>>>();
  for (const f of mdFiles) {
    if (!f.toLowerCase().endsWith(".md")) continue;
    const { base, lang: l } = parseMemoryFilename(f);
    const slot = byBase.get(base) ?? {};
    slot[l ?? "neutral"] = f;
    byBase.set(base, slot);
  }
  const other: MemLang = lang === "en" ? "zh" : "en";
  const chosen: string[] = [];
  for (const base of [...byBase.keys()].sort()) {
    const slot = byBase.get(base)!;
    const pick = slot[lang] ?? slot.neutral ?? slot[other];
    if (pick) chosen.push(pick);
  }
  return chosen;
}
