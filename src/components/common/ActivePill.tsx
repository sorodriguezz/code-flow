import { motion, useReducedMotion } from "framer-motion";

/** One spring for every selection indicator in the app, so they all move at the same speed — and for
 *  whatever moves *with* one: a pill riding inside a block that slides on another curve is pulled
 *  off its own path by the difference (the projects panel, where the rows slide on this too). */
export const SLIDE = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;

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
/**
 * `soft` marks the selected row of a list or rail (an accent-tinted fill). `raised` is the thumb of a
 * segmented control and the active tab on the frame: a small sheet lifted off its track — the same
 * shape the active project and the active app wear, so selection reads one way across the chrome.
 */
export function ActivePill({
  layoutId,
  inset = "inset-0",
  radius = "rounded-md",
  variant = "soft",
  mark = false,
}: {
  layoutId: string;
  inset?: string;
  radius?: string;
  variant?: "soft" | "raised";
  /**
   * A short accent bar on the selected row's left edge, on top of the fill — the Settings window's
   * nav and pane rails (the user's ask, 2026-10-09: "ponle una marca al menú y submenú
   * seleccionados"). Its own `layoutId` (`<id>-mark`), so it slides with the pill without being
   * stretched by the pill's scale while two rows of different heights trade places.
   */
  mark?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : SLIDE;
  return (
    <>
      <motion.span
        layoutId={layoutId}
        aria-hidden
        className={`absolute ${inset} ${radius} ${
          variant === "raised"
            ? // `--cf-control`, not the sheet's tone: a see-through window clears that inside a sheet,
              // and the lifted pill has to keep reading as something lifted (see `index.css`).
              "bg-[var(--cf-control)] shadow-[var(--cf-shadow-lift),0_0_0_1px_var(--cf-border)]"
            : "bg-[var(--cf-accent-soft)]"
        }`}
        transition={transition}
      />
      {mark && (
        <motion.span
          layoutId={`${layoutId}-mark`}
          aria-hidden
          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-[var(--cf-accent)]"
          transition={transition}
        />
      )}
    </>
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
      className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-[var(--cf-accent-fill)]"
      transition={reduceMotion ? { duration: 0 } : SLIDE}
    />
  );
}

/**
 * "You are here" on a rail: a short bar standing on the rail's own edge beside the selected item,
 * in that item's colour — the open repository in the projects panel. The fill a list row wears says
 * *which* row; this says it from across the window, where a tinted tile among tinted tiles did not
 * (user report: which repository is open was not obvious in the folded rail).
 *
 * Same contract as [`ActivePill`]: render beside the selected item only, one `layoutId` per rail,
 * and the parent must be `relative`. `className` places it — its edge offset and vertical inset.
 */
export function ActiveMarker({ layoutId, color, className }: { layoutId: string; color: string; className: string }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.span
      layoutId={layoutId}
      aria-hidden
      className={`pointer-events-none absolute w-1 rounded-r-full ${className}`}
      style={{ background: color }}
      transition={reduceMotion ? { duration: 0 } : SLIDE}
    />
  );
}
