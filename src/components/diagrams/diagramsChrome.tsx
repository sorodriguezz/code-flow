/**
 * The Diagrams workspace's shared visual vocabulary, the counterpart of `notesChrome`.
 *
 * Same job and same reasoning: a row, a folder tint and a tag get *one* definition, so the tree,
 * the gallery and the header agree about all three. Three files each choosing their own is how
 * those three drift apart.
 *
 * These deliberately match the notes equivalents value for value. The two workspaces sit next to
 * each other on the rail and are the same shape of thing — a tree of documents — so a row that is
 * three pixels taller in one of them reads as a bug rather than as a distinction.
 */

/** The panel fill, matching the other workspaces' so the views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

/** A row in the explorer: the hit area, the hover, and the selected state, in one place because
 *  folders and diagrams have to agree about all three or the tree looks like two lists. */
export const ROW =
  "group/row flex w-full items-center gap-1.5 rounded-md py-[3px] pr-1.5 text-left text-[12px] transition-colors";

export const ROW_IDLE = "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]";

export const ROW_ACTIVE = "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]";

/** The shape of an icon button — size, hit area, hover wash — with no colour of its own, so a
 *  button that carries one doesn't have to out-specify the muted default in the cascade. */
const ICON_BUTTON_SHELL =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/[0.07]";

/** An icon button in a header or toolbar. */
export const ICON_BUTTON = `${ICON_BUTTON_SHELL} text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]`;

/**
 * A folder's colour, pulled toward the theme's text colour so it stays legible on both.
 *
 * The same treatment `bookInk` gives a notebook, and for the same reason: a wash is fine behind a
 * glyph, but a glyph *in* an arbitrary user colour is not — a pale yellow vanishes on light.
 * Mixing toward `--cf-text` borrows the theme's contrast for free.
 */
export function folderInk(color: string): string {
  if (!color) return "var(--cf-text-muted)";
  return `color-mix(in oklab, ${color} 62%, var(--cf-text))`;
}

