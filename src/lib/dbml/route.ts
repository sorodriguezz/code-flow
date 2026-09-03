import { edgeEnds, type EdgeEnds } from "../diagramSvg";
import type { DiagramDensity, DiagramLayout, DiagramNode } from "../db/erLayout";

/**
 * Relationship lines that go *around* the tables instead of under them.
 *
 * # Why this is not a property of the curve
 *
 * `edgePath` draws one cubic between two column rows and knows nothing about the other boxes. On a
 * dozen tables that is the right drawing — a curve is calmer than a staircase and there is rarely
 * anything in the way. On a real schema the lines pass behind the boxes (they are painted first, so
 * a table always wins where the two overlap) and a relationship becomes something you trace by eye
 * across a gap, guess at, and re-check. Routing is what turns "these two are joined somehow" into a
 * line you can follow.
 *
 * So this is an **option, not a replacement**, and `"curved"` delegates to `edgeEnds`/`edgePath`
 * unchanged. Both live behind one function so the canvas has a single code path and the endpoint
 * dots, the hit target and the cardinality markers cannot drift half a pixel off the line they
 * belong to — which is the bug that split `edgeEnds` out of `edgePath` in the first place.
 *
 * # Obstacles come from the nodes, not from the layout
 *
 * The layout engine knows where it left the corridors between its columns, and asking it would be
 * cheaper. It would also be wrong: boxes are **dragged**, and a dragged box sits wherever the user
 * put it — including in the middle of the corridor the engine thinks is empty. Every obstacle here
 * is read back off the laid-out rectangles, so a hand-arranged schema routes as correctly as a
 * machine-arranged one.
 *
 * # What it does not do, and how well it does what it does
 *
 * No visibility graph, no global optimisation, no crossing minimisation, no shared trunks. Each
 * edge is routed on its own against the boxes in three tiers of increasing effort, and the last
 * tier is a detour that may still clip something rather than a failure — a line that is drawn and
 * slightly wrong beats a relationship that is not drawn at all.
 *
 * Measured on synthetic trees (fan-out 3, 8 columns a table), counting edges whose path passes
 * through a box that is not one of its own two ends:
 *
 * | tables | curved    | orthogonal  | cost   |
 * | ------ | --------- | ----------- | ------ |
 * | 6      | 3 / 5     | **0 / 5**   | <0.1ms |
 * | 30     | 8 / 29    | **0 / 29**  | 0.1 ms |
 * | 80     | 58 / 79   | 14 / 79     | 0.2 ms |
 * | 200    | 171 / 199 | 51 / 199    | 0.6 ms |
 *
 * The residue from 80 up is edges that cross a **wrapped** layer: past `ROOMY_MIN_STACK` boxes the
 * layout folds a layer into side-by-side sub-columns, and a line from one sub-column to the next
 * depth has to get past the other. That is a layout property rather than a router one — the fix is
 * a real search rather than a fourth tier — and at that size the picture is a map you navigate
 * rather than a diagram you read one line off. `lanes` is what keeps parallel edges through one gap
 * from collapsing onto a single vertical.
 */

export type EdgeRouting = "curved" | "orthogonal";

/**
 * Above this many boxes the toggle is refused and every edge is drawn curved.
 *
 * Routing is recomputed whenever the layout is, and the layout is recomputed on every frame of a
 * box drag — `moveTable` rewrites the document per pointermove. Measured at `roomy`, routing 200
 * nodes costs about 0.6 ms on top of the layout's 1.4 ms, so the cap is a backstop rather than a
 * boundary anyone is expected to meet. A schema past it is also one where the picture is a map you
 * navigate rather than something you read a single line off.
 *
 * The control that offers the toggle must gate on the **same** number — see `onNodeCount` on
 * `DbmlCanvas`. Counting the schema's tables instead leaves a switch that is enabled and does
 * nothing.
 */
export const ROUTING_NODE_LIMIT = 300;

/**
 * How much room a route asks for, per density — and why it cannot be one number.
 *
 * The layout leaves a `columnGap` between depths: 96px at roomy, 40px at compact. A clearance of 14
 * on each side of a lane spends 28 of those, which roomy never notices and compact cannot afford —
 * measured, a fixed 14 left compact routing 156 of 199 edges through a box, barely better than the
 * curve it replaced. Compact is a density that has already decided the boxes may nearly touch, so
 * the lines drawn between them are allowed to pass closer as well.
 */
interface Clearances {
  /** How close a line may pass to a box it is going around. */
  clearance: number;
  /** The stub a route leaves and arrives on, so a line meets a box square rather than at a slant. */
  stub: number;
  /** Spacing between the vertical runs of edges sharing one gap. */
  lane: number;
}

const ROOM: Record<DiagramDensity, Clearances> = {
  roomy: { clearance: 14, stub: 18, lane: 9 },
  compact: { clearance: 6, stub: 10, lane: 6 },
};

/** Corner radius. Large enough to read as a turn, small enough to survive a 40% zoom. */
const RADIUS = 8;

export interface RoutedEdge extends EdgeEnds {
  /** The `d` attribute, for both the visible stroke and the invisible hit target. */
  d: string;
  /** Which face the line actually left and arrived on, so the `1`/`N` markers can follow it. */
  fromRight: boolean;
  toRight: boolean;
}

interface Rect {
  /** The node this box belongs to — a line's own two ends are not obstacles to it. */
  owner: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Every link's geometry, keyed by `link.id`.
 *
 * One pass rather than a call per edge, because the lane assignment is a property of the *set*: two
 * edges crossing the same gap have to be told about each other or they draw one line on top of
 * another.
 */
export function routeEdges(
  layout: DiagramLayout,
  routing: EdgeRouting,
  density: DiagramDensity = "roomy",
): Map<string, RoutedEdge> {
  const out = new Map<string, RoutedEdge>();
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const room = ROOM[density];

  const orthogonal = routing === "orthogonal" && layout.nodes.length <= ROUTING_NODE_LIMIT;

  // Sorted by left edge, so the obstacle scan can stop early once a box starts to the right of the
  // span being tested. The single biggest win available here, and it costs one sort per pass.
  const obstacles: Rect[] = layout.nodes
    .map((node) => ({
      owner: node.id,
      x0: node.x - room.clearance,
      y0: node.y - room.clearance,
      x1: node.x + node.width + room.clearance,
      y1: node.y + node.height + room.clearance,
    }))
    .sort((a, b) => a.x0 - b.x0);

  /** Which vertical run each gap has handed out, so parallel edges get their own lane. */
  const lanes = new Map<number, number>();

  for (const link of layout.links) {
    const from = byId.get(link.from);
    const to = byId.get(link.to);
    if (!from || !to) continue;

    const ends = edgeEnds(from, to, link.fromColumn, link.toColumn);
    const fromRight = from.x + from.width / 2 <= to.x + to.width / 2;

    if (!orthogonal || from.id === to.id) {
      // A self-reference is already a loop out of one face and back into it; there is nothing for a
      // right angle to improve and the curve reads better.
      out.set(link.id, {
        ...ends,
        d: `M ${ends.x1} ${ends.y1} C ${ends.c1} ${ends.y1}, ${ends.c2} ${ends.y2}, ${ends.x2} ${ends.y2}`,
        fromRight,
        toRight: !fromRight,
      });
      continue;
    }

    out.set(link.id, {
      ...ends,
      d: elbow(ends, from, to, fromRight, obstacles, lanes, room),
      fromRight,
      toRight: !fromRight,
    });
  }

  return out;
}

/**
 * One routed line, in three tiers.
 *
 * They are tried in order of how much they cost to look at, not how much they cost to compute: a
 * straight line is the best answer whenever it is available, then one vertical run, then a detour
 * over or under whatever is in the way.
 */
function elbow(
  ends: EdgeEnds,
  from: DiagramNode,
  to: DiagramNode,
  fromRight: boolean,
  obstacles: Rect[],
  lanes: Map<number, number>,
  room: Clearances,
): string {
  const { x1, y1, x2, y2 } = ends;

  // Tier 0 — the rows line up and nothing is between them. One straight segment, and by far the
  // most readable thing this function can produce.
  if (Math.abs(y1 - y2) < 1 && clearH(obstacles, x1, x2, y1, from.id, to.id)) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Tier 1 — a Z: out, across, in. The vertical run goes in a lane inside the gap between the two
  // boxes; candidates are walked from the middle outwards, because a turn near the middle of the
  // run reads as one line and a turn hard against a box reads as two.
  const near = fromRight ? from.x + from.width : from.x;
  const far = fromRight ? to.x : to.x + to.width;
  const dir = fromRight ? 1 : -1;
  // The **signed** gap, not its size. Two boxes can overlap horizontally — a foreign-key cycle puts
  // them at the same depth, and a drag can put them anywhere — and then `far` is *behind* `near`, so
  // the gap opens backwards. Measuring its magnitude let tier 1 run anyway and pick a lane in the
  // middle of both boxes: the whole line was drawn inside the two tables it joins, and since the
  // boxes are painted after the lines, what reached the screen was no line at all. Falling through
  // to tier 2 is right — going over or under is precisely that tier's case.
  const span = (far - near) * dir;

  if (span > room.stub * 2) {
    const key = Math.round((near + far) / 2 / room.lane);
    const taken = lanes.get(key) ?? 0;
    // Offsets fan out from the centre: 0, +1, -1, +2, -2 … so the first edge through a gap runs
    // down the middle of it and the rest sit either side rather than all drifting one way.
    const offset = ((taken + 1) >> 1) * (taken % 2 === 0 ? 1 : -1) * room.lane;

    for (const at of laneCandidates(near, far, dir, offset, room.stub)) {
      if (
        clearV(obstacles, at, y1, y2, from.id, to.id) &&
        clearH(obstacles, x1, at, y1, from.id, to.id) &&
        clearH(obstacles, at, x2, y2, from.id, to.id)
      ) {
        lanes.set(key, taken + 1);
        return path([
          [x1, y1],
          [at, y1],
          [at, y2],
          [x2, y2],
        ]);
      }
    }
  }

  // Tier 2 — go over or under. Out to a stub, up (or down) past everything in the way, across, and
  // back in. This is the case the whole module exists for: the two boxes are in the same column, or
  // there is a third box sitting squarely between them.
  const outX = x1 + dir * room.stub;
  const inX = x2 - dir * room.stub;
  const lo = Math.min(y1, y2);
  const hi = Math.max(y1, y2);
  const blockers = obstacles.filter(
    (rect) =>
      rect.x1 > Math.min(outX, inX) &&
      rect.x0 < Math.max(outX, inX) &&
      rect.y1 > lo &&
      rect.y0 < hi,
  );
  if (blockers.length > 0) {
    const above = Math.min(...blockers.map((rect) => rect.y0)) - room.clearance;
    const below = Math.max(...blockers.map((rect) => rect.y1)) + room.clearance;
    // The shorter detour from where the line already is, then the other one — and the shorter one
    // anyway if neither is clear, because a drawn line that clips a corner beats no line.
    const first = hi - above > below - lo ? below : above;
    const second = first === above ? below : above;
    for (const lane of [first, second]) {
      const legs: [number, number][] = [
        [x1, y1],
        [outX, y1],
        [outX, lane],
        [inX, lane],
        [inX, y2],
        [x2, y2],
      ];
      const ok =
        clearV(obstacles, outX, y1, lane, from.id, to.id) &&
        clearH(obstacles, outX, inX, lane, from.id, to.id) &&
        clearV(obstacles, inX, lane, y2, from.id, to.id);
      if (ok || lane === second) return path(legs);
    }
  }

  // Nothing in the way after all — a plain Z through the middle.
  const mid = (x1 + x2) / 2;
  return path([
    [x1, y1],
    [mid, y1],
    [mid, y2],
    [x2, y2],
  ]);
}

/** Lane positions to try, from the middle of the gap outwards. */
function laneCandidates(
  near: number,
  far: number,
  dir: number,
  offset: number,
  stub: number,
): number[] {
  // Walked from the middle outwards: a turn near the middle of the run reads as one line, a turn
  // hard against a box reads as two. The gap is sampled rather than bisected because what is in the
  // way is a box of unknown width, not a point — five probes is enough to find the clear side of
  // one parked mid-gap, and each probe is a scan that stops at the first box past it.
  const span = far - near;
  const out = [0.5, 0.35, 0.65, 0.2, 0.8].map((at) => near + span * at + offset);
  // Last resort inside the gap: hard against each box, still clear of it by the stub.
  out.push(near + dir * stub, far - dir * stub);
  return out;
}

/** Whether a horizontal segment at `y` from `a` to `b` misses every box but its own two ends. */
function clearH(
  obstacles: Rect[],
  a: number,
  b: number,
  y: number,
  fromId: string,
  toId: string,
): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (const rect of obstacles) {
    // Sorted by `x0`: once a box starts past the end of the segment, so does every one after it.
    if (rect.x0 > hi) return true;
    if (rect.x1 < lo) continue;
    if (y > rect.y0 && y < rect.y1 && !isEndpoint(rect, fromId, toId)) return false;
  }
  return true;
}

/** The same for a vertical segment at `x`. */
function clearV(
  obstacles: Rect[],
  x: number,
  a: number,
  b: number,
  fromId: string,
  toId: string,
): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (const rect of obstacles) {
    if (rect.x0 > x) return true;
    if (rect.x1 < x) continue;
    if (hi > rect.y0 && lo < rect.y1 && !isEndpoint(rect, fromId, toId)) return false;
  }
  return true;
}

/**
 * The two boxes a line joins are not obstacles to it.
 *
 * Every route starts and ends *on a face*, and each face is inside its own box's clearance margin,
 * so counting the endpoints as solid would reject every candidate including the correct one — the
 * router would fall through to tier 2 on every single edge and draw a schema of detours.
 */
function isEndpoint(rect: Rect, fromId: string, toId: string): boolean {
  return rect.owner === fromId || rect.owner === toId;
}

/** An orthogonal polyline with its corners rounded. */
function path(points: [number, number][]): string {
  if (points.length < 2) return "";
  let d = `M ${round(points[0][0])} ${round(points[0][1])}`;
  for (let at = 1; at < points.length - 1; at += 1) {
    const [px, py] = points[at - 1];
    const [cx, cy] = points[at];
    const [nx, ny] = points[at + 1];
    // Never round further than half the shorter of the two segments, or consecutive corners eat
    // each other and the line doubles back on itself.
    const r = Math.min(RADIUS, dist(px, py, cx, cy) / 2, dist(cx, cy, nx, ny) / 2);
    if (r < 0.5) {
      d += ` L ${round(cx)} ${round(cy)}`;
      continue;
    }
    const before = towards(cx, cy, px, py, r);
    const after = towards(cx, cy, nx, ny, r);
    d += ` L ${round(before[0])} ${round(before[1])} Q ${round(cx)} ${round(cy)} ${round(after[0])} ${round(after[1])}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${round(last[0])} ${round(last[1])}`;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

/** `r` pixels from `(x, y)` in the direction of `(tx, ty)`. Axis-aligned, so no square root. */
function towards(x: number, y: number, tx: number, ty: number, r: number): [number, number] {
  if (x === tx) return [x, y + Math.sign(ty - y) * r];
  return [x + Math.sign(tx - x) * r, y];
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
