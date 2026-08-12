/**
 * CSV, read and written, for every panel that exports a listing or sends a file of rows.
 *
 * It was private to the Azure Table panel until a queue and an object listing needed the same two
 * operations, and re-deriving RFC 4180 quoting per panel is how two exports drift: one of them
 * doubles the quotes, the other escapes them with a backslash, and the file that round-trips through
 * this app stops round-tripping through the next one.
 *
 * What is *not* here is any notion of what a row means. Which columns an export carries, which
 * fields an import is allowed to send back and which of them the service owns are questions about a
 * service, answered where that service lives — this side only knows strings and commas.
 */

/** RFC 4180: quote anything containing a comma, a quote or a newline, and double the quotes. */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A header row and a grid of cells, as one CSV document.
 *
 * Cells rather than objects: the caller has already decided what each column's text is — the same
 * definition the grid drew and the auto-fit measured — and handing this function the rows instead
 * would make it guess that again and export something the screen never showed.
 */
export function toCsv(header: string[], rows: (string | null)[][]): string {
  const lines = [header.map((column) => csvCell(column)).join(",")];
  for (const row of rows) lines.push(row.map((cell) => csvCell(cell)).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * A CSV into a grid of strings. Quote-aware, `\r\n` is one break, blank lines skipped.
 *
 * Written out rather than split on commas because a key holding a path — which is most of them on
 * the tables people actually keep — contains commas, and a naive split turns one row into three
 * columns of nonsense. Values stay strings: what a `007` is depends on the service being written to,
 * and guessing that it is the number seven is how a key stops matching.
 */
export function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character === '"') {
        if (text[at + 1] === '"') {
          cell += '"';
          at += 1;
        } else quoted = false;
      } else cell += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      // A `\r\n` is one break, not two.
      if (character === "\r" && text[at + 1] === "\n") at += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  // Whatever the last line left behind, for a file that doesn't end in a newline.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A row of nothing but empty cells is a blank line, and a blank line in the middle of a CSV is
  // formatting rather than a record.
  return rows.filter((one) => one.some((value) => value !== ""));
}
