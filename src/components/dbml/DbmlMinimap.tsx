import { useEffect, useRef } from "react";
import type { DbmlLayout } from "../../lib/dbml/layout";

/**
 * The whole diagram, small, above the zoom (the user's ask, 2026-10-06: "un mapa global del
 * diagrama"): every table as a block and the part the canvas shows as an outlined window.
 *
 * **It only shows.** It was a control too — a press or a drag moved the canvas there — and the user
 * took that back the same day ("que no se pueda interactuar con él, solo que indique dónde está la
 * vista y los cuadros"). A press on it lands on nothing: not on the map, and not on the canvas under
 * it either, which it hides. It is as wide as the zoom under it — its parent decides — and keeps the
 * shape below.
 *
 * **It never re-renders to follow the canvas.** The canvas pans by writing its transform straight to
 * the `<svg>` (`DbmlCanvas.applyView`) — sixty times a second during a drag — and reports each one
 * through `onView`; this map does the same with two attributes: its own `viewBox`, which takes in
 * whatever is in sight (so the window never leaves the map), and the window's rectangle. React only
 * redraws the blocks when the layout itself changes.
 */

/** What the canvas shows: its transform, and the frame's size in screen pixels. */
export interface DbmlView {
  x: number;
  y: number;
  k: number;
  width: number;
  height: number;
}

/** Width over height. */
const MAP_ASPECT = "8 / 5";

export function DbmlMinimap({
  layout,
  selected,
  subscribe,
  label,
}: {
  layout: DbmlLayout;
  selected: string | null;
  /** Hands the map the canvas's views as they happen — the current one first. Returns the unsubscribe. */
  subscribe: (draw: (view: DbmlView) => void) => () => void;
  label: string;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef<SVGRectElement>(null);
  const lastView = useRef<DbmlView | null>(null);

  useEffect(() => {
    const draw = (view: DbmlView) => {
      lastView.current = view;
      const map = svg.current;
      const outline = frame.current;
      if (!map || !outline || view.k <= 0) return;
      const vx = -view.x / view.k;
      const vy = -view.y / view.k;
      const vw = view.width / view.k;
      const vh = view.height / view.k;
      const empty = layout.width === 0 && layout.height === 0;
      const minX = empty ? vx : Math.min(layout.minX, vx);
      const minY = empty ? vy : Math.min(layout.minY, vy);
      const maxX = empty ? vx + vw : Math.max(layout.minX + layout.width, vx + vw);
      const maxY = empty ? vy + vh : Math.max(layout.minY + layout.height, vy + vh);
      const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
      map.setAttribute("viewBox", `${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`);
      outline.setAttribute("x", String(vx));
      outline.setAttribute("y", String(vy));
      outline.setAttribute("width", String(Math.max(vw, 0)));
      outline.setAttribute("height", String(Math.max(vh, 0)));
    };
    const stop = subscribe(draw);
    // A new layout moves the blocks under the window: redraw it against them now, not at the next pan.
    if (lastView.current) draw(lastView.current);
    return stop;
  }, [subscribe, layout]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]">
      <svg
        ref={svg}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
        className="block w-full"
        style={{ aspectRatio: MAP_ASPECT }}
      >
        {layout.groups.flatMap((group) =>
          group.rects.map((rect, index) => (
            <rect
              key={`${group.id}-${index}`}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              rx={8}
              fill="none"
              stroke="var(--cf-border-strong)"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )),
        )}
        {layout.nodes.map((node) => (
          <rect
            key={node.id}
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={6}
            fill={node.id === selected ? "var(--cf-accent)" : layout.enumIds.has(node.id) ? "var(--cf-text-faint)" : "var(--cf-text-muted)"}
            fillOpacity={node.id === selected ? 0.9 : 0.45}
          />
        ))}
        <rect
          ref={frame}
          rx={4}
          fill="color-mix(in oklab, var(--cf-accent) 10%, transparent)"
          stroke="var(--cf-accent)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
