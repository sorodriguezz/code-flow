import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ScrollLedger } from "../../lib/useScrollMemory";

/**
 * The wrapper of a main view that stays mounted while another is shown (`display: none` via `hidden`).
 *
 * Hiding with `display: none` drops the layout box, and every scroll offset inside goes with it — so
 * the selection and the open tab were still there on return (state lives in the mounted view) but
 * every list, grid and transcript was back at the top. This records each scroller's offset as it
 * scrolls (capture-phase listener: scroll does not bubble) and puts them back when the view is shown
 * again. Nothing is recorded while hidden, so the zeros the browser reports then cannot overwrite a
 * real position, and positions recorded under another workspace or repository (`scope`) are dropped
 * rather than applied to different rows.
 */
export function KeepScroll({
  active,
  scope,
  className,
  children,
}: {
  active: boolean;
  scope: string;
  className?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const ledger = useRef(new ScrollLedger<HTMLElement>());
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !active) return;
    ledger.current.restore(scope);
    // Content that renders late (virtual lists) is not tall enough on the first pass.
    const raf = requestAnimationFrame(() => ledger.current.restore(scope));
    return () => cancelAnimationFrame(raf);
  }, [active, scope]);

  return (
    <div
      ref={root}
      className={className}
      onScrollCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || !root.current) return;
        // Hidden: no layout box, nothing real to record.
        if (root.current.getClientRects().length === 0) return;
        ledger.current.record(target, scopeRef.current);
      }}
    >
      {children}
    </div>
  );
}
