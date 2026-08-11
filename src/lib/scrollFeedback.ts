/**
 * Marks whatever is being scrolled with `data-cf-scrolling` for as long as it is moving, so the
 * scrollbar can show a little more of itself while you are actually using it. The three weights it
 * feeds are in `index.css`, next to the scrollbar rules.
 *
 * A *data attribute* rather than a class: these elements belong to React, and React rewrites
 * `className` wholesale on every re-render — a class added from the outside gets dropped the next
 * time the component renders, which in a scrolling list is constantly. Attributes it doesn't set
 * are left alone.
 */

/** How long after the last scroll event the bar goes back to its resting hairline. Long enough to
 * ride out the gap between two flicks of a wheel; short enough that a bar left wide reads as a
 * mistake rather than as a state. */
const SETTLE_MS = 500;

const MARK = "data-cf-scrolling";

/** One frame at 60Hz. The most often the settle timer is worth re-arming — see `onScroll`. */
const FRAME_MS = 16;

interface Settle {
  /** The pending `removeAttribute` timer. */
  timer: number;
  /** When it was armed, so a frame's worth of scroll events arms it once instead of 120 times. */
  at: number;
}

/** Per-element, so two panes scrolling at once don't clear each other's mark. Weak so a pane that
 * unmounts mid-scroll takes its entry with it. */
const settling = new WeakMap<Element, Settle>();

export function startScrollFeedback(): () => void {
  const onScroll = (event: Event) => {
    const target = event.target;
    // Scrolling the page itself reports the Document, which has no attributes and no scrollbar of
    // its own here — the app root is `overflow: hidden`.
    if (!(target instanceof Element)) return;

    // Only when it isn't already there. `setAttribute` with the value it already has is not a
    // no-op: it invalidates style for the scroller's whole subtree through the `[data-cf-scrolling]`
    // selector. This handler sees every scroll event from every pane in the app — 60-120/s per
    // flick, across ~186 scrollable containers — so the redundant writes were most of them.
    if (!target.hasAttribute(MARK)) target.setAttribute(MARK, "");

    const now = performance.now();
    const pending = settling.get(target);
    // Re-arming the removal timer more than once a frame buys nothing measurable: the mark would
    // outlive the last event by at most one extra frame against a 500ms settle. The bar still
    // widens on the very first event of a flick and still goes back to its hairline SETTLE_MS
    // after the last one; what goes away is a clearTimeout/setTimeout pair per event.
    if (pending && now - pending.at < FRAME_MS) return;
    if (pending) clearTimeout(pending.timer);
    settling.set(target, {
      at: now,
      timer: window.setTimeout(() => {
        target.removeAttribute(MARK);
        settling.delete(target);
      }, SETTLE_MS),
    });
  };

  // Capture, because `scroll` does not bubble: listening at the document only sees the scroll of
  // every pane in the app from up here.
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}
