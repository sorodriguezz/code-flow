import { memo } from "react";
import { tagHue } from "../../lib/notes/tags";

/**
 * The Notes workspace's shared visual vocabulary, the counterpart of `remoteChrome` and `dbChrome`.
 *
 * Same job and same reasoning: a tag gets *one* colour and *one* shape, defined here, so it reads
 * the same on a gallery card, in the sidebar's tag list and in the editor's header. Three files
 * each choosing their own is how those three drift apart.
 */

/** The panel fill, matching the other workspaces' so the views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

/** A row in the explorer: the hit area, the hover, and the selected state, in one place because
 *  books and notes have to agree about all three or the tree looks like two lists. */
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

/** The same button for an action that is *not* neutral — the AI one, which sits among sixteen
 *  formatting marks and is the only one in the row that spends money. */
export const ICON_BUTTON_ACCENT = `${ICON_BUTTON_SHELL} text-[var(--cf-accent)]`;

/**
 * A tag, drawn.
 *
 * The colour comes from the name (see `tagHue`) rather than from a stored choice: a tag is the
 * same colour everywhere without anyone picking one, and two notes sharing a tag are visibly
 * related in a gallery of thirty cards. Lightness and chroma are pinned so that fifteen chips on
 * screen stay a set rather than becoming a paint chart — only the hue moves.
 *
 * `oklch` and not `hsl` because hue rotation in HSL changes perceived lightness wildly (yellow at
 * 60% reads far brighter than blue at 60%), which is exactly the thing that would make one chip in
 * a row shout. OKLCH holds lightness constant across the wheel, which is the whole reason to use it
 * here.
 */
export const TagPill = memo(function TagPill({
  tag,
  active,
  count,
  onClick,
  onRemove,
  removeLabel,
}: {
  tag: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const hue = tagHue(tag);
  const ink = `oklch(58% 0.13 ${hue})`;
  const inkDark = `oklch(78% 0.12 ${hue})`;
  const wash = `oklch(58% 0.13 ${hue} / ${active ? 0.24 : 0.12})`;

  const body = (
    <>
      {/* 55% of an already-mid-lightness ink fell under 2:1 against the wash on the light theme,
          which for the count — a number the sidebar asks you to read — is not decoration. 75% keeps
          the hierarchy (the tag name still leads) while staying legible in both themes. */}
      <span className="opacity-75">#</span>
      <span className="truncate">{tag}</span>
      {count !== undefined && <span className="ml-0.5 tabular-nums opacity-75">{count}</span>}
    </>
  );

  return (
    // The two colours are set as custom properties and read by a class pair, so the dark variant
    // is a media query rather than a second React render against `themeStore`.
    <span
      className={`cf-tag-pill inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-[1px] text-[10.5px] font-medium leading-[16px] ${
        active ? "ring-1 ring-inset" : ""
      }`}
      style={
        {
          background: wash,
          "--cf-tag-ink": ink,
          "--cf-tag-ink-dark": inkDark,
          ...(active ? { "--tw-ring-color": wash } : {}),
        } as React.CSSProperties
      }
    >
      {onClick ? (
        <button type="button" onClick={onClick} className="inline-flex min-w-0 items-center gap-1">
          {body}
        </button>
      ) : (
        <span className="inline-flex min-w-0 items-center gap-1">{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="ml-0.5 shrink-0 opacity-50 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      )}
    </span>
  );
});

/**
 * A book's colour as a usable ink, or the muted default when it has none.
 *
 * Pulled toward the theme's text colour for the reason `AppRail`'s `ink` gives: a wash is fine
 * behind a glyph, but a glyph *in* an arbitrary user colour vanishes on one theme or the other.
 * Mixing borrows the theme's contrast for free.
 */
export function bookInk(color: string): string {
  if (!color) return "var(--cf-text-muted)";
  return `color-mix(in oklab, ${color} 62%, var(--cf-text))`;
}


/**
 * "3 minutes", from a word count.
 *
 * 200 words a minute, the figure every reading-time estimate uses, rounded up so a short note
 * reads "1 min" rather than "0 min" — which is the only value the number must never take, since a
 * note that takes no time to read is one the label is lying about.
 */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.ceil(words / 200));
}

/**
 * A timestamp as "hace 5 min" / "5 min ago", falling back to a date once that stops being useful.
 *
 * `Intl.RelativeTimeFormat` rather than a hand-rolled ladder: it is in every runtime this ships on,
 * it declines correctly in Spanish (which "hace 1 días" would not), and it costs nothing here
 * because the formatter is built once per locale rather than per row.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>();

export function relativeTime(iso: string, locale: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.round((at - Date.now()) / 1000);
  const absolute = Math.abs(seconds);

  // Past a week the relative form stops answering the question — "hace 23 días" is worse than the
  // date it happened, because the date is what you would look for it under.
  if (absolute > 7 * 86400) {
    return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" });
  }

  let formatter = relativeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormatters.set(locale, formatter);
  }

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (absolute >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(0, "minute");
}
