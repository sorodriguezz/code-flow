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
export function bufferText(rows: TextRows): string {
  const lines: string[] = [];
  for (let y = 0; y < rows.length; y++) {
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
