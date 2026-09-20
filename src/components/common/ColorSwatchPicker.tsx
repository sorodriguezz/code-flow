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
export function ColorSwatchPicker({
  value,
  onChange,
  trigger,
  title,
  open: openProp,
  onOpenChange,
  align = "end",
  allowNone = false,
  noneTitle,
}: {
  value: string;
  onChange: (color: string) => void;
  /**
   * What the user clicks, when the dot is not the right shape for it.
   *
   * The chat's folders wear their colour as a folder glyph rather than as a dot beside one, and a
   * second control next to the glyph would be two things saying one thing. Passing the glyph in
   * keeps the popover, the outside-click and the flip-above logic here instead of copied there.
   * Omitted, this draws the round swatch the Settings rows have always used.
   */
  trigger?: React.ReactNode;
  /** Overrides the hover text, which otherwise reads the raw hex — right for a Settings row that
   *  is literally about the colour, wrong for a glyph whose colour is the least of what it says. */
  title?: string;
  /**
   * Opens the palette from somewhere else, when the swatch is not the only way in.
   *
   * The chat's folders have two: the coloured glyph itself, and a "Folder colour" entry in the
   * right-click menu — because an eleven-pixel glyph does not announce that it is a control, and a
   * user who goes looking for the option goes to the menu. Both still open *this* popover, anchored
   * to the glyph, so there is one palette and one place that knows where it goes. Leave both props
   * out and the component owns its own state, which is what the Settings rows do.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Which edge of the palette lines up with the trigger.
   *
   * `"end"` — the palette's right edge against the swatch's — is right for the Settings rows, where
   * the swatch is the last thing on a wide row and the space is all to its left. It is wrong for a
   * glyph near the left edge of a narrow column: a 130px popover hung by its right corner off an
   * eleven-pixel folder lands mostly *outside* the sidebar, over the workspace rail, looking like
   * it belongs to something else. Those callers pass `"start"`.
   */
  align?: "start" | "end";
  /**
   * Offers "no colour of its own", which stores `""`.
   *
   * Only for rows that have somewhere to fall back *to*. A chat folder does: with no colour it
   * draws in whatever accent the app is set to, so the folder keeps matching the window when the
   * user changes the theme. A workspace has no such fallback, so Settings leaves this off.
   */
  allowNone?: boolean;
  /** Hover text for the none cell, since this component has no dictionary of its own. */
  noneTitle?: string;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : ownOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    onOpenChange?.(next);
  };
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
    const anchored = align === "start" ? rect.left : rect.right - width;
    const left = Math.max(EDGE, Math.min(anchored, window.innerWidth - width - EDGE));
    setPos({ top, left });
  }, [open, align]);

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
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title={title ?? value}
        className={
          trigger
            ? "flex shrink-0 items-center justify-center rounded"
            : "h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
        }
        style={trigger ? undefined : { background: value }}
      >
        {trigger}
      </button>
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
            {/* First, because it is the state a folder starts in and the one you come back to —
                and because a cell that means "none" belongs before the choices, not hidden after
                thirty of them. Drawn as the live accent with a slash through it: showing the
                colour it will actually use is more honest than an empty circle, and the slash is
                what keeps it from reading as a thirty-first colour. */}
            {allowNone && (
              <button
                title={noneTitle}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="h-3.5 w-3.5 rounded-full"
                style={{
                  backgroundColor: "var(--cf-accent)",
                  backgroundImage:
                    "linear-gradient(45deg, transparent 42%, var(--cf-surface-raised) 42%, var(--cf-surface-raised) 58%, transparent 58%)",
                  boxShadow: value
                    ? undefined
                    : "0 0 0 1.5px var(--cf-surface-raised), 0 0 0 3px var(--cf-accent)",
                }}
              />
            )}
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
