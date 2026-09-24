import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useWindowStore, type WindowReturn } from "../../state/windowStore";
import type { DetachableKind } from "../../lib/windowIdentity";

/**
 * The return this app or repository is in the middle of, if any — `null` the rest of the time.
 *
 * `find` hands back the same object for as long as the return lasts, so a row re-renders when its
 * own answer changes and not when some other island comes back.
 */
export function useWindowReturn(kind: DetachableKind, refId: string): WindowReturn | null {
  return useWindowStore((s) => s.returns.find((r) => r.kind === kind && r.refId === refId) ?? null);
}

/**
 * Where an island landed, said for a moment.
 *
 * Closing an island — its red button, or the "return" button in its title bar — puts the app back
 * on the main window's rail (or the repository back in the projects panel) without a word, and the
 * only change on screen was a dashed outline going solid. This makes the arrival visible: two rings
 * ripple out of the icon it came back to, and a pill beside the icon names it. The icon's own drop
 * into place is the caller's, with `cf-return-land` on its glyph keyed by the return's `id`.
 *
 * Render it inside the element it marks, which must be `relative`: the rings take that element's
 * box and corner radius. The pill is portalled and placed from that box once, on mount — it lives
 * two seconds, and nothing it sits next to moves in that time.
 *
 * `side` is where the pill goes: `left` of the rail, which is on the window's right edge, and
 * `right` of the projects panel, which is on its left. `besideOf` moves it out past an ancestor —
 * the unfolded projects panel, where a pill right of the chip would sit on top of the very name
 * it is announcing.
 */
export function ReturnBurst({
  label,
  leading,
  side,
  besideOf,
  tone = "var(--cf-accent)",
}: {
  label: string;
  /** Drawn before the label — the app's glyph, the repository's monogram. */
  leading?: ReactNode;
  side: "left" | "right";
  /** A selector for the ancestor the pill clears horizontally, instead of the marked element. */
  besideOf?: string;
  /** The rings' colour: the accent for an app, the repository's own colour for a repository. */
  tone?: string;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const own = el.getBoundingClientRect();
    // Vertically on the marked element; horizontally clear of it, or of `besideOf` when given.
    const edge = (besideOf ? el.closest(besideOf) : null)?.getBoundingClientRect() ?? own;
    const top = own.top + own.height / 2;
    setPlace(side === "left" ? { top, right: window.innerWidth - edge.left + 10 } : { top, left: edge.right + 10 });
    // Measured once: the pill lives two seconds and nothing it sits beside moves in that time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <span
        ref={box}
        aria-hidden
        className="cf-return-ripple pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ borderColor: tone }}
      />
      <span
        aria-hidden
        className="cf-return-ripple cf-return-ripple-2 pointer-events-none absolute inset-0 rounded-[inherit]"
        style={{ borderColor: tone }}
      />
      {place &&
        createPortal(
          // Three layers so the three transforms do not fight: the fixed box places the pill, the
          // middle one centres it on the icon, and the inner one is the only thing that animates.
          <div role="status" className="pointer-events-none fixed z-[70]" style={place}>
            <div className="-translate-y-1/2">
              <div
                className="cf-return-pill flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--cf-accent-line)] bg-[var(--cf-surface-raised)] pl-2 pr-3 text-[12px] font-medium text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
                style={{ "--cf-return-dx": side === "left" ? "8px" : "-8px" } as CSSProperties}
              >
                {leading}
                {label}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
