/**
 * The graph view's physics: the part that keeps moving after the first frame.
 *
 * `layoutGraph` answers "where does this graph go" once, cold, and it is still what seeds this —
 * the same notes and links open on the same picture every time. What it cannot do is react: a note
 * dragged aside has to push its neighbours out of the way, and a cluster has to breathe back into
 * shape afterwards. That is this module, run a frame at a time by the view.
 *
 * Three forces, the ones every force-directed graph is made of:
 *
 * * **Repulsion** between nodes that are close enough to matter. Cut off at `REPULSION_RANGE` and
 *   resolved through a uniform grid, so the cost is the neighbours each node actually has rather
 *   than every other node in the vault — the difference between a 600-note graph at 60fps and one
 *   that stutters.
 * * **Springs** along the links, pulling what cites each other together.
 * * **Gravity** towards the origin, which is what keeps notes nobody links orbiting the rest
 *   instead of drifting off-screen for good.
 *
 * `alpha` is the temperature: every displacement is scaled by it and it decays each frame, so the
 * graph settles and then stops costing anything. Dragging reheats it (`reheat`).
 */

/** Where a spring is happy: the distance a single link settles at. */
const LINK_DISTANCE = 78;
const LINK_STRENGTH = 0.035;
/** Beyond this, two nodes do not push each other at all — what makes the grid worth using. */
const REPULSION_RANGE = 240;
const REPULSION = 2600;
const GRAVITY = 0.012;
const DAMPING = 0.82;
/** Below this the picture no longer visibly changes, and the loop can stop. */
export const ALPHA_SLEEP = 0.004;
const ALPHA_DECAY = 0.985;

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** How many links touch it — the dot's size, and nothing to do with the physics. */
  degree: number;
  /** Held in place: the node under the pointer while it is being dragged. */
  pinned: boolean;
}

export interface SimLink {
  source: number;
  target: number;
}

export interface Simulation {
  nodes: SimNode[];
  links: SimLink[];
  alpha: number;
}

export function createSimulation(
  seeds: { id: string; x: number; y: number; degree: number }[],
  links: SimLink[],
): Simulation {
  return {
    nodes: seeds.map((seed) => ({ ...seed, vx: 0, vy: 0, pinned: false })),
    links,
    // Warm, not hot: the seed is already a settled layout, so this is the nudge that turns it into
    // a live one — starting at 1 would throw the deterministic opening picture away.
    alpha: 0.35,
  };
}

/** Puts the temperature back up — a drag, a graph that just gained a note. */
export function reheat(sim: Simulation, alpha = 0.3): void {
  sim.alpha = Math.max(sim.alpha, alpha);
}

/** Whether the graph is still moving enough to be worth another frame. */
export function isSettled(sim: Simulation): boolean {
  return sim.alpha <= ALPHA_SLEEP && !sim.nodes.some((node) => node.pinned);
}

/**
 * One frame. The grid is rebuilt each time rather than kept: at these sizes filling a map of
 * buckets is cheaper than keeping one correct across moves, and it cannot go stale.
 */
export function step(sim: Simulation): void {
  const { nodes, links } = sim;
  const n = nodes.length;
  if (n === 0) return;
  const alpha = sim.alpha;

  const cell = REPULSION_RANGE;
  const buckets = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 73_856_093 + cy * 19_349_663;
  for (let i = 0; i < n; i++) {
    const at = key(Math.floor(nodes[i].x / cell), Math.floor(nodes[i].y / cell));
    const bucket = buckets.get(at);
    if (bucket) bucket.push(i);
    else buckets.set(at, [i]);
  }

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    const cx = Math.floor(node.x / cell);
    const cy = Math.floor(node.y / cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = buckets.get(key(cx + ox, cy + oy));
        if (!bucket) continue;
        for (const j of bucket) {
          // Each pair once: the second half of the pass would undo the first.
          if (j <= i) continue;
          const other = nodes[j];
          let dx = node.x - other.x;
          let dy = node.y - other.y;
          let distance = Math.hypot(dx, dy);
          if (distance > REPULSION_RANGE) continue;
          if (distance < 0.5) {
            // Exactly on top of each other has no direction to push along. Any fixed one would
            // make the pair jump the same way every time; the index gives each pair its own.
            dx = Math.cos(i * 2.399) * 0.5;
            dy = Math.sin(i * 2.399) * 0.5;
            distance = 0.5;
          }
          const force = (REPULSION / (distance * distance)) * alpha;
          const fx = (dx / distance) * force;
          const fy = (dy / distance) * force;
          node.vx += fx;
          node.vy += fy;
          other.vx -= fx;
          other.vy -= fy;
        }
      }
    }
  }

  for (const link of links) {
    const a = nodes[link.source];
    const b = nodes[link.target];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.max(Math.hypot(dx, dy), 0.5);
    const force = (distance - LINK_DISTANCE) * LINK_STRENGTH * alpha;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  for (const node of nodes) {
    if (node.pinned) {
      // Dragged: the pointer is its position, and carrying velocity over would make it fly off
      // the moment it is let go.
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    node.vx = (node.vx - node.x * GRAVITY * alpha) * DAMPING;
    node.vy = (node.vy - node.y * GRAVITY * alpha) * DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }

  sim.alpha *= ALPHA_DECAY;
}

/** The dot under a point in graph coordinates, topmost first, or `null`. `radius` is the drawn
 *  size of each node — a hit has to agree with what the eye sees. */
export function nodeAt(
  nodes: SimNode[],
  x: number,
  y: number,
  radius: (node: SimNode) => number,
  slack = 4,
): SimNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    const reach = radius(node) + slack;
    if ((node.x - x) ** 2 + (node.y - y) ** 2 <= reach * reach) return node;
  }
  return null;
}

/** The box the graph occupies, padded — what "fit to view" frames. */
export function bounds(nodes: SimNode[], padding = 80) {
  if (nodes.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
}
