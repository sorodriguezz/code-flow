import { useEffect, useRef } from "react";

/**
 * The two mechanics every data grid in this app needs and neither can borrow from the DOM: a column
 * seam you drag, and a row selection you sweep out with the pointer.
 *
 * They live here because there are now three grids — the database result grid, its transposed
 * record view, and the Azure Table entity grid — and the seam had already been written twice with
 * the second copy silently missing the pieces the first had grown. Neither of these knows what a row
 * *is*; both are given a row height and a count and report indices back.
 */

/** Narrower than this and the header text has nowhere to go, so the drag stops. */
export const MIN_COLUMN_WIDTH = 64;

/**
 * `[from..to]`, inclusive. Written out because a selection's ends are both real rows.
 *
 * Here rather than beside the one panel that used to own it because it is the other half of
 * `useRowSweep`: the sweep reports two indices and every caller then has to turn them into the rows
 * between them. An exclusive `to` would put an off-by-one in each of those call sites, on the one
 * operation — "delete these" — where an off-by-one is a row nobody meant to touch.
 */
export function range(from: number, to: number): number[] {
  if (to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, at) => from + at);
}

/**
 * The seam between two column headers. Invisible until hovered — visible dividers in a 28px header
 * row read as a barred table and end up heavier than the labels they separate.
 *
 * **Double-click is auto-fit**, wherever the caller can measure its own content. That is the
 * convention in every spreadsheet and every database tool, and it is the fastest way out of the
 * situation this grid is otherwise prone to: a column of 60-character keys in a 160px default,
 * truncated, with the part that distinguishes one row from another off the right-hand end.
 */
export function ColumnResizer({
  width,
  onChange,
  onAutoFit,
  title,
}: {
  width: number;
  onChange: (width: number) => void;
  onAutoFit?: () => void;
  title?: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(Math.max(MIN_COLUMN_WIDTH, start.current.width + (e.clientX - start.current.x)));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      onDoubleClick={(e) => {
        if (!onAutoFit) return;
        e.preventDefault();
        e.stopPropagation();
        onAutoFit();
      }}
      // No z-index: it is the last child of its header cell, so it already paints over the header
      // button. Lifting it to `z-10` put it level with the sticky row-number gutter in the same
      // stacking context and, being later in tree order, over it — a 6px strip of `col-resize`
      // cursor sitting on the select-all checkbox once the grid scrolled sideways.
      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[var(--cf-accent)]/40"
    />
  );
}

/**
 * Press-and-drag row selection.
 *
 * The hard part is that a windowed grid **doesn't render the rows you're dragging past**: it keeps a
 * window around the viewport, so a drag that relied on `pointerenter` firing per row would select
 * nothing below the fold and would stop dead the moment it outran the window. So the sweep never
 * looks at rows at all — it converts the pointer's y into a row index arithmetically, from the
 * scroll offset and the fixed row height, which is right whether or not that row exists in the DOM.
 *
 * Two things follow from the same choice. Pointer capture is taken on the **scroll container**, not
 * on the row number that was pressed: that row unmounts as soon as the sweep scrolls it out of the
 * window, and capture dies with the element — the drag would stop dead a screenful in. Capturing on
 * the container also keeps the moves coming after the pointer leaves the grid or the window.
 *
 * **The whole drag runs off one animation frame loop**, and that is what makes it feel like dragging
 * rather than like a series of jumps. `move` writes the pointer's position to a ref and returns —
 * it renders nothing. Once per frame the loop scrolls, works out which row is under the pointer, and
 * updates the selection at most once. A pointer device sending 120 events a second would otherwise
 * push 120 renders a second through a grid of several hundred cells, and the edge scroll on a timer
 * moved in visible steps between them.
 */
export function useRowSweep({
  scrollRef,
  headerHeight,
  rowHeight,
  rowCount,
  onSelectRange,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  headerHeight: number;
  rowHeight: number;
  rowCount: number;
  onSelectRange?: (from: number, to: number, additive: boolean) => void;
}) {
  const state = useRef<{
    anchor: number;
    additive: boolean;
    clientY: number;
    last: number;
    time: number;
  } | null>(null);
  const frame = useRef<number | null>(null);
  // Read through a ref so the loop, which is started once per drag, always calls the current
  // handler instead of the one that existed when the pointer went down.
  const latest = useRef({ headerHeight, rowHeight, rowCount, onSelectRange });
  latest.current = { headerHeight, rowHeight, rowCount, onSelectRange };

  const stop = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  useEffect(() => stop, []);

  const tick = (now: number) => {
    const current = state.current;
    const element = scrollRef.current;
    if (!current || !element) {
      frame.current = null;
      return;
    }
    // Clamped, so one dropped frame — a garbage collection, a slow paint — doesn't teleport the
    // scroll a thousand rows.
    const elapsed = Math.min(64, current.time === 0 ? 16 : now - current.time);
    current.time = now;

    const box = element.getBoundingClientRect();
    const above = box.top + latest.current.headerHeight - current.clientY;
    const below = current.clientY - box.bottom;
    const past = above > 0 ? -above : below > 0 ? below : 0;
    if (past !== 0) {
      // Pixels per second, ramped by how far past the edge the pointer is: a hair over the edge
      // creeps, an inch past it flies. Multiplied by the frame's own duration, so the speed is the
      // same on a 60Hz panel and a 120Hz one.
      const speed = Math.sign(past) * Math.min(3000, 260 + Math.abs(past) * 26);
      element.scrollTop += (speed * elapsed) / 1000;
    }

    const y = current.clientY - box.top + element.scrollTop - latest.current.headerHeight;
    const row = Math.min(
      latest.current.rowCount - 1,
      Math.max(0, Math.floor(y / latest.current.rowHeight)),
    );
    if (row !== current.last) {
      current.last = row;
      latest.current.onSelectRange?.(current.anchor, row, current.additive);
    }
    frame.current = requestAnimationFrame(tick);
  };

  return {
    start: (e: React.PointerEvent, row: number, additive: boolean) => {
      if (!onSelectRange) return;
      e.preventDefault();
      scrollRef.current?.setPointerCapture?.(e.pointerId);
      state.current = { anchor: row, additive, clientY: e.clientY, last: row, time: 0 };
      stop();
      frame.current = requestAnimationFrame(tick);
    },
    move: (e: React.PointerEvent) => {
      // Deliberately just a write. Everything the move implies happens on the next frame.
      if (state.current) state.current.clientY = e.clientY;
    },
    end: () => {
      state.current = null;
      stop();
    },
  };
}

/**
 * How wide a string is, in pixels, in the grid's own font.
 *
 * A real measurement rather than `characters × 7px`: the cells are monospace but the headers are
 * not, and a column auto-fitted from a proportional guess is either clipped or twice as wide as it
 * needs to be. One canvas is kept for the life of the app — creating one per column per page is
 * both slower than the measuring and enough garbage to be noticed on a 40-column table.
 */
let measuringContext: CanvasRenderingContext2D | null = null;

export function measureText(text: string, font: string): number {
  if (!measuringContext) {
    measuringContext = document.createElement("canvas").getContext("2d");
    if (!measuringContext) return text.length * 7;
  }
  if (measuringContext.font !== font) measuringContext.font = font;
  return measuringContext.measureText(text).width;
}
