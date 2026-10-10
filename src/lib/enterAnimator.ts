import { EASE_OUT } from "./motion";

/**
 * The full motion level's "everything that appears, arrives" (user, 2026-10-10: "animaciones fluidas
 * a tooooodo — botones, submenús, contenido que aparece, pasos, apps").
 *
 * One observer for the whole document instead of an animation written into each of the app's
 * hundreds of components: every element React puts on screen fades up into place, and when several
 * siblings land in the same commit — the rows of a pane, the steps of a run, the results of a search
 * — they cascade. Connected only while the root says `data-motion="full"` (`motionStore`); at the
 * other levels there is no observer and nothing runs.
 *
 * What it leaves alone, because something else already moves it or because moving it would be wrong:
 * - anything that animates on its own — a CSS animation (`cf-fade-in`, the dialogs, the menus), an
 *   inline-styled one (framer-motion writes its starting values inline), a running Web Animation;
 * - surfaces that redraw themselves as they work: Monaco, xterm, React Flow, Excalidraw, iframes,
 *   SVG (the schema canvases re-render their shapes while they are dragged);
 * - what appears because a list was scrolled: rows a virtualised list mounts on the way down are
 *   not news, and fading them in would make the list swim under the wheel;
 * - what replaces what was there in one stroke — `innerHTML` written over, as the chat's markdown is
 *   while a reply streams and highlighted code is on every update: that is the same content again,
 *   and fading it would flash the message once per chunk;
 * - `[data-no-enter]`, for the one place that needs it.
 *
 * Opacity and the `translate` property only — never `transform`, which an element may already use
 * to place itself — and no `translate` at all on an element that is positioned with one.
 */

const SKIP = ".monaco-editor, .xterm, .react-flow, .excalidraw, [data-no-enter]";
/** Siblings past this many in one commit appear as they are: they are below the fold, or a list
 *  so long that a cascade through it would still be running when the user is done reading. */
const CASCADE_LIMIT = 24;
const STEP_MS = 22;
const DURATION_MS = 300;
/** How long after a scroll the scrolled container's new contents are taken for scrolling's. */
const SCROLL_QUIET_MS = 220;

let observer: MutationObserver | null = null;
let scrolled: { target: EventTarget | null; at: number } = { target: null, at: 0 };

function onScroll(event: Event) {
  scrolled = { target: event.target, at: performance.now() };
}

function arrives(el: HTMLElement, now: number): boolean {
  if (!el.isConnected || el.closest(SKIP)) return false;
  if (el instanceof HTMLIFrameElement || el instanceof HTMLCanvasElement) return false;
  if (el.style.opacity !== "" || el.style.transform !== "") return false;
  const target = scrolled.target;
  if (now - scrolled.at < SCROLL_QUIET_MS && target instanceof Node && target.contains(el)) return false;
  return true;
}

function onMutations(records: MutationRecord[]) {
  const now = performance.now();
  // Grouped by parent, so a cascade counts siblings rather than everything in the commit.
  const byParent = new Map<Node, HTMLElement[]>();
  for (const record of records) {
    // Nodes gone and nodes come in the same record is markup rewritten wholesale, not something new.
    if (record.removedNodes.length > 0) continue;
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !arrives(node, now)) continue;
      const siblings = byParent.get(record.target);
      if (siblings) siblings.push(node);
      else byParent.set(record.target, [node]);
    }
  }
  for (const siblings of byParent.values()) {
    siblings.slice(0, CASCADE_LIMIT).forEach((el, index) => {
      const style = getComputedStyle(el);
      if (style.animationName !== "none" || style.display === "none" || el.getAnimations().length > 0) return;
      // An overlay — Settings, a dialog's backdrop. It may hold a backdrop blur, which WebKit does not
      // draw while an ancestor's opacity is animating: faded in, the acrylic would land late.
      if (style.position === "fixed") return;
      const travel = style.translate === "none" || style.translate === "" ? [{ translate: "0 6px" }, { translate: "0 0" }] : [{}, {}];
      el.animate([{ opacity: 0, ...travel[0] }, { opacity: 1, ...travel[1] }], {
        duration: DURATION_MS,
        easing: EASE_OUT,
        delay: index * STEP_MS,
        fill: "backwards",
      });
    });
  }
}

function sync() {
  const full = document.documentElement.dataset.motion === "full";
  if (full && !observer) {
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  } else if (!full && observer) {
    observer.disconnect();
    observer = null;
    window.removeEventListener("scroll", onScroll, { capture: true });
  }
}

/** Follows the motion level for as long as the window lives. Called once, from each entry point. */
export function startEnterAnimator() {
  if (typeof document === "undefined") return;
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  sync();
}
