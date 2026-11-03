/**
 * Minimal line diff for change previews (DESIGN 8.4).
 *
 * A rename touches a few lines, so a plain LCS is enough. Large inputs fall
 * back to common-prefix/suffix detection: the counts stay honest, the unified
 * text is marked truncated instead of pretending to be complete.
 */

export interface LineDiff {
  added: number;
  removed: number;
  /** Unified diff with 3 context lines, empty when content is identical. */
  unified: string;
  truncated: boolean;
}

const MAX_LCS_LINES = 1_500;
const MAX_UNIFIED_CHARS = 20_000;

export function diffLines(before: string, after: string): LineDiff {
  if (before === after) return { added: 0, removed: 0, unified: "", truncated: false };
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length > MAX_LCS_LINES || afterLines.length > MAX_LCS_LINES) {
    return coarseDiff(beforeLines, afterLines);
  }

  const rows = beforeLines.length;
  const columns = afterLines.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lcs[row][column] =
        beforeLines[row] === afterLines[column]
          ? lcs[row + 1][column + 1] + 1
          : Math.max(lcs[row + 1][column], lcs[row][column + 1]);
    }
  }

  type Op = { kind: " " | "-" | "+"; text: string; beforeLine: number; afterLine: number };
  const ops: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (beforeLines[row] === afterLines[column]) {
      ops.push({ kind: " ", text: beforeLines[row], beforeLine: row, afterLine: column });
      row += 1;
      column += 1;
    } else if (lcs[row + 1][column] >= lcs[row][column + 1]) {
      ops.push({ kind: "-", text: beforeLines[row], beforeLine: row, afterLine: column });
      row += 1;
    } else {
      ops.push({ kind: "+", text: afterLines[column], beforeLine: row, afterLine: column });
      column += 1;
    }
  }
  while (row < rows) {
    ops.push({ kind: "-", text: beforeLines[row], beforeLine: row, afterLine: column });
    row += 1;
  }
  while (column < columns) {
    ops.push({ kind: "+", text: afterLines[column], beforeLine: row, afterLine: column });
    column += 1;
  }

  const added = ops.filter((op) => op.kind === "+").length;
  const removed = ops.filter((op) => op.kind === "-").length;
  const changed = ops
    .map((op, position) => ({ op, position }))
    .filter(({ op }) => op.kind !== " ")
    .map(({ position }) => position);
  if (changed.length === 0) return { added, removed, unified: "", truncated: false };

  const include = new Set<number>();
  for (const position of changed) {
    for (let offset = -3; offset <= 3; offset += 1) {
      const next = position + offset;
      if (next >= 0 && next < ops.length) include.add(next);
    }
  }
  const lines: string[] = [];
  let previous = -2;
  for (const position of [...include].sort((left, right) => left - right)) {
    if (position !== previous + 1) {
      const op = ops[position];
      lines.push(`@@ -${op.beforeLine + 1} +${op.afterLine + 1} @@`);
    }
    lines.push(`${ops[position].kind}${ops[position].text}`);
    previous = position;
  }
  let unified = lines.join("\n");
  let truncated = false;
  if (unified.length > MAX_UNIFIED_CHARS) {
    unified = `${unified.slice(0, MAX_UNIFIED_CHARS)}\n[diff truncated]`;
    truncated = true;
  }
  return { added, removed, unified, truncated };
}

function coarseDiff(beforeLines: string[], afterLines: string[]): LineDiff {
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = beforeLines.length - prefix - suffix;
  const added = afterLines.length - prefix - suffix;
  const removedText = beforeLines.slice(prefix, beforeLines.length - suffix).slice(0, 40);
  const addedText = afterLines.slice(prefix, afterLines.length - suffix).slice(0, 40);
  const unified = [
    `@@ -${prefix + 1},${removed} +${prefix + 1},${added} @@`,
    ...removedText.map((line) => `-${line}`),
    ...addedText.map((line) => `+${line}`),
    "[diff truncated]",
  ].join("\n");
  return { added, removed, unified, truncated: true };
}
