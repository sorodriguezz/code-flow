import { Eraser } from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import type { DbmlMarkKind } from "../../lib/dbml/layout";
import type { Translate } from "../../state/languageStore";

/**
 * The review vocabulary — the colours and the four rows — in the one place three surfaces read it.
 *
 * A mark can now be put on a table, on a relationship and on a **column**, and it is set from the
 * canvas's box menu, the canvas's row menu and the inspector. Before the third of those there were
 * two copies of the colour table and one copy of the menu; a fourth caller is what turns "restated
 * so the panel and the diagram agree" into two things that agree until somebody edits one of them.
 *
 * The colours are a fourth family, distinct from the badge legend next door, and they are the three
 * semantic tokens a reader of this app already knows: danger, warning, success. They can be reused
 * here — where the badge legend could not reuse the accent — because a mark is never drawn *inside*
 * the badge strip, so it is never read against a `PK` chip. Each is a token with a light and a dark
 * value, and each is a bare `var(--…)`: the SVG export resolver substitutes those and nothing else,
 * so a `color-mix()` here would survive on screen and reach the exported PNG unevaluated.
 */
export const MARK_COLOUR: Record<DbmlMarkKind, string> = {
  remove: "var(--cf-danger)",
  review: "var(--cf-warning)",
  keep: "var(--cf-success)",
};

/** The three, in the order every surface offers them: going, undecided, settled. */
export const MARK_KINDS = ["remove", "review", "keep"] as const;

/**
 * The three marks plus a way out, as menu rows.
 *
 * First in whatever menu they are put in, above the edits, because on a model being reviewed this
 * is the thing you press thirty times and "delete this" is the thing you press once at the end. The
 * mark already on the thing is offered as "clear" rather than repeated as a no-op row.
 *
 * Takes the setter rather than an id, because the three things that can be marked are not keyed
 * alike: a table and a relationship each have one id, and a column has a table and a name. The rows
 * are the same rows whichever it is, which is the point of passing a closure — this never learns
 * which kind it is building.
 */
export function markMenuItems(
  current: DbmlMarkKind | undefined,
  set: (mark: DbmlMarkKind | null) => void,
  t: Translate,
): MenuItem[] {
  const rows: MenuItem[] = MARK_KINDS.filter((kind) => kind !== current).map((kind) => ({
    label: t(`dbml.mark.${kind}` as "dbml.mark.remove"),
    // The dot rides in a slot the exact size and offset of the Lucide glyph the other rows get —
    // 13px square, nudged 2px down. `ContextMenu` lays its rows out `items-start` so that a label
    // long enough to wrap keeps its glyph beside the *first* line, which means the glyph carries
    // its own optical centring; a bare 8px dot took that offset from nothing and sat a third of a
    // line above the words. Matching the slot also lines the three labels up with "Quitar marca"
    // below them, which is an eraser glyph and was four pixels further right than its siblings.
    leading: (
      <span className="mt-[2px] flex h-[13px] w-[13px] shrink-0 items-center justify-center">
        <span className="h-2 w-2 rounded-full" style={{ background: MARK_COLOUR[kind] }} />
      </span>
    ),
    onClick: () => set(kind),
  }));
  if (current) {
    rows.push({ label: t("dbml.mark.clear"), icon: Eraser, onClick: () => set(null) });
  }
  return rows;
}

/** What a mark is *called* once it is on something — the tooltips, as opposed to the menu's verbs. */
export function markNamesOf(t: Translate): Record<DbmlMarkKind, string> {
  return {
    remove: t("dbml.mark.stateRemove"),
    review: t("dbml.mark.stateReview"),
    keep: t("dbml.mark.stateKeep"),
  };
}
