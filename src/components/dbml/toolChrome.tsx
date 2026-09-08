import { X } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * The chrome the three tool panels share: Generate code, Import SQL and Compare.
 *
 * In one module because the drawer shows them one at a time in the same frame, with no bar of its
 * own — so a Copy button that is 22px tall in one panel and 26px in the next is not a detail any
 * more, it is the panel visibly changing shape when you switch tools. These are the shapes those
 * bars need: a track of alternatives, a secondary action, the one primary action, the bar that
 * holds them, and the way out.
 *
 * The metrics are fixed heights rather than padding, deliberately. A `py-[2px]` button beside a
 * `py-[3px]` one beside a select that adds its own height was exactly how the old bars drifted:
 * every control agreed about its padding and none of them agreed about how tall it was.
 */

/** The strip a tool panel's controls sit in, under the drawer's own tab row. */
export const TOOL_BAR =
  "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--cf-border)] px-2 py-1.5";

/** Everything that is not the panel's main verb: copy, open a file, add to the schema. */
export const TOOL_BTN =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border " +
  "border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[11px] font-medium " +
  "text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] " +
  "hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-40";

/** The one thing the panel is for. One per panel — two accents is none. */
export const TOOL_BTN_PRIMARY =
  "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md " +
  "bg-[var(--cf-accent)] px-2.5 text-[11px] font-medium text-white shadow-[0_1px_2px_rgba(10,10,30,0.16)] " +
  "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * The recessed track a set of alternatives sits in — the tool tabs, and the ten code targets.
 *
 * `--cf-bg` and not `--cf-field`: on the light theme a field is `#ffffff`, which is also the panel
 * it would be drawn on, so the track would be invisible and the selected pill would have nothing to
 * be selected *against*. The page background is a shade off the surface in both themes, which is
 * the whole trick — the track reads as recessed and the pill as lifted out of it.
 */
export const SEG_TRACK =
  "flex flex-wrap items-center gap-[2px] rounded-lg border border-[var(--cf-border)] bg-[var(--cf-bg)] p-[2px]";

/**
 * One alternative in a track.
 *
 * The selected one is lifted (surface fill, a hairline of accent, a 1px shadow) *and* written in the
 * accent. Colour alone was what the old bar used, and a soft accent tint on a muted label is a
 * difference you have to go looking for; the point of this control is that you can see which tool
 * you are in without reading anything.
 */
export function segItem(active: boolean): string {
  return (
    "inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[11px] " +
    "font-medium transition-colors " +
    (active
      ? "bg-[var(--cf-surface)] text-[var(--cf-accent)] shadow-[0_1px_2px_rgba(10,10,30,0.12)] " +
        "ring-1 ring-[color-mix(in_oklab,var(--cf-accent)_38%,transparent)]"
      : "text-[var(--cf-text-muted)] hover:bg-[color-mix(in_oklab,var(--cf-text)_7%,transparent)] " +
        "hover:text-[var(--cf-text)]")
  );
}

/** The tiny uppercase word that names a group of alternatives — SQL, ORM, ODM. */
export const SEG_GROUP_LABEL =
  "text-[9px] font-semibold uppercase tracking-[0.09em] text-[var(--cf-text-muted)]";

/**
 * The way out of a tool, in the panel's own row of actions.
 *
 * A component and not a class string because all three panels close the same way and this is the
 * control you look for by *shape* — one X, always last in the cluster, whichever tool is open. It
 * used to live in a title bar over the panel; that bar is gone, so the button moved down into the
 * row it was floating above rather than being drawn twice or dropped.
 */
export function ToolClose({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClose}
      title={t("dbml.toolsClose")}
      aria-label={t("dbml.toolsClose")}
      className="inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
    >
      <X size={15} />
    </button>
  );
}
