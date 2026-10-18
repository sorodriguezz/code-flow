/**
 * The rows of an xterm buffer, as `bufferText` reads them — `IBuffer`'s shape narrowed to what the
 * join needs, so it can be checked without a terminal.
 */
export interface TextRows {
  readonly length: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/** What `TerminalPane` prints when the process behind a pane ends — the pane's words, not the program's. */
const EXIT_LINE = "[process exited]";

/**
 * A terminal's whole buffer — scrollback and screen — as the text the program printed.
 *
 * xterm keeps rows, not lines: a line longer than the pane is split over several rows, each one
 * after the first marked `isWrapped`. Copied row by row, a stack trace comes out broken at whatever
 * width the dock had; joined back, it comes out as it was written, whatever the pane's size. A row
 * that continues on the next keeps its trailing spaces (they are the middle of a line); the rest
 * lose theirs, and the blank rows under the last line — the screen's unused height — are dropped,
 * along with the pane's own "[process exited]".
 */
export function bufferText(rows: TextRows, lastLines?: number): string {
  const lines: string[] = [];
  for (let y = firstRow(rows, lastLines); y < rows.length; y++) {
    const row = rows.getLine(y);
    if (!row) continue;
    const continues = rows.getLine(y + 1)?.isWrapped === true;
    const text = row.translateToString(!continues);
    if (row.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const dropBlankTail = () => {
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  };
  dropBlankTail();
  if (lines[lines.length - 1] === EXIT_LINE) {
    lines.pop();
    dropBlankTail();
  }
  return lines.join("\n");
}

/**
 * Where to start reading for roughly the last `lastLines` lines — `0` for the whole buffer.
 *
 * The restore snapshot keeps a few hundred lines per terminal, and reading all 10 000 rows of
 * scrollback of every terminal every fifteen seconds to throw almost all of them away was the
 * dock's biggest idle cost under a chatty dev server. Walked back from the end counting line starts
 * (rows that are not a wrap's continuation), with room to spare for the blank screen rows under the
 * last line, which the join drops.
 */
function firstRow(rows: TextRows, lastLines?: number): number {
  if (!lastLines) return 0;
  let starts = 0;
  for (let y = rows.length - 1; y > 0; y--) {
    if (rows.getLine(y)?.isWrapped) continue;
    if (++starts >= lastLines + 256) return y;
  }
  return 0;
}
