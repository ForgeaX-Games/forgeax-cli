export interface DiffEntry {
  type: "same" | "del" | "add";
  line: string;
  lineNo: number;
}

export function lineDiff(oldText: string, newText: string): DiffEntry[] {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  const minLen = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix++;

  const result: DiffEntry[] = [];
  for (let i = prefix; i < oldLines.length - suffix; i++) {
    result.push({ type: "del", line: oldLines[i], lineNo: i + 1 });
  }
  for (let j = prefix; j < newLines.length - suffix; j++) {
    result.push({ type: "add", line: newLines[j], lineNo: j + 1 });
  }
  return result;
}
