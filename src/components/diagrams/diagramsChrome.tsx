import { iconButtonClass } from "../common/Button";

/**
 * The Diagrams workspace's shared visual vocabulary, the counterpart of `notesChrome`.
 *
 * Same job and same reasoning: a folder tint and a pane heading get *one* definition, so the tree,
 * the gallery, the schema workbench and its side panels agree about them. Several files each
 * choosing their own is how those drift apart.
 *
 * The row and the icon button deliberately match `notesChrome` value for value: the two workspaces
 * sit next to each other on the rail and are the same shape of thing — a tree of documents — so a
 * row that is three pixels taller in one of them reads as a bug rather than as a distinction. Both
 * are on the Trazo metrics now: 28px rows at 13px, and the shared 26px icon button.
 */

/** The panel fill, matching the other workspaces' so the views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

/** A row in the explorer: the hit area, the hover, and the selected state, in one place because
 *  folders and diagrams have to agree about all three or the tree looks like two lists. */
export const ROW =
  "group/row flex min-h-[28px] w-full items-center gap-1.5 rounded-md pr-1.5 text-left text-[13px] transition-colors";

export const ROW_IDLE = "text-[var(--cf-text)] hover:bg-[var(--cf-hover)]";

export const ROW_ACTIVE = "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]";

/** An icon button in a header or toolbar — the app's own, at its 26px size. */
export const ICON_BUTTON = iconButtonClass({ size: "sm", className: "disabled:cursor-not-allowed" });

/**
 * The name of a side pane or a floating panel — INSPECTOR, HISTORY, REFERENCE. The section-label
 * type (11px, uppercase, faint) on a line of its own, taking the room its head row has to give.
 */
export const PANE_TITLE =
  "min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

/**
 * The head row of a floating panel: its title and one or two 22px icon buttons, over a hairline.
 * 40px rather than a toolbar's 44 — it is the top of a popover, not of a surface.
 */
export const PANE_HEAD =
  "flex h-10 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] pl-3 pr-2";

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
