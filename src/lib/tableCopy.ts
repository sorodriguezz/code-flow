import { toCsv } from "./csv";

/** The cells of a rendered table as text, header row first. */
export function tableGrid(table: { rows: ArrayLike<{ cells: ArrayLike<{ textContent: string | null }> }> }): string[][] {
  return Array.from(table.rows).map((row) => Array.from(row.cells).map((cell) => (cell.textContent ?? "").trim()));
}

/** A GitHub-flavoured Markdown table; the first row is the header. */
export function gridToMarkdown(grid: string[][]): string {
  if (grid.length === 0) return "";
  const width = Math.max(...grid.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => (row[i] ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ")).join(" | ")} |`;
  return [line(grid[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...grid.slice(1).map(line)].join("\n");
}

export function gridToCsv(grid: string[][]): string {
  return grid.length === 0 ? "" : toCsv(grid[0], grid.slice(1));
}
