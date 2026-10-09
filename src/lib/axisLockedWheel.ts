/**
 * Scrolling along one axis per gesture, never diagonally.
 *
 * A trackpad swipe is never perfectly straight: a swipe down carries a little `deltaX` in every
 * event, so a scroller that overflows both ways drifts sideways while you meant to go down (user
 * report on the explorer, once long names made it scroll sideways: "queda raro").
 *
 * The first event of a gesture picks the axis — whichever it moved further along — and the gesture
 * keeps it until the wheel has been quiet for `GESTURE_GAP_MS`. That is longer than the gaps inside
 * a momentum fling, so the coast after a swipe stays on the swipe's axis.
 *
 * Only events that would move the other axis are taken over. A purely vertical event under a
 * vertical lock — every mouse-wheel notch, most of a trackpad swipe — is left to the browser, so its
 * smooth scrolling and overscroll stay native; one with a stray sideways component is cancelled and
 * replayed along the locked axis alone.
 */
export const GESTURE_GAP_MS = 180;

export type WheelAxis = "x" | "y";

/** The axis a gesture locks to: the one its first event moved further along. A tie goes to
 * vertical, the axis a list is read along. */
export function dominantAxis(deltaX: number, deltaY: number): WheelAxis {
  return Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
}

/** `deltaMode` to pixels: lines (Firefox's mouse wheel) at a typical line height, pages at the
 * scroller's own size. */
function pixels(delta: number, mode: number, page: number): number {
  if (mode === 1) return delta * 16;
  if (mode === 2) return delta * page;
  return delta;
}

/** The slice of an element this needs — an `HTMLElement` in the app, a stand-in in the tests. */
export interface WheelScroller {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  addEventListener(type: "wheel", listener: (event: WheelEvent) => void, options: AddEventListenerOptions): void;
  removeEventListener(type: "wheel", listener: (event: WheelEvent) => void): void;
}

/** Locks `element`'s wheel scrolling to one axis per gesture. Returns the undo. */
export function lockWheelAxis(element: WheelScroller): () => void {
  let axis: WheelAxis | null = null;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const onWheel = (event: WheelEvent) => {
    // A pinch arrives as a wheel with ctrl held: a zoom, not a scroll.
    if (event.ctrlKey) return;
    // Nothing to scroll sideways: the browser already scrolls one way only.
    if (element.scrollWidth <= element.clientWidth) return;
    axis ??= dominantAxis(event.deltaX, event.deltaY);
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      axis = null;
    }, GESTURE_GAP_MS);
    const stray = axis === "y" ? event.deltaX : event.deltaY;
    if (stray === 0) return;
    event.preventDefault();
    if (axis === "y") element.scrollTop += pixels(event.deltaY, event.deltaMode, element.clientHeight);
    else element.scrollLeft += pixels(event.deltaX, event.deltaMode, element.clientWidth);
  };
  // Not passive: cancelling the stray half of an event is the whole job.
  element.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    clearTimeout(quiet);
    element.removeEventListener("wheel", onWheel);
  };
}
