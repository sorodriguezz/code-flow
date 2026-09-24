import type { TranslationKey } from "./i18n/translations";

// git's own vocabulary ("untracked", "typechange"...) isn't very readable to anyone who
// hasn't internalized git's internals — map each raw status to a plain-language label.
const STATUS_KEYS: Record<string, TranslationKey> = {
  untracked: "fileStatus.new",
  added: "fileStatus.added",
  modified: "fileStatus.modified",
  deleted: "fileStatus.deleted",
  renamed: "fileStatus.renamed",
  copied: "fileStatus.copied",
  typechange: "fileStatus.typechange",
  conflicted: "fileStatus.conflicted",
  ignored: "fileStatus.ignored",
  unmodified: "fileStatus.unmodified",
};

export function fileStatusLabelKey(status: string): TranslationKey {
  return STATUS_KEYS[status] ?? "fileStatus.modified";
}

/**
 * One fixed colour per status — the same in the Changes list, the expanded commit, the diff header
 * and the explorer, whatever accent the user has picked.
 *
 * Fixed is the point. Renamed used to borrow `--cf-accent`, so "R" came out indigo for one user and
 * amber for the next — and on an amber accent it was indistinguishable from "M". Untracked shared
 * added's green, so `?` and `A` read as the same fact in a list where they are not: one is in the
 * index and one git has never seen. Each letter now has a hue of its own, and none of them is the
 * accent, which in this app means "selected" and nothing else.
 *
 * The additions, deletions and modifications keep the colours the editor's change bars already use
 * (see the note in `index.css`), so a line's bar and its file's letter still agree.
 */
export function fileStatusColor(status: string): string {
  switch (status) {
    case "added":
      return "var(--cf-success)";
    case "untracked":
      return "var(--cf-teal)";
    case "deleted":
      return "var(--cf-danger)";
    case "renamed":
    case "copied":
      return "var(--cf-blue)";
    case "conflicted":
      return "var(--cf-violet)";
    case "ignored":
    case "unmodified":
      return "var(--cf-text-faint)";
    default:
      // `modified`, `typechange`, and anything a newer backend invents: "this file changed".
      return "var(--cf-warning)";
  }
}

/**
 * The one-letter badge for a status, in the alphabet `git status --short` already uses.
 *
 * A letter rather than the word `fileStatusLabelKey` hands back, because these two labels answer to
 * different layouts. The word belongs above a diff, where one file is the subject and there is a
 * whole header to spend on it; this one belongs beside a *path*, in a list where the path is the
 * content and fifty of them can be on screen at once — see the expanded commit row in `GraphView`.
 * Fifty "Modificado" pills there would push every filename it annotates off the right edge.
 *
 * **Every view draws its letter from here.** The Changes list used to take the first letter of the
 * English status word instead, which is how "U" meant *untracked* there and *conflicted* in the
 * commit list one tab away. Now `?` is untracked and `U` is a conflict, everywhere.
 *
 * Untranslated on purpose, and the one label in this file that is: `M`/`A`/`D` are git's own and
 * read the same in every locale, which is exactly why the abbreviation is legible at all. The full
 * word stays a `title` away, and that one *is* translated.
 */
const STATUS_LETTERS: Record<string, string> = {
  untracked: "?",
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  conflicted: "U",
  ignored: "I",
  // Not reachable from a commit's diff — a file that did not change is not in one — but the map is
  // kept total against `STATUS_KEYS` above so the two can't drift into disagreeing about a status.
  unmodified: "·",
};

export function fileStatusLetter(status: string): string {
  return STATUS_LETTERS[status] ?? "M";
}

/**
 * How the letter is set, wherever it is drawn: monospaced so `M` and `?` take the same width and the
 * paths beside them start on one line, bold because at 10.5px a regular-weight `?` is a smudge.
 * Pair it with `style={{ color: fileStatusColor(status) }}` and the translated word as its `title`.
 */
export const FILE_STATUS_LETTER_CLASS =
  "w-4 shrink-0 text-center font-mono text-[10.5px] font-bold leading-none";

/**
 * The wash for a status *chip* — the word version, above a diff — in the status's own colour.
 *
 * Laid over `chipClass("neutral")` for its shape: the chip tones are a closed set (ok / warn / bad /
 * info…) and two of these colours are not in it, so the tone is taken from the same function the
 * letter uses rather than approximated — a chip and a letter that disagree about which colour
 * "renamed" is would be the exact problem the fixed palette above exists to remove.
 */
export function fileStatusChipStyle(status: string): { color: string; background: string; boxShadow: string } {
  const color = fileStatusColor(status);
  return {
    color,
    background: `color-mix(in oklab, ${color} 14%, transparent)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 26%, transparent)`,
  };
}
