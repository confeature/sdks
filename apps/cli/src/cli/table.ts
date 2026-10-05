// SPDX-License-Identifier: MIT

/**
 * A tiny std-lib table renderer for the read commands (spec 181 / #655).
 *
 * It computes each column's width from the header plus the longest cell, then
 * pads every cell to that width so columns align in a fixed-width terminal. It
 * is intentionally minimal — no colour, no truncation, no Unicode box drawing —
 * because the machine-readable surface is `--json` (the raw typed objects),
 * while the table is purely a human convenience.
 *
 * `null`/`undefined` cells render as an empty string so a missing optional field
 * never prints `"null"`. Width is measured in code points (`[...string].length`)
 * so multi-byte names pad correctly for the common case.
 */

/** A column definition: its header label and how to extract a cell from a row. */
export interface Column<T> {
  header: string;
  /** Extract the cell value for `row`; non-string values are stringified. */
  value(row: T): string | number | null | undefined;
}

/** Render `rows` as an aligned, header-topped table. Returns the joined lines. */
export function renderTable<T>(columns: Column<T>[], rows: T[]): string {
  const cells = rows.map((row) => columns.map((col) => cellText(col.value(row))));

  const widths = columns.map((col, i) => {
    const headerWidth = displayWidth(col.header);
    const widest = cells.reduce((max, row) => Math.max(max, displayWidth(row[i])), 0);
    return Math.max(headerWidth, widest);
  });

  const lines: string[] = [];
  lines.push(rowLine(columns.map((c) => c.header), widths));
  // A separator under the header keeps long lists readable.
  lines.push(rowLine(widths.map((w) => "-".repeat(w)), widths));
  for (const row of cells) {
    lines.push(rowLine(row, widths));
  }
  return lines.join("\n");
}

/** Pad each cell to its column width and join with two spaces; trim trailing pad. */
function rowLine(cells: string[], widths: number[]): string {
  return cells
    .map((cell, i) => padEnd(cell, widths[i]))
    .join("  ")
    .replace(/\s+$/, "");
}

/** Stringify a cell value, mapping null/undefined to an empty string. */
function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Code-point display width (good enough for the Latin/identifier common case). */
function displayWidth(text: string): number {
  return [...text].length;
}

/** Right-pad `text` to `width` code points with spaces. */
function padEnd(text: string, width: number): string {
  const deficit = width - displayWidth(text);
  return deficit > 0 ? text + " ".repeat(deficit) : text;
}
