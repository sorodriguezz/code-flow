import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /**
   * Whether the entry animation is finished and can come off the element.
   *
   * Without this the drag below did nothing at all. `cf-sheet-in` is `animation: … both`, so it goes
   * on applying its final keyframe — `translate3d(0,0,0)` — forever, and a CSS animation's values
   * outrank the `style` attribute. Every inline transform the drag wrote was discarded, silently,
   * and the panel sat still under the finger. Same cascade trap as the navigation layers; same fix.
   */
  const [entered, setEntered] = useState(false);

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
      if (dragging || !event.isPrimary) return;
      // Only from the handle area. A drag that starts on a row would fight the list's own scroll.
      const target = event.target as HTMLElement;
      if (!target.closest("[data-sheet-handle]")) return;
      pointer = event.pointerId;
      startY = event.clientY;
      dragging = true;
      // Takes the entry animation off for good — see `entered`.
      setEntered(true);
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        /* the pointer is already gone; the listeners on the element still fire */
      }
      node.style.transition = "none";
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointer) return;
      node.style.transform = `translate3d(0, ${Math.max(0, event.clientY - startY)}px, 0)`;
    };
    const onUp = (event: PointerEvent) => {
      if (!dragging || event.pointerId !== pointer) return;
      dragging = false;
      pointer = -1;
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
        onAnimationEnd={(event) => {
          if (event.animationName === "cf-sheet-up") setEntered(true);
        }}
        className={`relative max-h-[82%] overflow-hidden rounded-t-2xl border-t border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-raised ${
          entered ? "" : "cf-sheet-in"
        }`}
      >
        {/* The grab handle. It is also the drag target — see the effect above — which is why it has
            a generous invisible area around a small visible bar. */}
        <div data-sheet-handle className="flex cursor-grab justify-center pb-1 pt-2.5">
          <span className="h-1 w-9 rounded-full bg-[var(--cf-field-border)]" aria-hidden />
        </div>
        <h2 className="px-4 pb-2 text-md font-semibold">{title}</h2>
        <div className="cf-scroll max-h-[60vh] px-3 pb-3">{children}</div>
        {footer && (
          // The padding is on an inner element on purpose: `.cf-safe-bottom` lives in
          // `@layer components` and a `p-*` utility on the same element replaces its padding
          // outright, taking the home-indicator inset with it. See the note in `mobile.css`.
          <div className="cf-safe-bottom border-t border-[var(--cf-border)] bg-[var(--cf-surface)]">
            <div className="p-3">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}
