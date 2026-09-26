import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { GripHorizontal, X } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { useT } from "../../state/languageStore";

/** Where the window opens: inset from its pane's top-right corner, over the gutter rather than over
 *  the caret, which is where someone typing at the top of a document actually is. */
const MARGIN = 12;

/**
 * The window an AI run over a document is asked from — the note's "write with AI", the wiki's
 * "generate". One shell so the two cannot drift: what the run needs goes in `children`, what it can
 * do next in `footer`.
 *
 * **Floating over the editor, not a modal.** The instruction is written *about* the text underneath
 * it — "expand this section", "leave the deployment out" — and a full-screen dialog covers the one
 * thing the user needs to look at while writing it. So there is no backdrop, the editor stays live
 * behind it, and the window can be dragged out of the way by its header.
 *
 * `absolute`, against the nearest positioned ancestor — the caller makes that the editor's pane, so
 * the window travels with it and is kept inside it when the pane is resized under it.
 */
export function FloatingAiWindow({
  title,
  closable = true,
  onClose,
  children,
  footer,
}: {
  title: string;
  /** `false` while the only thing left to do is stop the run — the ✕ and Escape both wait for it. */
  closable?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  /** Null until the window is dragged: it sits at its default corner, laid out by the browser, so
   *  a pane resize keeps it in the corner instead of stranding it at coordinates from a wider one. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  /** Keeps the window inside its pane. Called while dragging and whenever the pane resizes —
   *  opening a side panel or dragging a split narrows it under a window already placed. */
  const clamp = useCallback((x: number, y: number) => {
    const element = panel.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - element.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - element.offsetHeight);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  useLayoutEffect(() => {
    const parent = panel.current?.offsetParent as HTMLElement | null;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPos((current) => (current ? clamp(current.x, current.y) : null));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [clamp]);

  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = panel.current;
    if (!element || event.button !== 0) return;
    // Never from a control inside the header. `setPointerCapture` retargets the rest of the gesture
    // to the element that took it — the `click` included — so a header that captures on every
    // pointerdown swallows its own close button's click and the ✕ does nothing at all.
    if ((event.target as Element).closest("button")) return;
    // From the live box, not from `pos`: the first drag starts wherever the default corner put it,
    // and reading it here is what makes that first grab not jump.
    drag.current = { dx: event.clientX - element.offsetLeft, dy: event.clientY - element.offsetTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPos(clamp(event.clientX - drag.current.dx, event.clientY - drag.current.dy));
  };

  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !closable) return;
      // A menu opened from inside — the model picker's — owns Escape first, and so does a dialog
      // raised over the page ("regenerate this document?"): dismissing either must not take the
      // half-written instruction under it along.
      if (document.querySelector('[role="menu"], [aria-modal="true"]')) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, closable]);

  return (
    <div
      ref={panel}
      style={pos ? { left: pos.x, top: pos.y } : { right: MARGIN, top: MARGIN }}
      // The accent border is what separates a window standing over the text from a panel docked
      // into the layout.
      className="cf-fade-in absolute z-30 w-[340px] max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="flex cursor-grab touch-none items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5 active:cursor-grabbing"
      >
        <AiSparkles size={13} className="shrink-0" />
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--cf-text)]">{title}</h2>
        <GripHorizontal size={12} className="shrink-0 text-[var(--cf-text-muted)] opacity-60" />
        <button
          type="button"
          onClick={onClose}
          disabled={!closable}
          aria-label={t("common.close")}
          className="shrink-0 text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2 p-2.5">{children}</div>

      <div className="flex items-center justify-end gap-1.5 border-t border-[var(--cf-border)] px-2.5 py-1.5">
        {footer}
      </div>
    </div>
  );
}
