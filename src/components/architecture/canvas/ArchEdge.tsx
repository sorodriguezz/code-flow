/**
 * A connection on the canvas: the path the orthogonal router chose for the scene, with its arrow,
 * its step number and its pill — the export's own pieces. While either end is being dragged the
 * route is stale, so the line follows the two boxes with a live elbow instead, and the pill waits
 * for the drop (the new scene routes it again).
 */
import { memo } from "react";
import { BaseEdge, useInternalNode, type Edge, type EdgeProps } from "@xyflow/react";
import { roundedPath } from "../../../lib/diagrams/archify/layout/route";
import type { SceneEdge } from "../../../lib/architecture/layout";
import { useArchDragStore } from "./canvasState";

export interface EdgeData extends Record<string, unknown> {
  edge: SceneEdge;
  /** The pill's slot, as SVG — the protocol, or the request rate in Simulate. */
  label: string;
  width: number;
  color: string;
  dashed: boolean;
  marker: "sync" | "async" | "hot" | "down";
  dim: boolean;
}

export type ArchEdgeT = Edge<EdgeData, "arch">;

type Rect = { x: number; y: number; w: number; h: number };

/** A two-bend orthogonal line between the boxes' facing sides. */
function elbow(a: Rect, b: Rect): string {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const vertical = Math.abs(bcy - acy) >= Math.abs(bcx - acx);
  if (vertical) {
    const down = bcy > acy;
    const y1 = down ? a.y + a.h : a.y, y2 = down ? b.y : b.y + b.h;
    const my = (y1 + y2) / 2;
    return roundedPath([[acx, y1], [acx, my], [bcx, my], [bcx, y2]], 7);
  }
  const right = bcx > acx;
  const x1 = right ? a.x + a.w : a.x, x2 = right ? b.x : b.x + b.w;
  const mx = (x1 + x2) / 2;
  return roundedPath([[x1, acy], [mx, acy], [mx, bcy], [x2, bcy]], 7);
}

export const ArchEdgeView = memo(function ArchEdgeView({ id, source, target, data, selected }: EdgeProps<ArchEdgeT>) {
  const live = useArchDragStore((s) => s.moving.has(source) || s.moving.has(target));
  const a = useInternalNode(source);
  const b = useInternalNode(target);
  if (!data) return null;
  const rect = (n: typeof a): Rect | null =>
    n ? { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width ?? 0, h: n.measured.height ?? 0 } : null;
  const ra = rect(a), rb = rect(b);
  const d = live && ra && rb ? elbow(ra, rb) : roundedPath(data.edge.points, 7);
  const marker = selected ? "hot" : data.marker;
  return (
    <g className={`arch-edge${data.dim ? " is-dim" : ""}${selected ? " is-sel" : ""}`}>
      <path d={d} fill="none" stroke="var(--arch-halo)" strokeWidth={6} strokeLinejoin="round" />
      <BaseEdge
        id={id}
        path={d}
        interactionWidth={14}
        markerEnd={`url(#arch-arrow-${marker})`}
        style={{
          stroke: selected ? "var(--arch-hot)" : data.color,
          strokeWidth: selected ? Math.max(2, data.width) : data.width,
          strokeDasharray: data.dashed ? "5 4" : undefined,
          strokeLinejoin: "round",
          fill: "none",
        }}
      />
      {!live && data.label ? <g className="pointer-events-none" dangerouslySetInnerHTML={{ __html: data.label }} /> : null}
    </g>
  );
});

export const EDGE_TYPES = { arch: ArchEdgeView };
