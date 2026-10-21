/**
 * Where each note sits in the graph view: a force layout (Fruchterman–Reingold) — linked notes pull
 * together, every pair pushes apart, and the whole cools until it settles. Deterministic: notes
 * start on a circle in the order given, so the same notes and links draw the same picture every
 * time, and opening the view twice does not reshuffle it.
 */
export interface GraphPoint {
  x: number;
  y: number;
}

/** The room each note is given: a group's layout is scaled to the disc its notes fill this far
 *  apart, so a book of five hundred notes is as airy as one of ten instead of packing the same
 *  square tighter. */
export const NOTE_SPACING = 90;

/** Space left between two books' groups, beyond their own extent. */
const GROUP_GAP = 400;

/**
 * Notes laid out by group — a book each — so books read as separate islands: every group is laid
 * out on its own (`layoutGraph`, with the links inside it), then the groups are set around a circle
 * far enough apart not to overlap. Links between books still draw, across the gap. `anchors` is
 * each group's centre, which the live simulation keeps pulling the group's notes towards.
 * Deterministic, like `layoutGraph`: groups are placed largest first, ties in order of appearance.
 */
export function layoutGroups(
  ids: string[],
  edges: [string, string][],
  groupOf: (id: string) => string,
): { points: Map<string, GraphPoint>; anchors: Map<string, GraphPoint> } {
  const members = new Map<string, string[]>();
  for (const id of ids) {
    const group = groupOf(id);
    const list = members.get(group);
    if (list) list.push(id);
    else members.set(group, [id]);
  }
  const order = [...members.keys()].sort((a, b) => members.get(b)!.length - members.get(a)!.length);
  const local = new Map<string, { points: Map<string, GraphPoint>; radius: number }>();
  for (const group of order) {
    const list = members.get(group)!;
    const inside = new Set(list);
    const own = edges.filter(([from, to]) => inside.has(from) && inside.has(to));
    const points = spaced(layoutGraph(list, own));
    // The extent most of the group fills — a straggler far out does not push every book away.
    const distances = [...points.values()].map((point) => Math.hypot(point.x, point.y)).sort((a, b) => a - b);
    const radius = distances.length ? distances[Math.floor((distances.length - 1) * 0.95)] : 0;
    local.set(group, { points, radius });
  }

  const anchors = new Map<string, GraphPoint>();
  if (order.length === 1) {
    anchors.set(order[0], { x: 0, y: 0 });
  } else if (order.length > 1) {
    // Adjacent anchors on the circle are a chord apart, 2R·sin(π/B): enough for the two largest
    // groups side by side and the gap between them.
    const largest = Math.max(...order.map((group) => local.get(group)!.radius));
    const ring = (largest + GROUP_GAP / 2) / Math.sin(Math.PI / Math.max(order.length, 2));
    order.forEach((group, at) => {
      // From the left, so two books sit side by side — the shape of a wide pane.
      const angle = Math.PI + (2 * Math.PI * at) / order.length;
      anchors.set(group, { x: Math.round(Math.cos(angle) * ring), y: Math.round(Math.sin(angle) * ring) });
    });
  }

  const points = new Map<string, GraphPoint>();
  for (const group of order) {
    const anchor = anchors.get(group)!;
    for (const [id, point] of local.get(group)!.points) points.set(id, { x: point.x + anchor.x, y: point.y + anchor.y });
  }
  return { points, anchors };
}

export function layoutGraph(ids: string[], edges: [string, string][], size = 1400): Map<string, GraphPoint> {
  const n = ids.length;
  const out = new Map<string, GraphPoint>();
  if (n === 0) return out;
  const index = new Map(ids.map((id, i) => [id, i]));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const radius = size / 3;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    xs[i] = Math.cos(angle) * radius;
    ys[i] = Math.sin(angle) * radius;
  }
  const links: [number, number][] = [];
  for (const [from, to] of edges) {
    const a = index.get(from);
    const b = index.get(to);
    if (a !== undefined && b !== undefined && a !== b) links.push([a, b]);
  }
  const area = size * size;
  const k = Math.sqrt(area / n);
  // Fewer rounds for a big vault: the pairwise pass is n², and the picture is settled well before.
  const rounds = n > 400 ? 60 : n > 150 ? 120 : 220;
  let temperature = size / 8;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let round = 0; round < rounds; round++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = xs[i] - xs[j];
        let ey = ys[i] - ys[j];
        let distance = Math.hypot(ex, ey);
        if (distance < 0.01) {
          ex = 0.01 * ((i % 3) - 1 || 1);
          ey = 0.01;
          distance = 0.015;
        }
        const force = (k * k) / distance;
        const fx = (ex / distance) * force;
        const fy = (ey / distance) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }
    for (const [a, b] of links) {
      const ex = xs[a] - xs[b];
      const ey = ys[a] - ys[b];
      const distance = Math.max(Math.hypot(ex, ey), 0.01);
      const force = (distance * distance) / k;
      const fx = (ex / distance) * force;
      const fy = (ey / distance) * force;
      dx[a] -= fx;
      dy[a] -= fy;
      dx[b] += fx;
      dy[b] += fy;
    }
    // A pull towards the middle, so notes with no links orbit the rest instead of drifting away.
    for (let i = 0; i < n; i++) {
      dx[i] -= xs[i] * 0.02;
      dy[i] -= ys[i] * 0.02;
      const length = Math.hypot(dx[i], dy[i]);
      if (length > 0) {
        const step = Math.min(length, temperature);
        xs[i] += (dx[i] / length) * step;
        ys[i] += (dy[i] / length) * step;
      }
    }
    temperature *= 0.97;
  }
  ids.forEach((id, i) => out.set(id, { x: Math.round(xs[i]), y: Math.round(ys[i]) }));
  return out;
}

/** `points` centred and scaled so 95% of them fall within the disc `n` notes fill at
 *  [`NOTE_SPACING`] apart — a group's extent follows its size, however far the force layout flung a
 *  branch of a tree. */
function spaced(points: Map<string, GraphPoint>): Map<string, GraphPoint> {
  const list = [...points.values()];
  if (list.length < 2) return new Map([...points].map(([id]) => [id, { x: 0, y: 0 }]));
  const cx = list.reduce((sum, p) => sum + p.x, 0) / list.length;
  const cy = list.reduce((sum, p) => sum + p.y, 0) / list.length;
  const distances = list.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
  const extent = distances[Math.floor((distances.length - 1) * 0.95)] || 1;
  const scale = (0.6 * NOTE_SPACING * Math.sqrt(list.length)) / extent;
  return new Map([...points].map(([id, p]) => [id, { x: Math.round((p.x - cx) * scale), y: Math.round((p.y - cy) * scale) }]));
}
