import { useEffect, useState } from "react";
import { useAiPanelStore } from "../../state/aiPanelStore";
import { useLayoutStore } from "../../state/layoutStore";

/**
 * The narrowest the assistant panel may be dragged. Below this the header strip (chips, badge,
 * share, history…) no longer fits and the transcript's cards fold into each other — 300 did both
 * (user report, 2026-11-23).
 */
export const PANEL_MIN = 420;

/**
 * Dragged this far past `PANEL_MIN`, the panel shuts — the same as the rail's assistant button —
 * instead of stopping at a width that would not hold its contents.
 */
export const PANEL_COLLAPSE_BEYOND = 80;

/**
 * How close to the ceiling a dragged width counts as "all the way". A drag that stops a few
 * pixels short of the window's middle is a drag to the top; making the user land on the exact
 * pixel for the header's button to notice would read as the button being broken.
 */
export const MAX_SNAP = 12;

/**
 * How wide the panel is allowed to get: half the window, and no more.
 *
 * Past half it stops being a panel — the view it is docked beside becomes the smaller of the two,
 * and the thing the user came to look at is the one that gets squeezed. The floor keeps the ceiling
 * above `PANEL_MIN` on a window too narrow for both.
 */
export const maxPanelWidth = () => Math.max(PANEL_MIN, Math.round(window.innerWidth / 2));

/** That ceiling, kept current as the window is resized. The clamp is applied to what is rendered,
 * never written back: plug the large display in again and the width chosen there comes back. */
export function useMaxPanelWidth(): number {
  const [max, setMax] = useState(maxPanelWidth);
  useEffect(() => {
    const onResize = () => setMax(maxPanelWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return max;
}

/** Whether a width is, for the user's purposes, the ceiling. */
export const reachesMax = (width: number, max: number) => width >= max - MAX_SNAP;

/**
 * The width to come back to from the top when the one on record is the top itself — a drag that
 * started there, or a width saved before the panel learned to snap. Restoring it would change
 * nothing on screen, and a «restore» button that does nothing reads as broken.
 */
export const restoreWidth = (max: number) => Math.max(PANEL_MIN, Math.round(max * 0.6));

/**
 * Whether the panel is as wide as it can be, however it got there: the header's button, a drag to
 * the edge, or a window shrunk under a wide panel. What the maximize/restore button shows.
 *
 * Holds a boolean rather than the ceiling, so a window resize re-renders the header only when the
 * answer flips — not on every `resize` event of a live drag.
 */
export function usePanelAtMax(): boolean {
  const wide = useAiPanelStore((s) => s.wide);
  const stored = useLayoutStore((s) => s.sizes.aiPanelWidth);
  const [clamped, setClamped] = useState(() => reachesMax(stored, maxPanelWidth()));
  useEffect(() => {
    const check = () => setClamped(reachesMax(stored, maxPanelWidth()));
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [stored]);
  return wide || clamped;
}

/**
 * The header's maximize/restore button.
 *
 * At the top it restores — to the width on record, or to `restoreWidth` when that width is the top
 * too. Below it, it maximizes.
 */
export function togglePanelMax() {
  const panel = useAiPanelStore.getState();
  const layout = useLayoutStore.getState();
  const max = maxPanelWidth();
  const stored = layout.sizes.aiPanelWidth;
  const atMax = panel.wide || reachesMax(stored, max);
  if (atMax && reachesMax(stored, max)) {
    const back = restoreWidth(max);
    layout.setSize("aiPanelWidth", back);
    layout.commitSize("aiPanelWidth", back);
  }
  if (atMax) {
    if (panel.wide) panel.toggleWide();
  } else {
    panel.toggleWide();
  }
}
