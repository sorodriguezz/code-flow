import { useRef, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { usePullToRefresh } from "./gestures";

/**
 * The layout every screen in this client uses: a sticky bar, a scrolling body, and — where there is
 * something to re-read — pull-to-refresh.
 *
 * # Why the body owns the scroll and not the page
 *
 * `body` never scrolls here (see `mobile.css`), because the shell is a fixed box sized to the
 * *visual* viewport. So each screen's body is its own scroll container, which is also what lets a
 * pushed screen keep its own scroll position while the screen underneath keeps its own.
 */
export function Screen({
  bar,
  children,
  onRefresh,
  className = "",
  /** Turns the body's padding off, for screens that draw edge-to-edge — the diff, the terminal. */
  bare,
}: {
  bar?: ReactNode;
  children: ReactNode;
  onRefresh?: () => void | Promise<unknown>;
  className?: string;
  bare?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  usePullToRefresh(scroller, indicator, onRefresh ?? (() => undefined), Boolean(onRefresh));

  return (
    <div className={`flex min-h-0 flex-1 flex-col bg-[var(--cf-bg)] ${className}`}>
      {bar}
      <div className="relative min-h-0 flex-1">
        {onRefresh && (
          // Above the content and outside the scroller, so it is not itself scrolled away by the
          // gesture that is dragging it into view.
          <div
            ref={indicator}
            aria-hidden
            style={{ opacity: 0 }}
            className="pointer-events-none absolute inset-x-0 top-1 z-10 flex justify-center"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text-muted)] shadow-raised">
              <RefreshCw
                size={14}
                // Turns as the pull approaches its threshold — the variable is written by the
                // gesture hook, frame by frame.
                style={{ transform: "rotate(calc(var(--cf-pull, 0) * 180deg))" }}
              />
            </span>
          </div>
        )}
        <div
          ref={scroller}
          className={`cf-scroll absolute inset-0 ${bare ? "" : "px-3 pb-8"}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
