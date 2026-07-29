import { useRef } from "react";

interface ResizeHandleProps {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  /** Set when the handle sits to the left/top of the panel it resizes, so dragging
   * toward the panel should still grow it (e.g. a panel anchored to the right edge). */
  invert?: boolean;
}

export function ResizeHandle({ axis, value, min, max, onChange, onCommit, invert }: ResizeHandleProps) {
  const valueRef = useRef(value);
  valueRef.current = value;
  const dragStart = useRef<{ pos: number; value: number } | null>(null);

  const posOf = (e: React.PointerEvent) => (axis === "x" ? e.clientX : e.clientY);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pos: posOf(e), value: valueRef.current };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    let delta = posOf(e) - dragStart.current.pos;
    if (invert) delta = -delta;
    onChange(Math.min(max, Math.max(min, dragStart.current.value + delta)));
  };

  const handlePointerUp = () => {
    if (!dragStart.current) return;
    dragStart.current = null;
    onCommit(valueRef.current);
  };

  return (
    <div
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      className={`group relative shrink-0 select-none ${
        axis === "x" ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"
      }`}
    >
      {/* The seam. Drawn in the border colour at rest so the edge reads as one of the app's own
          dividers rather than as new chrome, and lights up on the way to being dragged. */}
      <div
        className={`bg-[var(--cf-border)] transition-colors group-hover:bg-[var(--cf-accent)]/50 group-active:bg-[var(--cf-accent)] ${
          axis === "x" ? "mx-auto h-full w-px" : "my-auto h-px w-full"
        }`}
      />
      {/* The grip. A line alone says "two panes meet here", not "and you can drag it" — this is
          the part that says the seam is a control. Muted until the pointer is on it. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute rounded-full bg-[var(--cf-text-muted)]/40 transition-colors group-hover:bg-[var(--cf-accent)] group-active:bg-[var(--cf-accent)] ${
          axis === "x"
            ? "left-1/2 top-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2"
            : "left-1/2 top-1/2 h-[3px] w-6 -translate-x-1/2 -translate-y-1/2"
        }`}
      />
    </div>
  );
}
