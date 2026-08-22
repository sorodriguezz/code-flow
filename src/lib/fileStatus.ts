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

export function fileStatusColor(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--cf-success)";
    case "deleted":
      return "var(--cf-danger)";
    case "renamed":
    case "copied":
      return "var(--cf-accent)";
    default:
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
