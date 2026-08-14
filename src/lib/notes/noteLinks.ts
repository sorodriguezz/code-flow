/**
 * Where `[[Title]]` references sit in a note's source — the editor's half of the syntax
 * `richMarkdown`'s `noteLinkExtension` renders in the preview.
 *
 * A separate, tiny module rather than a shared import from `richMarkdown`, because that module is
 * loaded lazily specifically to keep `marked` out of the chunk a bare gallery pays for (see its
 * header comment) — pulling it in statically here, in the editor Monaco already makes the heaviest
 * chunk in the app, would load it every time a note is opened whether or not its preview ever runs.
 *
 * The pattern mirrors the `marked` tokenizer's on purpose: `[^\]\n]+` so a `[[` that never closes
 * is punctuation rather than a match that eats the rest of the document.
 */
export interface NoteLinkMatch {
  /** 1-based, matching what Monaco speaks. */
  line: number;
  /** 1-based, the column of the opening `[`. */
  startColumn: number;
  /** 1-based, one past the closing `]`. */
  endColumn: number;
}

const NOTE_LINK_RE = /\[\[[^\]\n]+\]\]/g;

/** Every `[[…]]` span in `source`, line by line — what the editor decorates so Monaco's own
 *  Markdown grammar (which has no notion of this syntax and reads the trailing `]]` as an
 *  unterminated link) never gets the last word on how it's coloured. */
export function findNoteLinks(source: string): NoteLinkMatch[] {
  const matches: NoteLinkMatch[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    NOTE_LINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NOTE_LINK_RE.exec(line)) !== null) {
      matches.push({
        line: i + 1,
        startColumn: match.index + 1,
        endColumn: match.index + 1 + match[0].length,
      });
      // A zero-width match would spin forever; the pattern guarantees at least four characters
      // (`[[` + `]]`), but guarding is cheaper than trusting it.
      if (NOTE_LINK_RE.lastIndex === match.index) NOTE_LINK_RE.lastIndex++;
    }
  }
  return matches;
}
