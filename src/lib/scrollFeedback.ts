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

/** Per-element, so two panes scrolling at once don't clear each other's mark. Weak so a pane that
 * unmounts mid-scroll takes its entry with it. */
const settling = new WeakMap<Element, number>();

export function startScrollFeedback(): () => void {
  const onScroll = (event: Event) => {
    const target = event.target;
    // Scrolling the page itself reports the Document, which has no attributes and no scrollbar of
    // its own here — the app root is `overflow: hidden`.
    if (!(target instanceof Element)) return;

    target.setAttribute(MARK, "");
    const pending = settling.get(target);
    if (pending !== undefined) clearTimeout(pending);
    settling.set(
      target,
      window.setTimeout(() => {
        target.removeAttribute(MARK);
        settling.delete(target);
      }, SETTLE_MS),
    );
  };

  // Capture, because `scroll` does not bubble: listening at the document only sees the scroll of
  // every pane in the app from up here.
  document.addEventListener("scroll", onScroll, true);
  return () => document.removeEventListener("scroll", onScroll, true);
}
