import { useEffect, useRef, type ReactNode } from "react";

/**
 * A bar pinned to the bottom of a screen — the commit composer, the chat composer, the terminal's
 * key row — that tells the rest of the app how tall it is.
 *
 * # Why the height has to be published
 *
 * The toasts are anchored to the bottom of the content area, because that is where the thumb that
 * caused them is. On a screen with a composer that put them squarely over the text box: a failed
 * commit covered the message it had failed to commit, for five seconds, with the button to try
 * again underneath it.
 *
 * Moving the toasts to the top was the other option and it is worse — the top of a pushed screen is
 * the back control, and covering the way out of a screen to report an error is exactly the class of
 * mistake this whole rewrite is about. So the bar measures itself instead and writes its height to
 * `--cf-bottom-bar`, which `Toaster` reads. A `ResizeObserver` rather than a one-off measurement,
 * because the composer grows as you type.
 *
 * The variable is written on `#root` and cleared on unmount, so a screen without a bar leaves the
 * toasts at the bottom of the pane where they belong.
 */
export function BottomBar({ children, className = "" }: { children: ReactNode; className?: string }) {
  const node = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = node.current;
    const root = document.getElementById("root");
    if (!element || !root) return;
    const publish = () => root.style.setProperty("--cf-bottom-bar", `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--cf-bottom-bar");
    };
  }, []);

  return (
    // Two elements, and the split is load-bearing: `.cf-safe-x` is a `@layer components` rule and a
    // `p-*` utility on the same element replaces its padding outright — which would silently delete
    // the landscape safe-area inset that is this class's only job. The caller's padding goes inside.
    <div
      ref={node}
      className="cf-safe-x shrink-0 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-bar"
    >
      <div className={className}>{children}</div>
    </div>
  );
}
