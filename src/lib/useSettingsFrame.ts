import { useLayoutEffect, useState, type CSSProperties } from "react";

/**
 * Where the Settings window sits: over the app's central sheet (`[data-tour="main-content"]`),
 * edge to edge — the user's ask (2026-10-09: "que ocupe todo el recuadro central", the 1040×640 box
 * was too small) — and, while the AI panel is open, over its sheet as well (same day: "que use
 * también el recuadro del chat"): the box that holds both, the app rail between them included. It
 * follows them as the window, the sidebar, the dock or the AI panel resize them.
 *
 * The projects panel too (2026-10-21: with it unfolded, the settings started at its edge and its
 * 300 px sat beside them as a blurred, empty strip — «sigue quedando el espacio cuando el panel de
 * repositorio está abierto»): it is the window's left column, so the box runs from the window's
 * left side, folded or not.
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

/** The air around the settings when they take the whole window. */
const FALLBACK_AIR = 24;
/** Clear of the window's own buttons, where there is no sheet to start under. */
const TITLE_BAR = 44;

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
 * The frame for a sheet `rect` (or none), the AI panel's sheet `panel`, the terminal dock's `dock`
 * (each when it is open) and the projects panel `side` in a `viewport` — pure, so it can be tested.
 * The others only ever grow a sheet that exists: a window without the central sheet has no place
 * for the settings but the whole window.
 */
export function settingsFrame(
  rect: Box | null,
  viewport: { width: number; height: number },
  panel: Box | null = null,
  dock: Box | null = null,
  side: Box | null = null,
): Box {
  let space = rect;
  if (space && panel) space = union(space, panel);
  if (space && dock) space = union(space, dock);
  // Its width only — the panel runs the window's full height, under the title bar, and the
  // settings keep the sheet's top — and the same air on the left as the window leaves them on the
  // right (the app rail, or the chat's margin), so they sit centred (user, 2026-10-22: «debe tener
  // el mismo espacio que la derecha»; a fixed 8 px read as lopsided against the rail's 50).
  if (space && side) {
    const right = space.left + space.width;
    const air = Math.max(0, viewport.width - right);
    const left = Math.min(space.left, side.left + air);
    space = { ...space, left, width: right - left };
  }
  if (space && space.width >= SETTINGS_MIN.width && space.height >= SETTINGS_MIN.height) {
    return { top: space.top, left: space.left, width: space.width, height: space.height };
  }
  // A phone-sized window keeps its edges for the panel; any other keeps a frame of air around it —
  // 24 px, not the 12 it had (user, 2026-10-22: «es muy pequeño el margen, déjale más en los 4
  // lados») — and starts under the title bar, whose window buttons macOS draws over everything and
  // so sat on the settings' own header. Under the sheet's top when there is a sheet, else under
  // the bar's height.
  if (viewport.width < 640) return { top: 0, left: 0, width: viewport.width, height: viewport.height };
  const top = Math.max(FALLBACK_AIR, rect?.top ?? TITLE_BAR);
  return {
    top,
    left: FALLBACK_AIR,
    width: Math.max(0, viewport.width - FALLBACK_AIR * 2),
    height: Math.max(0, viewport.height - top - FALLBACK_AIR),
  };
}

const SHEET = '[data-tour="main-content"]';
const PANEL = '[data-tour="ai-panel"]';
const DOCK = '[data-tour="terminal-dock"]';
const SIDE = "#cf-sidebar";

function measure(): Box {
  const find = (selector: string) => (typeof document === "undefined" ? null : document.querySelector<HTMLElement>(selector));
  // A box with no area is a sheet that is mounted but hidden — the dock, closed, stays in the DOM
  // (`DockSlot`) — and must not stretch the frame to the corner of the window.
  const box = (selector: string) => {
    const rect = find(selector)?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  };
  return settingsFrame(box(SHEET), { width: window.innerWidth, height: window.innerHeight }, box(PANEL), box(DOCK), box(SIDE));
}

export function useSettingsFrame(): CSSProperties {
  const [frame, setFrame] = useState<Box>(measure);
  useLayoutEffect(() => {
    let live = true;
    const update = () => {
      if (!live) return;
      setFrame((was) => {
        const next = measure();
        return was.top === next.top && was.left === next.left && was.width === next.width && was.height === next.height ? was : next;
      });
    };
    // Measured again as each finite animation running now ends. The projects panel folds and the
    // side panels slide by transform (FLIP, `useEdgeSlide`): the sheet's layout lands at once — its
    // size, all the observer below watches, is already final — while its box is still drawn where it
    // was. Measured then, the settings sat a fold's width to the right of the sheet with an empty
    // strip beside them, and stayed there (user report, 2026-10-21). An endless one (a spinner)
    // never finishes, so it is not waited on.
    const settle = () => {
      update();
      if (typeof document.getAnimations !== "function") return;
      for (const animation of document.getAnimations()) {
        const end = animation.effect?.getComputedTiming().endTime;
        if (animation.playState === "running" && typeof end === "number" && Number.isFinite(end)) {
          void animation.finished.then(update, () => {});
        }
      }
    };
    settle();
    // The central sheet is the only one to watch: it is `flex-1` beside the AI panel, so the panel
    // opening, closing, going wide or being dragged all resize it, and the panel's height only
    // changes with the window's.
    const sheet = document.querySelector<HTMLElement>(SHEET);
    const observer = sheet && typeof ResizeObserver !== "undefined" ? new ResizeObserver(settle) : null;
    if (sheet) observer?.observe(sheet);
    window.addEventListener("resize", settle);
    return () => {
      live = false;
      observer?.disconnect();
      window.removeEventListener("resize", settle);
    };
  }, []);
  return { position: "fixed", top: frame.top, left: frame.left, width: frame.width, height: frame.height };
}
