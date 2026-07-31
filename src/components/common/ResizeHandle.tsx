import { useRef, useState } from "react";

/** How far the glow reaches along the seam before it has faded to nothing, in pixels. */
const GLOW_REACH = 60;

interface ResizeHandleProps {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  /**
   * Told when a drag starts and ends.
   *
   * For a panel whose size is animated. An open/close transition and a drag want opposite things
   * from the same property — one wants easing, the other wants the edge under the pointer — and
   * without knowing which is happening the panel eases toward every intermediate width and trails
   * the cursor by the whole duration.
   */
  onDragChange?: (dragging: boolean) => void;
  /** Set when the handle sits to the left/top of the panel it resizes, so dragging
   * toward the panel should still grow it (e.g. a panel anchored to the right edge). */
  invert?: boolean;
  /**
   * Draws nothing until the pointer is on it. For handles that divide *columns of a table* rather
   * than panes of a layout.
   *
   * The default styling is sized for a panel seam: a hairline the full height of the divider, plus
   * a 24px grip in the middle of it saying "this one drags". Down the side of a 600px panel that
   * grip is a small mark on a long line. In a 24px-tall column header it is the whole line — four
   * of them turn a row of labels into a barred table, and they end up heavier than the header text
   * they separate. Here the cursor is the affordance, and the seam only appears under the pointer.
   */
  quiet?: boolean;
}

export function ResizeHandle({
  axis,
  value,
  min,
  max,
  onChange,
  onCommit,
  onDragChange,
  invert,
  quiet,
}: ResizeHandleProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const dragStart = useRef<{ pos: number; value: number } | null>(null);
  /** Where the pointer is *along* the seam, in pixels from its start. `null` when it isn't on it. */
  const [glow, setGlow] = useState<number | null>(null);

  const posOf = (e: React.PointerEvent) => (axis === "x" ? e.clientX : e.clientY);

  const trackGlow = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setGlow(axis === "x" ? e.clientY - rect.top : e.clientX - rect.left);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pos: posOf(e), value: valueRef.current };
    onDragChange?.(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // Tracked whether or not a drag is under way: the pointer is captured while dragging, so this
    // stays the only source of truth for where the glow belongs even once the pointer has left.
    trackGlow(e);
    if (!dragStart.current) return;
    let delta = posOf(e) - dragStart.current.pos;
    if (invert) delta = -delta;
    onChange(Math.min(max, Math.max(min, dragStart.current.value + delta)));
  };

  const handlePointerUp = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    onDragChange?.(false);
    onCommit(valueRef.current);
  };

  return (
    // The seam *is* the element: one pixel of layout, drawn in the border colour so the edge reads
    // as one of the app's own dividers rather than as new chrome. It used to be 6px wide with the
    // line centred inside it, which meant every divider in the app also spent five pixels of
    // background — visible as a gap once the panels went flush. The grab area below gets those
    // pixels back without taking any layout.
    //
    // `z-[15]` puts the whole handle — seam, glow, grip and grab area — above panel *content* and
    // below the app's floating chrome. The parts that make the seam legible overhang the panels
    // either side by a pixel or two, and a grid's own sticky headers and pinned gutter carry
    // z-indexes of their own; without a layer here the table paints its background over the grip
    // and the divider comes out half-drawn wherever a panel happens to be scrolled. The tiers this
    // sits between: panel content (up to `z-10`) < this < menus (`z-20`) < dialogs (`z-40`+).
    <div
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={`group relative z-[15] shrink-0 select-none ${
        // One pixel is the floor for the *layout* — anything less and the panels stop being flush
        // against a real edge — so the line is thinned by weight rather than by width: the border
        // colour at 60% reads as a hairline between two panes instead of a drawn rule.
        quiet ? "" : "bg-[var(--cf-border)]/60"
      } ${axis === "x" ? "w-px" : "h-px"}`}
    >
      {/* The grab area: wider than the line, centred on it, and overlapping the panels either side.
          A one-pixel target would be unusable, so the pointer gets nine pixels while the layout
          keeps one. Absolutely positioned, so it costs no width; it needs no layer of its own —
          hit-testing follows paint order, and the root's `z-[15]` already lifts it over the halves
          of the panels it reaches into. */}
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerEnter={trackGlow}
        // Not while dragging: the pointer leaves the handle the moment the drag outruns it, and the
        // glow going out mid-drag would read as having lost the seam.
        onPointerLeave={() => dragStart.current === null && setGlow(null)}
        className={`absolute ${
          axis === "x"
            ? "inset-y-0 -left-1 -right-1 cursor-col-resize"
            : "inset-x-0 -top-1 -bottom-1 cursor-row-resize"
        }`}
      />

      {/* The glow: the seam lit under the pointer and fading out along its own length.

          Lighting the whole of a six-hundred-pixel divider to say "you are near the top of this one"
          is both more than the answer needs and less precise than it looks — the eye is told the
          seam is live but not *where* it was grabbed. Lighting the stretch around the pointer says
          both at once, and the fade keeps it from reading as a second, shorter divider on top of the
          first. Painted as a gradient on the 1px line rather than through a mask: one element, no
          vendor prefixes. */}
      {!quiet && glow !== null && (
        <span
          aria-hidden
          className={`pointer-events-none absolute ${
            axis === "x"
              ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
              : "inset-x-0 top-1/2 h-px -translate-y-1/2"
          }`}
          style={{
            backgroundImage: `linear-gradient(${
              axis === "x" ? "to bottom" : "to right"
            }, transparent ${glow - GLOW_REACH}px, var(--cf-accent) ${glow}px, transparent ${
              glow + GLOW_REACH
            }px)`,
          }}
        />
      )}

      {/* The grip. A line alone says "two panes meet here", not "and you can drag it" — this is
          the part that says the seam is a control.

          At rest it only has to be *findable*, not read: two pixels at a fifth of the muted text
          colour, which on a long divider is a faint tick you notice when you go looking for it and
          not a handle bolted to the panel. The weight it needs to be grabbed comes from the hover
          state — that is where it goes accent — so paying for it at rest, on every seam in the
          window at once, buys nothing. */}
      {!quiet && (
        <span
          aria-hidden
          className={`pointer-events-none absolute rounded-full bg-[var(--cf-text-muted)]/20 transition-colors group-hover:bg-[var(--cf-accent)] group-active:bg-[var(--cf-accent)] ${
            axis === "x"
              ? "left-1/2 top-1/2 h-5 w-[2px] -translate-x-1/2 -translate-y-1/2"
              : "left-1/2 top-1/2 h-[2px] w-5 -translate-x-1/2 -translate-y-1/2"
          }`}
        />
      )}
    </div>
  );
}
