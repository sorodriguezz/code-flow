/**
 * Conflict markers, as the three-way editor reads and resolves them.
 *
 * The editor's result pane is the file as it will be written — git's markers included until each
 * conflict is settled — so every per-conflict action is a text edit on it: find the block the cursor
 * (or "next conflict") is on, replace the block with the side chosen. Doing it on the text rather than
 * on a separate model of "conflict 3 is resolved as theirs" is what keeps manual edits and the
 * buttons from disagreeing: whatever the user typed is simply what the next parse sees.
 *
 * Both marker styles are read: git's default (`<<<<<<<`, `=======`, `>>>>>>>`) and diff3/zdiff3, which
 * adds a `|||||||` base section. A block has to be complete and in order to count; a stray
 * `=======` — a Markdown heading's underline, say — outside one is left alone.
 */

export interface ConflictBlock {
  /** 0-based line of the `<<<<<<<` marker. */
  startLine: number;
  /** 0-based line of the `>>>>>>>` marker. */
  endLine: number;
  ours: string[];
  /** `null` when the markers carry no base section (git's default style). */
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

export type ConflictChoice = "ours" | "theirs" | "both-ours-first" | "both-theirs-first";

function marker(line: string, char: string): string | null {
  const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
  const run = char.repeat(7);
  if (!bare.startsWith(run)) return null;
  const rest = bare.slice(7);
  // Exactly seven: an eighth `<` is someone's text, and a label is separated by a space.
  if (rest === "") return "";
  if (rest.startsWith(" ")) return rest.slice(1);
  return null;
}

/** The text's line terminator — CRLF when most of its lines end in one. */
export function lineEnding(text: string): "\n" | "\r\n" {
  const lf = (text.match(/\n/g) ?? []).length;
  const crlf = (text.match(/\r\n/g) ?? []).length;
  return lf > 0 && crlf * 2 > lf ? "\r\n" : "\n";
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function parseConflicts(text: string): ConflictBlock[] {
  const lines = splitLines(text);
  const blocks: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const oursLabel = marker(lines[i], "<");
    if (oursLabel === null) {
      i += 1;
      continue;
    }
    const start = i;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let section: "ours" | "base" | "theirs" = "ours";
    let end = -1;
    let theirsLabel = "";
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (section !== "theirs" && marker(line, "<") !== null) break; // a new block before this one ended
      if (section === "ours" && marker(line, "|") !== null) {
        section = "base";
        base = [];
        continue;
      }
      if (section !== "theirs" && marker(line, "=") === "") {
        section = "theirs";
        continue;
      }
      if (section === "theirs") {
        const label = marker(line, ">");
        if (label !== null) {
          end = j;
          theirsLabel = label;
          break;
        }
      }
      const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (section === "ours") ours.push(bare);
      else if (section === "base") base?.push(bare);
      else theirs.push(bare);
    }
    if (end === -1) {
      // Incomplete: not a conflict. Resume right after its opening line, so a real block that
      // follows is still found.
      i = start + 1;
      continue;
    }
    blocks.push({ startLine: start, endLine: end, ours, base, theirs, oursLabel, theirsLabel });
    i = end + 1;
  }
  return blocks;
}

/** The lines a choice puts where the block was. */
export function chosenLines(block: ConflictBlock, choice: ConflictChoice): string[] {
  switch (choice) {
    case "ours":
      return block.ours;
    case "theirs":
      return block.theirs;
    case "both-ours-first":
      return [...block.ours, ...block.theirs];
    case "both-theirs-first":
      return [...block.theirs, ...block.ours];
  }
}

/**
 * The text with one block replaced by `choice`. Every other line — and the file's own line endings,
 * and whether it ends in a newline — is kept exactly.
 */
export function resolveBlock(text: string, block: ConflictBlock, choice: ConflictChoice): string {
  const eol = lineEnding(text);
  const lines = splitLines(text);
  const replaced = [...lines.slice(0, block.startLine), ...chosenLines(block, choice), ...lines.slice(block.endLine + 1)];
  return replaced.join(eol);
}

/** Which block a 0-based line is inside, or `-1`. */
export function blockAt(blocks: ConflictBlock[], line: number): number {
  return blocks.findIndex((b) => line >= b.startLine && line <= b.endLine);
}

/** The next (or previous) block from a line, wrapping around — the editor's ‹ › buttons. */
export function stepBlock(blocks: ConflictBlock[], line: number, direction: 1 | -1): number {
  if (blocks.length === 0) return -1;
  if (direction === 1) {
    const next = blocks.findIndex((b) => b.startLine > line);
    return next === -1 ? 0 : next;
  }
  for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i].endLine < line) return i;
  return blocks.length - 1;
}
