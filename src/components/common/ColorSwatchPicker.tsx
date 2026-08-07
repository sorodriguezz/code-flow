import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WORKSPACE_COLORS } from "../../lib/workspaceColors";

// A curated palette rather than a freeform picker, for the reason `workspaceColors` documents at
// length: one hex has to hold up on both themes, and most of the colour space doesn't.

const GAP = 4;
const EDGE = 8;

// Collapsed to just the currently selected color so it can sit compactly next to actions
// like the delete button, instead of always showing every option inline — click it to
// pop open the rest of the palette.
//
// The palette renders in a portal, positioned `fixed` from the swatch's viewport rect, because
// its callers sit inside scroll containers (the Settings modal clips with `overflow-hidden` /
// `overflow-auto`). An absolutely-positioned popover gets cropped at the container edge there,
// and no z-index fixes that — escaping the container is what does. Same approach as `Select`.
export function ColorSwatchPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Measured after mount (hidden until then) so the palette can flip above the swatch when it
  // wouldn't fit below, and stay inside the viewport horizontally.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const { width, height } = pop.getBoundingClientRect();
    const below = rect.bottom + GAP;
    const top = below + height > window.innerHeight - EDGE ? rect.top - height - GAP : below;
    const left = Math.max(EDGE, Math.min(rect.right - width, window.innerWidth - width - EDGE));
    setPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    // A fixed popover doesn't follow its anchor, so any scroll (in any ancestor, hence capture)
    // would leave it stranded — close instead of tracking.
    const onScroll = () => setOpen(false);
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <div className="flex shrink-0">
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={value}
        className="h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
        style={{ background: value }}
      />
      {open &&
        createPortal(
          <div
            ref={popRef}
            onClick={(e) => e.stopPropagation()}
            style={{
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            // A grid rather than a wrapping row: the palette is ordered by hue, and six to a line
            // is what turns that order into rows you can scan — a wrap would re-flow the bands
            // every time the list grew or the swatch size changed.
            className="fixed z-[9999] grid w-[130px] grid-cols-6 gap-1.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)]"
          >
            {WORKSPACE_COLORS.map((color) => (
              <button
                key={color}
                title={color}
                onClick={() => {
                  onChange(color);
                  setOpen(false);
                }}
                className="h-3.5 w-3.5 rounded-full"
                style={{
                  background: color,
                  boxShadow: value === color ? `0 0 0 1.5px var(--cf-surface-raised), 0 0 0 3px ${color}` : undefined,
                }}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
