import { motion, useReducedMotion } from "framer-motion";

/** One spring for every selection indicator in the app, so they all move at the same speed. */
const SLIDE = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

/**
 * The fill behind whichever item in a group is selected — shared between the group's buttons by
 * `layoutId`, so changing selection *slides* it to the new item instead of blinking it there.
 *
 * Render it only inside the active button, and make that button `relative` (the pill is absolute
 * over the whole thing) with its own content wrapped in a `relative` span so the label and icon
 * stay above the fill.
 *
 * Two rules make the slide work:
 * - **One `layoutId` per group, and never shared across groups.** Framer tweens between two
 *   nodes carrying the same id, so reusing one id in, say, the tab bar and the settings nav would
 *   send the pill flying between them the moment both are on screen.
 * - **The group's buttons must stay mounted.** The tween needs the old rect and the new one; a
 *   group that swaps its buttons out has nothing to animate from.
 *
 * `inset` and `radius` exist because the pill has to cover its button exactly: a button with no
 * border of its own takes the default `inset-0`, while a bordered one needs `-inset-px` so the
 * pill's own hairline lands on top of the button's instead of leaving a grey ring around it.
 */
export function ActivePill({
  layoutId,
  inset = "inset-0",
  radius = "rounded-md",
}: {
  layoutId: string;
  inset?: string;
  radius?: string;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden
      className={`absolute ${inset} ${radius} border border-[color-mix(in_oklab,var(--cf-accent)_38%,transparent)] bg-[var(--cf-accent-soft)]`}
      transition={reduceMotion ? { duration: 0 } : SLIDE}
    />
  );
}

/**
 * The same idea for a row of underlined tabs, where the selected one is marked by a rule under it
 * rather than a filled pill — turning those into pills would restyle them, so they get the
 * movement without the change of clothes.
 *
 * Same contract as [`ActivePill`]: render inside the active tab only, one `layoutId` per row, and
 * the tab must be `relative`.
 */
export function ActiveUnderline({ layoutId }: { layoutId: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden
      className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[var(--cf-accent)]"
      transition={reduceMotion ? { duration: 0 } : SLIDE}
    />
  );
}
