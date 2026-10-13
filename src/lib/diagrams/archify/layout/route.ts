/**
 * Lines: orthogonal, around the boxes, with room for their labels.
 *
 * Every edge is routed on a sparse grid made of the lines that matter — the edges of every box,
 * pushed out by a margin, the ports the edges leave and enter by, and the middle of every gap — so
 * a path can only turn where turning is meaningful. A* finds the cheapest one: length, plus a
 * penalty per bend (a straight line reads better than a short one with a kink), plus a penalty for
 * running along or across a line already drawn. Edges are routed shortest first, so the obvious ones
 * get the straight lanes and the long ones go around.
 *
 * Ports are not a point on a side but a share of it: edges that meet a side are spread along it,
 * ordered by where their other end is, so two lines do not leave one pixel.
 */
import type { Box, Pt } from "../scene";

export interface RouteRequest {
  id: string;
  from: string;
  to: string;
  /** The width of its label pill, 0 for none. */
  labelW: number;
}

export interface Routed {
  id: string;
  points: Pt[];
  at: Box | null;
}

export interface RouteOptions {
  direction: "LR" | "TB";
  /** The label pill's height. */
  labelH?: number;
  /** Places a label must keep off besides the boxes: the titles of frames. */
  avoid?: Box[];
}

type Side = "left" | "right" | "top" | "bottom";

const MARGIN = 9;
const STUB = 18;
const BEND = 46;
const OVERLAP = 90;
const CROSS = 28;

const OUT: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
/** Directions are 0 right, 1 left, 2 down, 3 up. */
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];
const INWARD: Record<Side, number> = { left: 0, right: 1, top: 2, bottom: 3 };

function centre(b: Box): Pt {
  return [b[0] + b[2] / 2, b[1] + b[3] / 2];
}

/** Which side each end of an edge uses, from where the two boxes sit. */
function sidePair(s: Box, t: Box, direction: "LR" | "TB", mid: Pt): [Side, Side] {
  const gap = 6;
  if (direction === "LR") {
    if (t[0] >= s[0] + s[2] + gap) return ["right", "left"];
    if (t[0] + t[2] <= s[0] - gap) {
      const low = centre(s)[1] + centre(t)[1] > 2 * mid[1];
      return low ? ["bottom", "bottom"] : ["top", "top"];
    }
    return centre(t)[1] >= centre(s)[1] ? ["bottom", "top"] : ["top", "bottom"];
  }
  if (t[1] >= s[1] + s[3] + gap) {
    // Below, but clearly to one side as well: out of that side, so a fan of lines to a group of
    // boxes beside the one that feeds them does not all leave by the foot of it.
    if (t[0] >= s[0] + s[2] + 60) return ["right", "top"];
    if (t[0] + t[2] <= s[0] - 60) return ["left", "top"];
    return ["bottom", "top"];
  }
  if (t[1] + t[3] <= s[1] - gap) {
    const right = centre(s)[0] + centre(t)[0] > 2 * mid[0];
    return right ? ["right", "right"] : ["left", "left"];
  }
  return centre(t)[0] >= centre(s)[0] ? ["right", "left"] : ["left", "right"];
}

function portOn(box: Box, side: Side, share: number): Pt {
  const [x, y, w, h] = box;
  const along = (length: number) => {
    const inset = Math.min(14, length * 0.22);
    return inset + (length - 2 * inset) * share;
  };
  if (side === "left") return [x, y + along(h)];
  if (side === "right") return [x + w, y + along(h)];
  if (side === "top") return [x + along(w), y];
  return [x + along(w), y + h];
}

function stubOf(port: Pt, side: Side): Pt {
  if (side === "left") return [port[0] - STUB, port[1]];
  if (side === "right") return [port[0] + STUB, port[1]];
  if (side === "top") return [port[0], port[1] - STUB];
  return [port[0], port[1] + STUB];
}

class Heap {
  private f: number[] = [];
  private s: number[] = [];
  get size() {
    return this.f.length;
  }
  push(f: number, state: number) {
    let i = this.f.length;
    this.f.push(f);
    this.s.push(state);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      [this.f[p], this.f[i]] = [this.f[i], this.f[p]];
      [this.s[p], this.s[i]] = [this.s[i], this.s[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.f[0], this.s[0]];
    const f = this.f.pop()!;
    const s = this.s.pop()!;
    if (this.f.length) {
      this.f[0] = f;
      this.s[0] = s;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.f.length && this.f[l] < this.f[m]) m = l;
        if (r < this.f.length && this.f[r] < this.f[m]) m = r;
        if (m === i) break;
        [this.f[m], this.f[i]] = [this.f[i], this.f[m]];
        [this.s[m], this.s[i]] = [this.s[i], this.s[m]];
        i = m;
      }
    }
    return top;
  }
}

function dedupe(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > 0.5) out.push(v);
  return out;
}

/**
 * The grid lines on one axis, with a line down the middle of every gap wide enough to want one.
 *
 * `exact` are the ports' and stubs' own coordinates: they are kept as they are, and any other line
 * that falls within half a unit of one is dropped in its favour — the other way round, a path would
 * begin a hair off its port and read as a diagonal.
 */
function axis(coords: number[], exact: number[]): number[] {
  const near = (list: number[], v: number) => list.some((e) => Math.abs(e - v) <= 0.5);
  const base = dedupe(exact);
  for (const v of dedupe(coords)) if (!near(base, v)) base.push(v);
  base.sort((a, b) => a - b);
  // The middle of a wide gap — added last, and never in place of a line that is already there.
  const all = [...base];
  for (let i = 1; i < base.length; i++) {
    const gap = base[i] - base[i - 1];
    const mid = base[i - 1] + gap / 2;
    if (gap > 34 && !near(all, mid)) all.push(mid);
  }
  return all.sort((a, b) => a - b);
}

function simplify(points: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const flat = (Math.abs(a[0] - b[0]) < 0.01 && Math.abs(b[0] - c[0]) < 0.01) || (Math.abs(a[1] - b[1]) < 0.01 && Math.abs(b[1] - c[1]) < 0.01);
    if (flat) out.splice(i, 1);
  }
  return out;
}

/** SVG path data through `points`, with corners rounded to `radius`. */
export function roundedPath(points: Pt[], radius = 9): string {
  if (points.length < 2) return "";
  let d = `M ${r2(points[0][0])} ${r2(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(here[0] - prev[0], here[1] - prev[1]);
    const outLen = Math.hypot(next[0] - here[0], next[1] - here[1]);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const a: Pt = [here[0] - ((here[0] - prev[0]) / inLen) * r, here[1] - ((here[1] - prev[1]) / inLen) * r];
    const b: Pt = [here[0] + ((next[0] - here[0]) / outLen) * r, here[1] + ((next[1] - here[1]) / outLen) * r];
    d += ` L ${r2(a[0])} ${r2(a[1])} Q ${r2(here[0])} ${r2(here[1])} ${r2(b[0])} ${r2(b[1])}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${r2(last[0])} ${r2(last[1])}`;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

interface Grid {
  xs: number[];
  ys: number[];
  xIndex: Map<number, number>;
  yIndex: Map<number, number>;
  pBlock: Uint8Array;
  hBlock: Uint8Array;
  vBlock: Uint8Array;
  hUsed: Uint8Array;
  vUsed: Uint8Array;
  nodeH: Uint8Array;
  nodeV: Uint8Array;
}

const key = (n: number) => Math.round(n * 2) / 2;

function buildGrid(boxes: Box[], extra: Pt[], bounds: Box): Grid {
  const inflated = boxes.map((b) => [b[0] - MARGIN, b[1] - MARGIN, b[0] + b[2] + MARGIN, b[1] + b[3] + MARGIN] as const);
  const xs = axis(
    [bounds[0] - 28, bounds[0] + bounds[2] + 28, ...inflated.flatMap((b) => [b[0], b[2]])],
    extra.map((p) => p[0]),
  );
  const ys = axis(
    [bounds[1] - 28, bounds[1] + bounds[3] + 28, ...inflated.flatMap((b) => [b[1], b[3]])],
    extra.map((p) => p[1]),
  );
  const nx = xs.length;
  const ny = ys.length;
  const eps = 0.01;
  const pBlock = new Uint8Array(nx * ny);
  const hBlock = new Uint8Array(Math.max(0, nx - 1) * ny);
  const vBlock = new Uint8Array(nx * Math.max(0, ny - 1));
  for (const [x0, y0, x1, y1] of inflated) {
    for (let iy = 0; iy < ny; iy++) {
      const y = ys[iy];
      if (y <= y0 + eps || y >= y1 - eps) continue;
      for (let ix = 0; ix < nx; ix++) {
        const x = xs[ix];
        if (x > x0 + eps && x < x1 - eps) pBlock[iy * nx + ix] = 1;
        if (ix < nx - 1 && xs[ix] < x1 - eps && xs[ix + 1] > x0 + eps) hBlock[iy * (nx - 1) + ix] = 1;
      }
    }
    for (let ix = 0; ix < nx; ix++) {
      const x = xs[ix];
      if (x <= x0 + eps || x >= x1 - eps) continue;
      for (let iy = 0; iy < ny - 1; iy++) {
        if (ys[iy] < y1 - eps && ys[iy + 1] > y0 + eps) vBlock[ix * (ny - 1) + iy] = 1;
      }
    }
  }
  return {
    xs,
    ys,
    xIndex: new Map(xs.map((v, i) => [key(v), i])),
    yIndex: new Map(ys.map((v, i) => [key(v), i])),
    pBlock,
    hBlock,
    vBlock,
    hUsed: new Uint8Array(hBlock.length),
    vUsed: new Uint8Array(vBlock.length),
    nodeH: new Uint8Array(nx * ny),
    nodeV: new Uint8Array(nx * ny),
  };
}

function search(grid: Grid, start: Pt, startDir: number, goal: Pt, inward: number): Pt[] | null {
  const { xs, ys } = grid;
  const nx = xs.length;
  const ny = ys.length;
  const sx = grid.xIndex.get(key(start[0]));
  const sy = grid.yIndex.get(key(start[1]));
  const gx = grid.xIndex.get(key(goal[0]));
  const gy = grid.yIndex.get(key(goal[1]));
  if (sx === undefined || sy === undefined || gx === undefined || gy === undefined) return null;
  if (grid.pBlock[sy * nx + sx] || grid.pBlock[gy * nx + gx]) return null;

  const total = nx * ny * 4;
  const cost = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const heap = new Heap();
  const startState = (sy * nx + sx) * 4 + startDir;
  cost[startState] = 0;
  heap.push(Math.abs(xs[gx] - xs[sx]) + Math.abs(ys[gy] - ys[sy]), startState);

  let finalState = -1;
  while (heap.size) {
    const [, state] = heap.pop();
    const dir: number = state & 3;
    const node: number = state >> 2;
    const ix: number = node % nx;
    const iy: number = (node / nx) | 0;
    if (ix === gx && iy === gy) {
      finalState = state;
      break;
    }
    const here = cost[state];
    for (let nd = 0; nd < 4; nd++) {
      if ((nd ^ 1) === dir && nd !== dir) continue;
      const jx: number = ix + DX[nd];
      const jy: number = iy + DY[nd];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      if (grid.pBlock[jy * nx + jx]) continue;
      let used = 0;
      if (nd < 2) {
        const seg = jy * (nx - 1) + Math.min(ix, jx);
        if (grid.hBlock[seg]) continue;
        used = grid.hUsed[seg];
      } else {
        const seg = jx * (ny - 1) + Math.min(iy, jy);
        if (grid.vBlock[seg]) continue;
        used = grid.vUsed[seg];
      }
      const length = Math.abs(xs[jx] - xs[ix]) + Math.abs(ys[jy] - ys[iy]);
      const arrive = jy * nx + jx;
      let step = length + (nd !== dir ? BEND : 0) + (used ? OVERLAP * Math.min(used, 2) : 0);
      if (nd < 2 ? grid.nodeV[arrive] && !grid.nodeH[arrive] : grid.nodeH[arrive] && !grid.nodeV[arrive]) step += CROSS;
      if (jx === gx && jy === gy && nd !== inward) step += BEND;
      const next = arrive * 4 + nd;
      const g = here + step;
      if (g >= cost[next]) continue;
      cost[next] = g;
      parent[next] = state;
      heap.push(g + Math.abs(xs[gx] - xs[jx]) + Math.abs(ys[gy] - ys[jy]), next);
    }
  }
  if (finalState < 0) return null;

  const path: Pt[] = [];
  for (let state = finalState; state >= 0; state = parent[state]) {
    const node = state >> 2;
    path.push([xs[node % nx], ys[(node / nx) | 0]]);
  }
  return path.reverse();
}

function markUsed(grid: Grid, points: Pt[]) {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const ia = grid.xIndex.get(key(ax));
    const ja = grid.yIndex.get(key(ay));
    const ib = grid.xIndex.get(key(bx));
    const jb = grid.yIndex.get(key(by));
    if (ia === undefined || ja === undefined || ib === undefined || jb === undefined) continue;
    if (ja === jb) {
      for (let x = Math.min(ia, ib); x <= Math.max(ia, ib); x++) {
        grid.nodeH[ja * nx + x] = 1;
        if (x < Math.max(ia, ib)) grid.hUsed[ja * (nx - 1) + x] = Math.min(255, grid.hUsed[ja * (nx - 1) + x] + 1);
      }
    } else if (ia === ib) {
      for (let y = Math.min(ja, jb); y <= Math.max(ja, jb); y++) {
        grid.nodeV[y * nx + ia] = 1;
        if (y < Math.max(ja, jb)) grid.vUsed[ia * (ny - 1) + y] = Math.min(255, grid.vUsed[ia * (ny - 1) + y] + 1);
      }
    }
  }
}

/** A path with a single kink, used when the grid finds no way — which is only when boxes touch. */
function fallback(a: Pt, b: Pt, direction: "LR" | "TB"): Pt[] {
  if (direction === "LR") {
    const mx = (a[0] + b[0]) / 2;
    return [a, [mx, a[1]], [mx, b[1]], b];
  }
  const my = (a[1] + b[1]) / 2;
  return [a, [a[0], my], [b[0], my], b];
}

export function routeAll(
  boxes: Map<string, Box>,
  requests: RouteRequest[],
  options: RouteOptions,
): Map<string, Routed> {
  const labelH = options.labelH ?? 20;
  const all = [...boxes.values()];
  const x0 = Math.min(...all.map((b) => b[0]));
  const y0 = Math.min(...all.map((b) => b[1]));
  const x1 = Math.max(...all.map((b) => b[0] + b[2]));
  const y1 = Math.max(...all.map((b) => b[1] + b[3]));
  const bounds: Box = [x0, y0, x1 - x0, y1 - y0];
  const mid: Pt = [x0 + (x1 - x0) / 2, y0 + (y1 - y0) / 2];

  type Plan = { req: RouteRequest; s: Box; t: Box; sides: [Side, Side]; ports: [Pt, Pt] };
  const plans: Plan[] = [];
  const loops: RouteRequest[] = [];
  for (const req of requests) {
    const s = boxes.get(req.from);
    const t = boxes.get(req.to);
    if (!s || !t) continue;
    if (req.from === req.to) {
      loops.push(req);
      continue;
    }
    plans.push({ req, s, t, sides: sidePair(s, t, options.direction, mid), ports: [[0, 0], [0, 0]] });
  }

  // Ports: the edges that meet a side share it, ordered by where their other end is.
  const bySide = new Map<string, { plan: number; end: 0 | 1; order: number }[]>();
  plans.forEach((plan, at) => {
    ([0, 1] as const).forEach((end) => {
      const side = plan.sides[end];
      const own = end === 0 ? plan.s : plan.t;
      const other = end === 0 ? plan.t : plan.s;
      const o = centre(other);
      const vertical = side === "left" || side === "right";
      // Which way round each end goes decides where lines cross; ordering by the far end's position
      // along the side's axis keeps a bundle from twisting.
      const order = vertical ? o[1] : o[0];
      const id = `${own[0]},${own[1]}:${side}`;
      bySide.set(id, [...(bySide.get(id) ?? []), { plan: at, end, order }]);
    });
  });
  for (const [id, list] of bySide) {
    const side = id.split(":")[1] as Side;
    list.sort((a, b) => a.order - b.order || a.plan - b.plan);
    list.forEach((entry, i) => {
      const plan = plans[entry.plan];
      const own = entry.end === 0 ? plan.s : plan.t;
      plan.ports[entry.end] = portOn(own, side, (i + 1) / (list.length + 1));
    });
  }

  const stubs = plans.map((p) => [stubOf(p.ports[0], p.sides[0]), stubOf(p.ports[1], p.sides[1])] as const);
  const grid = buildGrid(all, stubs.flatMap(([a, b]) => [a, b]), bounds);

  const routed = new Map<string, Routed>();
  const order = plans
    .map((plan, at) => ({ plan, at, length: Math.abs(stubs[at][0][0] - stubs[at][1][0]) + Math.abs(stubs[at][0][1] - stubs[at][1][1]) }))
    .sort((a, b) => a.length - b.length || a.at - b.at);
  for (const { plan, at } of order) {
    const [a, b] = stubs[at];
    const found = search(grid, a, OUT[plan.sides[0]], b, INWARD[plan.sides[1]]);
    const inner = found ?? fallback(a, b, options.direction);
    const points = simplify([plan.ports[0], ...inner, plan.ports[1]]);
    markUsed(grid, points);
    routed.set(plan.req.id, { id: plan.req.id, points, at: null });
  }

  // A loop on the same box: out of one face, round, back in a little further along. Along the top
  // in a left-to-right diagram — the right face is where the way on leaves — and its label above it.
  for (const req of loops) {
    const box = boxes.get(req.from)!;
    const [x, y, w, h] = box;
    const top = options.direction === "LR";
    const points: Pt[] = top
      ? [[x + w * 0.36, y], [x + w * 0.36, y - 24], [x + w * 0.64, y - 24], [x + w * 0.64, y]]
      : [[x + w, y + h * 0.3], [x + w + 24, y + h * 0.3], [x + w + 24, y + h * 0.7], [x + w, y + h * 0.7]];
    const at: Box | null =
      req.labelW > 0
        ? top
          ? [x + w / 2 - req.labelW / 2, y - 24 - labelH - 4, req.labelW, labelH]
          : [x + w + 30, y + h / 2 - labelH / 2, req.labelW, labelH]
        : null;
    routed.set(req.id, { id: req.id, points, at });
  }

  placeLabels(routed, requests, [...boxes.values(), ...(options.avoid ?? [])], labelH);
  return routed;
}

function segmentHitsBox(a: Pt, b: Pt, box: Box): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return x0 < box[0] + box[2] && x1 > box[0] && y0 < box[1] + box[3] && y1 > box[1];
}

function overlaps(a: Box, b: Box, pad = 0): boolean {
  return a[0] < b[0] + b[2] + pad && b[0] < a[0] + a[2] + pad && a[1] < b[1] + b[3] + pad && b[1] < a[1] + a[3] + pad;
}

/**
 * A pill for every label, on the line it names: on a long enough stretch, clear of boxes and of the
 * other labels, away from the ends where lines bunch, and short of other lines passing through it.
 */
function placeLabels(routed: Map<string, Routed>, requests: RouteRequest[], boxes: Box[], height: number) {
  const placed: Box[] = [];
  const wanted = requests.filter((r) => r.labelW > 0 && routed.has(r.id) && !routed.get(r.id)!.at);
  for (const route of routed.values()) if (route.at) placed.push(route.at);
  const order = [...wanted].sort((a, b) => {
    const la = pathLength(routed.get(a.id)!.points);
    const lb = pathLength(routed.get(b.id)!.points);
    return la - lb;
  });
  for (const req of order) {
    const route = routed.get(req.id)!;
    const points = route.points;
    const total = pathLength(points);
    const width = req.labelW;
    let best: { box: Box; score: number } | null = null;
    let walked = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const horizontal = Math.abs(a[1] - b[1]) < 0.01;
      const room = horizontal ? length - STUB * (i === 1 || i === points.length - 1 ? 1 : 0) : length;
      if (room >= (horizontal ? Math.min(width + 8, 60) : 22)) {
        for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
          const cx = a[0] + (b[0] - a[0]) * t;
          const cy = a[1] + (b[1] - a[1]) * t;
          // On the line first; failing that, just to one side of it — a pill beside a line still
          // names it, and beats one sitting on a title or a box.
          const sides: [number, number, number][] = horizontal
            ? [[0, 0, 0], [0, -(height / 2 + 7), 14], [0, height / 2 + 7, 14]]
            : [[0, 0, 0], [width / 2 + 9, 0, 14], [-(width / 2 + 9), 0, 14]];
          for (const [dx, dy, cost] of sides) {
            const box: Box = [cx + dx - width / 2, cy + dy - height / 2, width, height];
            let score = cost + Math.abs(t - 0.5) * 24 + Math.abs(walked + length * t - total / 2) * 0.04;
            if (i === 1 || i === points.length - 1) score += 18;
            if (horizontal && width > length - 10) score += 40;
            for (const other of boxes) if (overlaps(box, other, 3)) score += 1000;
            for (const label of placed) if (overlaps(box, label, 4)) score += 900;
            for (const [id, other] of routed) {
              if (id === req.id) continue;
              for (let k = 1; k < other.points.length; k++) {
                if (segmentHitsBox(other.points[k - 1], other.points[k], box)) score += 36;
              }
            }
            if (!best || score < best.score) best = { box, score };
          }
        }
      }
      walked += length;
    }
    if (!best) {
      // Every stretch is shorter than the pill: put it at the middle of the path anyway.
      let remaining = total / 2;
      let at: Pt = points[0];
      for (let i = 1; i < points.length; i++) {
        const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        if (remaining <= length) {
          const t = length ? remaining / length : 0;
          at = [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
          break;
        }
        remaining -= length;
      }
      best = { box: [at[0] - width / 2, at[1] - height / 2, width, height], score: 0 };
    }
    route.at = best.box;
    placed.push(best.box);
  }
}

function pathLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}
