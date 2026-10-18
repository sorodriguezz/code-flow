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
