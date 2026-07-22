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
      className={`group shrink-0 select-none ${
        axis === "x" ? "w-1.5 cursor-col-resize" : "h-1.5 cursor-row-resize"
      }`}
    >
      <div
        className={`bg-transparent group-hover:bg-[var(--cf-accent)]/50 group-active:bg-[var(--cf-accent)] ${
          axis === "x" ? "mx-auto h-full w-px" : "my-auto h-px w-full"
        }`}
      />
    </div>
  );
}
