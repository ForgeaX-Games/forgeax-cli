export interface DiffEntry {
  type: "same" | "del" | "add";
  line: string;
  /** 1-based line number: old text line for "del"/"same", new text line for "add" */
  lineNo: number;
}

/**
 * Compute a line-level diff between two text blocks.
 *
 * Strategy: strip common prefix/suffix lines, then show the middle section
 * as grouped deletions followed by additions. This is O(n) and produces
 * clean, predictable diffs for the typical edit_file use case (localized
 * replacement within a larger block).
 */
export function lineDiff(oldText: string, newText: string): DiffEntry[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  // Common prefix
  const minLen = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }

  // Common suffix (not overlapping with prefix)
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const result: DiffEntry[] = [];

  // Deletions (old middle)
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    result.push({ type: "del", line: oldLines[i], lineNo: i + 1 });
  }

  // Additions (new middle)
  for (let j = prefix; j < newLines.length - suffix; j++) {
    result.push({ type: "add", line: newLines[j], lineNo: j + 1 });
  }

  return result;
}
