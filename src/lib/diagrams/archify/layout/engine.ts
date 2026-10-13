/**
 * Layered placement: where each box goes, before any line is drawn.
 *
 * The classic recipe, written for what these diagrams are — a dozen boxes with labelled arrows and a
 * few frames — rather than for a thousand-node graph:
 *
 * 1. **Ranks.** Back edges are set aside (a cycle is a retry, not a reason to stack boxes), and each
 *    box goes one rank past its deepest predecessor; sources are pulled up to sit beside their first
 *    target instead of at the far edge.
 * 2. **Order within a rank.** Barycentre sweeps, down then up, keep the order with the fewest
 *    crossings. A frame's members stay contiguous in every rank they appear in, so a frame can be
 *    drawn around them.
 * 3. **Coordinates.** Each rank is a column; down the column, boxes sit as close to the average of
 *    the boxes they connect to as the spacing allows (an isotonic regression, so order is kept
 *    exactly). That is what makes most arrows straight.
 * 4. **Frames.** A frame spans the ranks its members do, and so can cross a rank where a non-member
 *    sits. Those are pushed out, and the rank re-packed, until no frame holds a box that is not its.
 *
 * Everything is computed along two abstract axes — *rank* and *cross* — and mapped to x/y at the end,
 * so left-to-right and top-to-bottom are the same code.
 */
import type { Box } from "../scene";

export interface LNode {
  id: string;
  /** Final (not abstract) size. */
  w: number;
  h: number;
  /** A rank the document asked for. */
  rank?: number;
  /** The innermost frame this node belongs to. */
  cluster?: string | null;
}

export interface LEdge {
  from: string;
  to: string;
  /** Width of the label it will carry, so the gap it crosses has room for it. */
  labelW: number;
}

export interface LCluster {
  id: string;
  parent: string | null;
  pad: number;
}

export interface LayeredOptions {
  direction: "LR" | "TB";
  rankGap: number;
  rowGap: number;
  /** Height of a frame's title strip. */
  header: number;
}

export interface LayeredResult {
  boxes: Map<string, Box>;
  frames: Map<string, Box>;
  rankCount: number;
}

// ---------------------------------------------------------------------------------------------
// Ranks
// ---------------------------------------------------------------------------------------------

/**
 * One rank per box. `preset` pins the ones the document placed itself; the rest follow the edges.
 * The result is not dense when presets leave gaps — see [`denseRanks`].
 */
export function assignRanks(
  ids: string[],
  edges: Array<[string, string]>,
  preset: Map<string, number> = new Map(),
): Map<string, number> {
  const known = new Set(ids);
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [a, b] of edges) {
    if (a === b || !known.has(a) || !known.has(b)) continue;
    out.get(a)!.push(b);
    incoming.set(b, incoming.get(b)! + 1);
  }

  // Back edges, by DFS from the sources first — so the edge a reader would call "the way back" is
  // the one set aside, not an arbitrary edge of the cycle.
  const roots = [...ids.filter((id) => incoming.get(id) === 0), ...ids.filter((id) => incoming.get(id) !== 0)];
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  for (const root of roots) {
    if (state.has(root)) continue;
    const stack: { id: string; i: number }[] = [{ id: root, i: 0 }];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = out.get(top.id)![top.i++];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
      } else if (state.get(next) === 1) {
        back.add(`${top.id}\u0000${next}`);
      } else if (!state.has(next)) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }

  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, string[]>(ids.map((id) => [id, []]));
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const [a, b] of edges) {
    if (a === b || !known.has(a) || !known.has(b) || back.has(`${a}\u0000${b}`)) continue;
    if (succs.get(a)!.includes(b)) continue;
    succs.get(a)!.push(b);
    preds.get(b)!.push(a);
    indegree.set(b, indegree.get(b)! + 1);
  }

  const order: string[] = [];
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const left = new Map(indegree);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of succs.get(id)!) {
      left.set(next, left.get(next)! - 1);
      if (left.get(next) === 0) queue.push(next);
    }
  }

  const rank = new Map<string, number>();
  for (const id of order) {
    const fromPreds = Math.max(-1, ...preds.get(id)!.map((p) => rank.get(p)!)) + 1;
    rank.set(id, preset.get(id) ?? fromPreds);
  }
  // A source with nothing to its left belongs beside its nearest target, not at rank 0.
  for (const id of [...order].reverse()) {
    if (preds.get(id)!.length || preset.has(id) || !succs.get(id)!.length) continue;
    const near = Math.min(...succs.get(id)!.map((s) => rank.get(s)!)) - 1;
    if (near > rank.get(id)!) rank.set(id, near);
  }
  return rank;
}

/** Ranks renumbered 0..n with the gaps closed, keeping their order. */
export function denseRanks(rank: Map<string, number>): { rank: Map<string, number>; count: number } {
  const values = [...new Set(rank.values())].sort((a, b) => a - b);
  const index = new Map(values.map((value, at) => [value, at]));
  return { rank: new Map([...rank].map(([id, value]) => [id, index.get(value)!])), count: values.length };
}

// ---------------------------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------------------------

interface Abs {
  /** Position along the rank axis and across it. */
  a: number;
  c: number;
  /** Extent along the rank axis and across it. */
  wa: number;
  wc: number;
}

function isotonic(target: number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const value of target) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const before = blocks[blocks.length - 2];
      if (before.sum / before.count <= last.sum / last.count) break;
      blocks.pop();
      blocks[blocks.length - 1] = { sum: before.sum + last.sum, count: before.count + last.count };
    }
  }
  return blocks.flatMap((block) => new Array<number>(block.count).fill(block.sum / block.count));
}

/** Every box a frame holds, its sub-frames' included. */
export function clusterMembers(
  nodeCluster: Map<string, string | null>,
  clusters: LCluster[],
): Map<string, Set<string>> {
  const children = new Map<string | null, string[]>();
  for (const cluster of clusters) children.set(cluster.parent, [...(children.get(cluster.parent) ?? []), cluster.id]);
  const direct = new Map<string, string[]>();
  for (const [id, cluster] of nodeCluster) if (cluster) direct.set(cluster, [...(direct.get(cluster) ?? []), id]);
  const all = (id: string): string[] => [...(direct.get(id) ?? []), ...(children.get(id) ?? []).flatMap(all)];
  return new Map(clusters.map((c) => [c.id, new Set(all(c.id))]));
}

/**
 * A frame around each cluster's boxes: padded, with a title strip on top, and padded further for
 * every frame inside it so nested frames read as nested.
 */
export function clusterFrames(
  boxes: Map<string, Box>,
  nodeCluster: Map<string, string | null>,
  clusters: LCluster[],
  header: number,
): Map<string, Box> {
  const children = new Map<string | null, string[]>();
  for (const cluster of clusters) children.set(cluster.parent, [...(children.get(cluster.parent) ?? []), cluster.id]);
  const direct = new Map<string, string[]>();
  for (const [id, cluster] of nodeCluster) if (cluster) direct.set(cluster, [...(direct.get(cluster) ?? []), id]);
  const padOf = new Map(clusters.map((c) => [c.id, c.pad]));
  const out = new Map<string, Box>();
  const build = (id: string): { box: Box; pad: number } | null => {
    const parts: Box[] = (direct.get(id) ?? []).flatMap((n) => (boxes.has(n) ? [boxes.get(n)!] : []));
    let pad = padOf.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      const built = build(child);
      if (!built) continue;
      parts.push(built.box);
      pad = Math.max(pad, built.pad + 12);
    }
    if (parts.length === 0) return null;
    const x0 = Math.min(...parts.map((b) => b[0])) - pad;
    const y0 = Math.min(...parts.map((b) => b[1])) - pad - header;
    const x1 = Math.max(...parts.map((b) => b[0] + b[2])) + pad;
    const y1 = Math.max(...parts.map((b) => b[1] + b[3])) + pad;
    const box: Box = [x0, y0, x1 - x0, y1 - y0];
    out.set(id, box);
    return { box, pad };
  };
  for (const root of children.get(null) ?? []) build(root);
  return out;
}

export function layered(
  nodes: LNode[],
  edges: LEdge[],
  clusters: LCluster[],
  options: LayeredOptions,
): LayeredResult {
  const LR = options.direction === "LR";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const authored = new Map(nodes.map((node, at) => [node.id, at]));
  const abs = new Map<string, Abs>(
    nodes.map((node) => [node.id, { a: 0, c: 0, wa: LR ? node.w : node.h, wc: LR ? node.h : node.w }]),
  );

  const usable = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
  const preset = new Map(nodes.flatMap((n) => (n.rank !== undefined ? [[n.id, n.rank] as const] : [])));
  const { rank, count: rankCount } = denseRanks(
    assignRanks(nodes.map((n) => n.id), usable.map((e) => [e.from, e.to]), preset),
  );

  // Cluster paths, outermost first.
  const parentOf = new Map(clusters.map((c) => [c.id, c.parent]));
  const padOf = new Map(clusters.map((c) => [c.id, c.pad]));
  const pathOf = new Map<string, string[]>();
  for (const node of nodes) {
    const path: string[] = [];
    for (let at = node.cluster ?? null; at; at = parentOf.get(at) ?? null) path.unshift(at);
    pathOf.set(node.id, path);
  }

  // --- order within each rank --------------------------------------------------------------
  const neighbours = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of usable) {
    neighbours.get(e.from)!.push(e.to);
    neighbours.get(e.to)!.push(e.from);
  }

  const dfs = new Map<string, number>();
  const visit = (id: string) => {
    if (dfs.has(id)) return;
    dfs.set(id, dfs.size);
    for (const next of usable.filter((e) => e.from === id).map((e) => e.to)) visit(next);
  };
  const hasIn = new Set(usable.map((e) => e.to));
  for (const n of nodes) if (!hasIn.has(n.id)) visit(n.id);
  for (const n of nodes) visit(n.id);

  let ranks: string[][] = Array.from({ length: rankCount }, () => []);
  for (const n of nodes) ranks[rank.get(n.id)!].push(n.id);
  ranks.forEach((list) => list.sort((x, y) => dfs.get(x)! - dfs.get(y)! || authored.get(x)! - authored.get(y)!));

  const positions = (current: string[][]) => {
    const out = new Map<string, number>();
    current.forEach((list) => list.forEach((id, at) => out.set(id, (at + 0.5) / list.length)));
    return out;
  };
  const crossings = (current: string[][]) => {
    const pos = positions(current);
    const adjacent = usable.filter((e) => rank.get(e.to)! === rank.get(e.from)! + 1);
    let total = 0;
    for (let i = 0; i < adjacent.length; i++) {
      for (let j = i + 1; j < adjacent.length; j++) {
        const p = adjacent[i];
        const q = adjacent[j];
        if (rank.get(p.from) !== rank.get(q.from)) continue;
        if ((pos.get(p.from)! - pos.get(q.from)!) * (pos.get(p.to)! - pos.get(q.to)!) < 0) total++;
      }
    }
    return total;
  };

  const sortRank = (list: string[], bary: (id: string) => number, previous: Map<string, number>): string[] => {
    const sortLevel = (ids: string[], depth: number): string[] => {
      const groups = new Map<string, string[]>();
      const items: { key: number; tie: number; out: string[] }[] = [];
      for (const id of ids) {
        const path = pathOf.get(id)!;
        if (path.length <= depth) items.push({ key: bary(id), tie: previous.get(id)!, out: [id] });
        else groups.set(path[depth], [...(groups.get(path[depth]) ?? []), id]);
      }
      for (const members of groups.values()) {
        items.push({
          key: members.reduce((sum, id) => sum + bary(id), 0) / members.length,
          tie: Math.min(...members.map((id) => previous.get(id)!)),
          out: sortLevel(members, depth + 1),
        });
      }
      items.sort((x, y) => x.key - y.key || x.tie - y.tie);
      return items.flatMap((item) => item.out);
    };
    return sortLevel(list, 0);
  };

  let best = ranks.map((list) => [...list]);
  let bestCrossings = crossings(ranks);
  for (let sweep = 0; sweep < 16 && bestCrossings > 0; sweep++) {
    const down = sweep % 2 === 0;
    const sequence = down
      ? Array.from({ length: rankCount - 1 }, (_, at) => at + 1)
      : Array.from({ length: rankCount - 1 }, (_, at) => rankCount - 2 - at);
    for (const r of sequence) {
      const pos = positions(ranks);
      const bary = (id: string) => {
        let sum = 0;
        let weight = 0;
        for (const other of neighbours.get(id)!) {
          const gap = rank.get(other)! - r;
          if (down ? gap >= 0 : gap <= 0) continue;
          const w = 1 / Math.abs(gap);
          sum += pos.get(other)! * w;
          weight += w;
        }
        return weight ? sum / weight : pos.get(id)!;
      };
      const previous = new Map(ranks[r].map((id, at) => [id, at]));
      ranks[r] = sortRank(ranks[r], bary, previous);
    }
    const total = crossings(ranks);
    if (total < bestCrossings) {
      bestCrossings = total;
      best = ranks.map((list) => [...list]);
    }
  }
  ranks = best;

  // --- coordinates ---------------------------------------------------------------------------
  const extra = (a: string, b: string): number => {
    const pa = pathOf.get(a)!;
    const pb = pathOf.get(b)!;
    let common = 0;
    while (common < pa.length && common < pb.length && pa[common] === pb[common]) common++;
    const leave = pa.slice(common).reduce((sum, id) => sum + (padOf.get(id) ?? 0) + 6, 0);
    const enter = pb.slice(common).reduce((sum, id) => sum + (padOf.get(id) ?? 0) + 6 + options.header, 0);
    return leave + enter;
  };
  const separation = (a: string, b: string) =>
    (abs.get(a)!.wc + abs.get(b)!.wc) / 2 + options.rowGap + extra(a, b);

  // Rank positions along the rank axis.
  const rankSize = ranks.map((list) => Math.max(0, ...list.map((id) => abs.get(id)!.wa)));
  let cursor = 0;
  const rankStart: number[] = [];
  ranks.forEach((_, r) => {
    rankStart[r] = cursor;
    // What a gap must hold is the label's extent *along the rank axis*: its width when ranks run
    // left to right, its height when they run down the page — where a label sits on a vertical line
    // and a few lines' worth of gap is plenty.
    const labelled = usable
      .filter((e) => rank.get(e.from) === r && rank.get(e.to) === r + 1)
      .reduce((widest, e) => Math.max(widest, e.labelW > 0 ? (LR ? e.labelW : 24) : 0), 0);
    cursor += rankSize[r] + Math.max(options.rankGap, labelled + (LR ? 36 : 40));
  });
  ranks.forEach((list, r) => {
    for (const id of list) {
      const box = abs.get(id)!;
      box.a = rankStart[r] + (rankSize[r] - box.wa) / 2;
    }
  });

  // Cross-axis: start stacked and centred, then pull each box toward what it connects to.
  const centre = new Map<string, number>();
  for (const list of ranks) {
    let at = 0;
    const stacked = list.map((id, i) => {
      if (i > 0) at += separation(list[i - 1], id);
      return at;
    });
    const mean = stacked.length ? stacked.reduce((s, v) => s + v, 0) / stacked.length : 0;
    list.forEach((id, i) => centre.set(id, stacked[i] - mean));
  }
  const settle = (r: number, toward: "before" | "after" | "both") => {
    const list = ranks[r];
    if (!list.length) return;
    const desired = list.map((id) => {
      let sum = 0;
      let weight = 0;
      for (const other of neighbours.get(id)!) {
        const gap = rank.get(other)! - r;
        if (gap === 0 || (toward === "before" && gap > 0) || (toward === "after" && gap < 0)) continue;
        const w = 1 / Math.abs(gap);
        sum += centre.get(other)! * w;
        weight += w;
      }
      return weight ? sum / weight : centre.get(id)!;
    });
    const offset: number[] = [0];
    for (let i = 1; i < list.length; i++) offset[i] = offset[i - 1] + separation(list[i - 1], list[i]);
    const fitted = isotonic(desired.map((value, i) => value - offset[i]));
    list.forEach((id, i) => centre.set(id, fitted[i] + offset[i]));
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let r = 1; r < rankCount; r++) settle(r, "before");
    for (let r = rankCount - 2; r >= 0; r--) settle(r, "after");
  }
  // The last word goes to both sides at once: ending on a pull toward the successors alone leaves a
  // box whose only predecessor is straight above it a few steps to one side.
  for (let pass = 0; pass < 3; pass++) for (let r = 0; r < rankCount; r++) settle(r, "both");
  for (const n of nodes) {
    const box = abs.get(n.id)!;
    box.c = centre.get(n.id)! - box.wc / 2;
  }

  const finalBox = (id: string): Box => {
    const b = abs.get(id)!;
    return LR ? [b.a, b.c, b.wa, b.wc] : [b.c, b.a, b.wc, b.wa];
  };

  // --- frames --------------------------------------------------------------------------------
  const nodeCluster = new Map(nodes.map((n) => [n.id, n.cluster ?? null]));
  const memberSets = clusterMembers(nodeCluster, clusters);
  const frameBoxes = () =>
    clusterFrames(new Map(nodes.map((n) => [n.id, finalBox(n.id)])), nodeCluster, clusters, options.header);

  const repack = (r: number) => {
    const list = [...ranks[r]].sort((x, y) => abs.get(x)!.c - abs.get(y)!.c);
    for (let i = 1; i < list.length; i++) {
      const before = abs.get(list[i - 1])!;
      const here = abs.get(list[i])!;
      const need = before.c + before.wc + options.rowGap;
      if (here.c < need) here.c = need;
    }
    ranks[r] = list;
  };

  const margin = 14;
  /** Whether frame `a` is one of `b`'s ancestors or `b` one of `a`'s — frames meant to overlap. */
  const nested = (a: string, b: string) => {
    for (let at: string | null = a; at; at = parentOf.get(at) ?? null) if (at === b) return true;
    for (let at: string | null = b; at; at = parentOf.get(at) ?? null) if (at === a) return true;
    return false;
  };
  const overlapsBox = (a: Box, b: Box, pad: number) =>
    a[0] < b[0] + b[2] + pad && b[0] < a[0] + a[2] + pad && a[1] < b[1] + b[3] + pad && b[1] < a[1] + a[3] + pad;
  /** How many times each box has been pushed out of each frame: past two, the other side is tried. */
  const pushes = new Map<string, number>();
  for (let guard = 0; guard < 160 && clusters.length; guard++) {
    const frames = frameBoxes();
    let moved = false;

    // A box that is not a frame's, inside it: out it goes, along the cross axis. Only a box the frame
    // really covers moves — one merely near it is where it should be — and it leaves with a margin.
    for (const cluster of clusters) {
      const frame = frames.get(cluster.id);
      if (!frame) continue;
      const members = memberSets.get(cluster.id)!;
      for (const n of nodes) {
        if (members.has(n.id)) continue;
        if (!overlapsBox(finalBox(n.id), frame, 0)) continue;
        const key = `${n.id}|${cluster.id}`;
        const times = pushes.get(key) ?? 0;
        if (times >= 6) continue;
        pushes.set(key, times + 1);
        const a = abs.get(n.id)!;
        const lo = LR ? frame[1] : frame[0];
        const size = LR ? frame[3] : frame[2];
        // A pixel past the margin, not on it: landing exactly on the edge of "close enough" reads as
        // still too close after rounding, and the box is pushed nowhere, forever.
        const before = a.c + a.wc - (lo - margin) + 1;
        const after = lo + size + margin - a.c + 1;
        const toBefore = times >= 2 ? times % 2 === 1 : before < after;
        a.c += toBefore ? -before : after;
        repack(rank.get(n.id)!);
        moved = true;
        break;
      }
      if (moved) break;
    }
    if (moved) continue;

    // Two frames that are neither nested nor apart: the smaller one's boxes move off the other.
    for (let i = 0; i < clusters.length && !moved; i++) {
      for (let j = i + 1; j < clusters.length && !moved; j++) {
        const [ca, cb] = [clusters[i].id, clusters[j].id];
        const [fa, fb] = [frames.get(ca), frames.get(cb)];
        if (!fa || !fb || nested(ca, cb) || !overlapsBox(fa, fb, 0)) continue;
        const [mover, fm, fs] = memberSets.get(ca)!.size <= memberSets.get(cb)!.size ? [ca, fa, fb] : [cb, fb, fa];
        const mid = (f: Box) => (LR ? f[1] + f[3] / 2 : f[0] + f[2] / 2);
        const lo = (f: Box) => (LR ? f[1] : f[0]);
        const size = (f: Box) => (LR ? f[3] : f[2]);
        const delta =
          mid(fm) >= mid(fs) ? lo(fs) + size(fs) + margin - lo(fm) + 1 : -(lo(fm) + size(fm) + margin - lo(fs) + 1);
        const ranksTouched = new Set<number>();
        for (const id of memberSets.get(mover)!) {
          abs.get(id)!.c += delta;
          ranksTouched.add(rank.get(id)!);
        }
        for (const r of ranksTouched) repack(r);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const boxes = new Map<string, Box>(nodes.map((n) => [n.id, finalBox(n.id)]));
  return { boxes, frames: frameBoxes(), rankCount };
}
