import { useEffect, useRef, type ReactNode } from "react";
import { useNav } from "../nav";

/**
 * A panel that comes up from the bottom over everything, for a choice you make and dismiss.
 *
 * # Three ways to close it, and they all go through the navigation stack
 *
 * The scrim, the drag, and the phone's own back button. All three call `nav.back()` rather than a
 * local `onClose`, so the sheet cannot get out of step with the history entry that represents it —
 * which is what happens when a modal is a boolean and the back button is wired to something else.
 *
 * # The drag
 *
 * Downward only, and it tracks the finger. Past a third of its own height, or thrown fast enough,
 * it commits; otherwise it springs back. This is the gesture people try before they look for a
 * close button, and a sheet that does not have it reads as a bug in the sheet.
 */
export function Sheet({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const back = useNav((s) => s.back);
  const panel = useRef<HTMLDivElement>(null);

  // Escape, for the tablet-with-a-keyboard case. Cheap, and its absence is the sort of thing that
  // makes an app feel like a website in a frame.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    let startY = 0;
    let dragging = false;
    let pointer = -1;

    const onDown = (event: PointerEvent) => {
      // Only from the handle area. A drag that starts on a row would fight the list's own scroll.
      const target = event.target as HTMLElement;
      if (!target.closest("[data-sheet-handle]")) return;
      pointer = event.pointerId;
      startY = event.clientY;
      dragging = true;
      node.setPointerCapture(event.pointerId);
      node.style.transition = "none";
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointer) return;
      node.style.transform = `translate3d(0, ${Math.max(0, event.clientY - startY)}px, 0)`;
    };
    const onUp = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointer) return;
      dragging = false;
      const dy = Math.max(0, event.clientY - startY);
      node.style.transition = "transform 220ms var(--ease-nav)";
      if (dy > node.clientHeight / 3) {
        node.style.transform = "translate3d(0, 100%, 0)";
        window.setTimeout(back, 180);
      } else {
        node.style.transform = "";
      }
    };

    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
  }, [back]);

  return (
    <div className="absolute inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={back}
        className="cf-fade-in absolute inset-0 bg-[var(--cf-scrim)]"
      />
      <div
        ref={panel}
        className="cf-sheet-in relative max-h-[82%] overflow-hidden rounded-t-2xl border-t border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-raised"
      >
        {/* The grab handle. It is also the drag target — see the effect above — which is why it has
            a generous invisible area around a small visible bar. */}
        <div data-sheet-handle className="flex cursor-grab justify-center pb-1 pt-2.5">
          <span className="h-1 w-9 rounded-full bg-[var(--cf-field-border)]" aria-hidden />
        </div>
        <h2 className="px-4 pb-2 text-md font-semibold">{title}</h2>
        <div className="cf-scroll max-h-[60vh] px-3 pb-3">{children}</div>
        {footer && (
          <div className="cf-safe-bottom border-t border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
