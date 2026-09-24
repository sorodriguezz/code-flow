import { X } from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";

/**
 * The chrome the three tool panels share: Generate code, Import SQL and Compare.
 *
 * In one module because the drawer shows them one at a time in the same frame, with no bar of its
 * own — so a Copy button that is 22px tall in one panel and 26px in the next is not a detail any
 * more, it is the panel visibly changing shape when you switch tools. These are the shapes those
 * bars need: a bar, a secondary action, the one primary action, a field, and the way out.
 *
 * Since the Trazo pass they are the app's own recipes rather than a local set: every control on
 * these bars is 28px — `buttonClass` at `md`, `iconButtonClass` at `md`, the segmented track at its
 * default — so a row of them lines up without anybody agreeing on padding, which is how the old
 * bars drifted: every control agreed about its padding and none of them agreed about how tall it
 * was.
 */

/**
 * The strip a tool panel's controls sit in — the toolbar anatomy (44px, a hairline under it), with
 * one difference: it wraps. The ten code targets and the actions beside them do not fit one row of
 * a narrow drawer, and a toolbar that clips its own buttons is worse than one that grows a line.
 */
export const TOOL_BAR =
  "flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--cf-border)] py-1.5 pl-4 pr-3";

/** Everything that is not the panel's main verb: copy, open a file, add to the schema. */
export const TOOL_BTN = buttonClass({ variant: "secondary" });

/** The one thing the panel is for. One per panel — two accents is none. */
export const TOOL_BTN_PRIMARY = buttonClass({ variant: "primary" });

/**
 * The pasted text of Import and Compare: `fieldClass`'s tokens — the field fill, the stronger
 * hairline, the accent edge and halo on focus — on a box that is as tall as its pane rather than
 * one line high. Written out because the recipe fixes a height, and these fill the drawer.
 */
export const TOOL_AREA =
  "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[12px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50";

/** The small uppercase word that names a group of alternatives — SQL, ORM, ODM. */
export const SEG_GROUP_LABEL =
  "text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

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
    <Tooltip label={t("dbml.toolsClose")}>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("dbml.toolsClose")}
        className={iconButtonClass({ size: "md" })}
      >
        <X size={16} />
      </button>
    </Tooltip>
  );
}
