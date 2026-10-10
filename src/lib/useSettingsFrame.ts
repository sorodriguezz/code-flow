import { useLayoutEffect, useState, type CSSProperties } from "react";

/**
 * Where the Settings window sits: over the app's central sheet (`[data-tour="main-content"]`),
 * edge to edge — the user's ask (2026-10-09: "que ocupe todo el recuadro central", the 1040×640 box
 * was too small) — and, while the AI panel is open, over its sheet as well (same day: "que use
 * también el recuadro del chat"): the box that holds both, the app rail between them included. It
 * follows them as the window, the sidebar, the dock or the AI panel resize them.
 *
 * The terminal dock's sheet too, while it is open: it shares the central sheet's column, and with
 * the central sheet alone the settings stopped at the dock's top edge and sat cut off over the upper
 * half of the window, the dock blurred under the scrim below it (user report, 2026-10-10). The chat's
 * sheet runs the full height of the row anyway, so with both open the box was already that tall.
 *
 * A space too small to hold the settings comfortably (a narrow window, a tall terminal dock) or no
 * sheet at all (a satellite window) gives the whole window instead, less a margin — so the panel
 * adapts down to a phone-sized window rather than shrinking with it.
 */

/** Below this the sheet is too small: the nav, a pane rail and a readable pane need about this much. */
export const SETTINGS_MIN = { width: 760, height: 480 } as const;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The smallest box holding both `a` and `b`. */
function union(a: Box, b: Box): Box {
  const top = Math.min(a.top, b.top);
  const left = Math.min(a.left, b.left);
  return {
    top,
    left,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

/**
 * The frame for a sheet `rect` (or none), the AI panel's sheet `panel` and the terminal dock's
 * `dock` (each when it is open) in a `viewport` — pure, so it can be tested. The other two only ever
 * grow a sheet that exists: a window without the central sheet has no place for the settings but
 * the whole window.
 */
export function settingsFrame(
  rect: Box | null,
  viewport: { width: number; height: number },
  panel: Box | null = null,
  dock: Box | null = null,
): Box {
  let space = rect;
  if (space && panel) space = union(space, panel);
  if (space && dock) space = union(space, dock);
  if (space && space.width >= SETTINGS_MIN.width && space.height >= SETTINGS_MIN.height) {
    return { top: space.top, left: space.left, width: space.width, height: space.height };
  }
  // A small window keeps its edges for the panel; a large one keeps a frame of air around it.
  const margin = viewport.width < 640 ? 0 : 12;
  return { top: margin, left: margin, width: Math.max(0, viewport.width - margin * 2), height: Math.max(0, viewport.height - margin * 2) };
}

const SHEET = '[data-tour="main-content"]';
const PANEL = '[data-tour="ai-panel"]';
const DOCK = '[data-tour="terminal-dock"]';

function measure(): Box {
  const find = (selector: string) => (typeof document === "undefined" ? null : document.querySelector<HTMLElement>(selector));
  // A box with no area is a sheet that is mounted but hidden — the dock, closed, stays in the DOM
  // (`DockSlot`) — and must not stretch the frame to the corner of the window.
  const box = (selector: string) => {
    const rect = find(selector)?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  };
  return settingsFrame(box(SHEET), { width: window.innerWidth, height: window.innerHeight }, box(PANEL), box(DOCK));
}

export function useSettingsFrame(): CSSProperties {
  const [frame, setFrame] = useState<Box>(measure);
  useLayoutEffect(() => {
    const update = () =>
      setFrame((was) => {
        const next = measure();
        return was.top === next.top && was.left === next.left && was.width === next.width && was.height === next.height ? was : next;
      });
    update();
    // The central sheet is the only one to watch: it is `flex-1` beside the AI panel, so the panel
    // opening, closing, going wide or being dragged all resize it, and the panel's height only
    // changes with the window's.
    const sheet = document.querySelector<HTMLElement>(SHEET);
    const observer = sheet && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (sheet) observer?.observe(sheet);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return { position: "fixed", top: frame.top, left: frame.left, width: frame.width, height: frame.height };
}
