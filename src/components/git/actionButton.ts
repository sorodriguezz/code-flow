/**
 * The icon button of the Changes screen: every file row's actions (open, stage, unstage, discard,
 * mark resolved), the section headers' bulk verbs, the unpushed commit's undo and the conflict
 * rows' icons.
 *
 * A 22px square around the glyph, and the hover tint fills the whole square, so what you aim at is
 * the box that lights up rather than the 13px of ink inside it. The row actions used to be bare
 * `<button>`s around the glyph — no width, no height, and preflight zeroes a button's padding — so
 * each button *was* its icon, and the 4px between two of them belonged to the row underneath: a
 * click a pixel off the mark did not miss quietly, it landed on the row and opened the file's diff
 * instead of staging it.
 *
 * `onRow` is for a button on a row that takes the hover tint itself — which it always has by the
 * time the pointer reaches the button — so the square lights a step stronger (`--cf-press`) and still
 * reads as a square on the tinted row. Inside such a row, also pull the square into the row's own
 * padding (`-my-0.5` on a 26px row) so the list keeps its density: the square is taller than the
 * row's line of text, not than the row.
 *
 * Why not `iconButtonClass` (`common/Button`): its hover colour is `--cf-text`, and a second
 * `hover:text-*` passed through its `className` does not win — Tailwind orders two arbitrary values
 * of one utility alphabetically, so `…--cf-text` lands after `…--cf-danger` every time. The tone has
 * to be picked here. And a disabled one keeps its pointer events: a blocked action under the cursor
 * should stop the click, not hand it to the row it sits on, and should still say what it is.
 */
export type ActionTone = "accent" | "danger" | "success";

const HOVER_TONE: Record<ActionTone, string> = {
  accent: "enabled:hover:text-[var(--cf-accent)]",
  danger: "enabled:hover:text-[var(--cf-danger)]",
  success: "enabled:hover:text-[var(--cf-success)]",
};

export function actionButtonClass(
  tone: ActionTone = "accent",
  { onRow = false, className = "" }: { onRow?: boolean; className?: string } = {},
): string {
  return `flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 disabled:opacity-30 ${
    onRow ? "enabled:hover:bg-[var(--cf-press)]" : "enabled:hover:bg-[var(--cf-hover)]"
  } ${HOVER_TONE[tone]} ${className}`;
}
