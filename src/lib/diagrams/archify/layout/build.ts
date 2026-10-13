/**
 * From a document to a scene: sizes every box, places it, routes every line, and frames what the
 * document groups. One builder per diagram type, all ending in the same [`ArchifyScene`].
 *
 * What differs between the types is only *where the boxes may go*:
 * - architecture is free — ranks along its connections, frames around its boundaries — unless the
 *   document placed every component itself;
 * - workflow and lifecycle are a grid of lanes (rows) by columns (ranks);
 * - dataflow is a grid of stages (columns) by rows;
 * - sequence is participants across the top and messages down, in order.
 */
import {
  activationsOf,
  archifyEntities,
  archifyRelations,
  ARCHIFY_TYPES,
  LIFECYCLE_TYPES,
  type ArchifyArchitecture,
  type ArchifyDataflow,
  type ArchifyDocument,
  type ArchifyEntity,
  type ArchifyLifecycle,
  type ArchifyRelation,
  type ArchifyRepository,
  type ArchifySequence,
  type ArchifySource,
  type ArchifyWorkflow,
} from "../ir";
import type {
  ArchifyScene,
  Box,
  FrameKind,
  SceneActivation,
  SceneBand,
  SceneEdge,
  SceneFrame,
  SceneMessage,
  SceneNode,
  SceneShape,
  SceneSource,
} from "../scene";
import { clipToWidth, textWidth, wrapToWidth } from "../text";
import { assignRanks, clusterFrames, denseRanks, layered, type LCluster, type LNode } from "./engine";
import { roundedPath, routeAll, type Routed } from "./route";

export interface SceneOptions {
  /** Whether a source becomes a link — off inside the sandboxed frame, which cannot follow one. */
  linkSources: boolean;
}

// ---------------------------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------------------------

const LABEL_FONT = 13.5;
const SUB_FONT = 11;
const PILL_FONT = 10.5;

/** The width of a label's pill: its text, and a badge when the flow carries a classification. */
function pillWidth(label: string, classification = ""): number {
  if (!label && !classification) return 0;
  const text = label ? textWidth(clipToWidth(label, PILL_FONT, 190, true), PILL_FONT, true) : 0;
  const badge = classification ? textWidth(classification, 9, true) + 14 : 0;
  return Math.ceil(text + badge + 18 + (label && classification ? 4 : 0));
}

interface Measured {
  w: number;
  h: number;
  lines: string[];
  sublabel: string;
  shape: SceneShape;
  /** Whether the tag fits on the second row, beside the sublabel. */
  tagFit: boolean;
}

/**
 * A card, sized to its text: a dot and up to two label lines, then one row for the sublabel and the
 * tag. The type is the dot's colour — and the legend's, and the panel's, and the tooltip's — so it
 * does not take a row of its own on every box.
 */
function measure(entity: ArchifyEntity, shape: SceneShape = "card"): Measured {
  if (shape === "diamond") {
    const lines = wrapToWidth(entity.label, 12.5, 112, 2, true);
    const w = Math.max(150, Math.ceil(Math.max(...lines.map((l) => textWidth(l, 12.5, true))) + 78));
    return { w, h: 96, lines, sublabel: "", shape, tagFit: false };
  }
  if (shape === "pill") {
    const lines = wrapToWidth(entity.label, LABEL_FONT, 200, 1, true);
    const w = Math.max(132, Math.ceil(textWidth(lines[0], LABEL_FONT, true) + 52));
    return { w, h: 50, lines, sublabel: "", shape, tagFit: false };
  }
  const lines = wrapToWidth(entity.label, LABEL_FONT, 200, 2, true);
  const labelW = Math.max(...lines.map((l) => textWidth(l, LABEL_FONT, true)));
  const subW = entity.sublabel ? textWidth(entity.sublabel, SUB_FONT) : 0;
  const tagW = entity.tag ? textWidth(entity.tag, 9, true) + 4 : 0;
  const second = Math.min(subW, 190) + (entity.sublabel && entity.tag ? tagW + 12 : tagW) + 26;
  const w = Math.min(246, Math.max(144, Math.ceil(Math.max(labelW + 44, second))));
  const room = w - 26 - (entity.tag ? tagW + 12 : 0);
  const sublabel = entity.sublabel ? clipToWidth(entity.sublabel, SUB_FONT, Math.max(40, room)) : "";
  const tagFit = !!entity.tag && textWidth(sublabel, SUB_FONT) + tagW + 12 + 26 <= w + 1;
  const h = 11 + 17 * lines.length + (sublabel || entity.tag ? 17 : 0) + 10;
  return { w, h, lines, sublabel, shape, tagFit };
}

function sourceOf(repo: ArchifyRepository | undefined, source: ArchifySource, link: boolean): SceneSource {
  let href = "";
  if (link && repo && repo.link_mode === "web" && repo.provider === "github") {
    const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo.url);
    if (match) {
      const path = source.path.split("/").map(encodeURIComponent).join("/");
      const lines = source.line ? `#L${source.line}${source.end_line ? `-L${source.end_line}` : ""}` : "";
      href = `https://github.com/${match[1]}/${match[2]}/blob/${repo.revision}/${path}${lines}`;
    }
  }
  return { path: source.path, line: source.line ?? 0, end: source.end_line ?? 0, label: source.label ?? "", href };
}

function nodeOf(
  entity: ArchifyEntity,
  m: Measured,
  box: Box,
  repo: ArchifyRepository | undefined,
  options: SceneOptions,
  step = "",
): SceneNode {
  return {
    id: entity.id,
    kind: entity.kind,
    shape: m.shape,
    lines: m.lines,
    sublabel: m.sublabel,
    tag: entity.tag ?? "",
    tagFit: m.tagFit,
    step,
    box,
    sources: entity.sources.map((s) => sourceOf(repo, s, options.linkSources)),
  };
}

function edgeOf(relation: ArchifyRelation, routed: Routed | undefined): SceneEdge | null {
  if (!routed) return null;
  return {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    label: relation.label,
    style: relation.style,
    d: roundedPath(routed.points),
    points: routed.points,
    at: routed.at,
    note: relation.note ?? "",
    classification: relation.classification ?? "",
    role: relation.role ?? "",
  };
}

function legendOf(nodes: SceneNode[]): string[] {
  const used = new Set(nodes.map((n) => n.kind));
  return [...ARCHIFY_TYPES, ...LIFECYCLE_TYPES].filter((kind, at, all) => used.has(kind) && all.indexOf(kind) === at);
}

function boundsOf(parts: Box[]): Box {
  const margin = 36;
  const x0 = Math.min(...parts.map((b) => b[0])) - margin;
  const y0 = Math.min(...parts.map((b) => b[1])) - margin;
  const x1 = Math.max(...parts.map((b) => b[0] + b[2])) + margin;
  const y1 = Math.max(...parts.map((b) => b[1] + b[3])) + margin;
  return [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)];
}

function emptyScene(doc: ArchifyDocument): ArchifyScene {
  return {
    mode: doc.diagram_type,
    title: doc.meta.title,
    subtitle: doc.meta.subtitle ?? "",
    direction: "LR",
    bounds: [0, 0, 0, 0],
    nodes: [],
    frames: [],
    edges: [],
    messages: [],
    bands: [],
    activations: [],
    cards: doc.cards,
    legend: [],
  };
}

function finish(scene: ArchifyScene, extra: Box[] = []): ArchifyScene {
  const parts: Box[] = [
    ...scene.nodes.map((n) => n.box),
    ...scene.frames.map((f) => f.box),
    ...scene.edges.flatMap((e) => (e.at ? [e.at] : [])),
    ...scene.messages.map((m) => m.at),
    ...scene.bands.map((b): Box => [scene.nodes.length ? Math.min(...scene.nodes.map((n) => n.box[0])) : 0, b.y1, 1, b.y2 - b.y1]),
    ...extra,
  ];
  scene.bounds = parts.length ? boundsOf(parts) : [0, 0, 400, 300];
  scene.legend = legendOf(scene.nodes);
  scene.frames.sort((a, b) => a.depth - b.depth);
  return scene;
}

// ---------------------------------------------------------------------------------------------
// Architecture
// ---------------------------------------------------------------------------------------------

/**
 * A run of boxes that sit together because nothing connects them to each other — the five providers
 * a service calls, the stores behind one API — laid out as a small grid instead of a line.
 *
 * Left to the layered layout they all land in one rank, and a rank of five is five boxes wide: the
 * diagram doubles in width for the sake of a fan. Packed, the group is a single box to the layout
 * (so it is ranked and placed once, from the edges of all its members together) and is opened into
 * its grid afterwards; the lines still go to each member.
 *
 * Two kinds of group qualify: a frame's members, when the frame holds nothing else and no line runs
 * between them; and *twins* — three or more boxes in the same frame with exactly the same neighbours.
 */
interface Pack {
  id: string;
  members: string[];
  w: number;
  h: number;
  /** Each member's offset inside the pack's box. */
  at: Map<string, [number, number]>;
}

/** Wider than a line's stub and its margin together, or no line can reach the boxes between. */
const PACK_GAP: [number, number] = [38, 42];

function gridOf(members: string[], sizes: Map<string, Measured>): Omit<Pack, "id" | "members"> {
  const n = members.length;
  const rows = Math.ceil(n / 3);
  const cols = Math.ceil(n / rows);
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...members.filter((_, i) => i % cols === c).map((id) => sizes.get(id)!.w)));
  const rowH = Array.from({ length: rows }, (_, r) => Math.max(...members.filter((_, i) => Math.floor(i / cols) === r).map((id) => sizes.get(id)!.h)));
  const x0 = colW.map((_, c) => colW.slice(0, c).reduce((sum, w) => sum + w + PACK_GAP[0], 0));
  const y0 = rowH.map((_, r) => rowH.slice(0, r).reduce((sum, h) => sum + h + PACK_GAP[1], 0));
  const at = new Map<string, [number, number]>();
  members.forEach((id, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const m = sizes.get(id)!;
    at.set(id, [x0[c] + (colW[c] - m.w) / 2, y0[r] + (rowH[r] - m.h) / 2]);
  });
  return {
    w: colW.reduce((sum, w) => sum + w, 0) + PACK_GAP[0] * (cols - 1),
    h: rowH.reduce((sum, h) => sum + h, 0) + PACK_GAP[1] * (rows - 1),
    at,
  };
}

function findPacks(
  order: string[],
  relations: { from: string; to: string }[],
  nodeCluster: Map<string, string | null>,
  clusterIds: string[],
  clusterParents: Map<string, string | null>,
  sizes: Map<string, Measured>,
): Pack[] {
  const out = new Map(order.map((id) => [id, new Set<string>()]));
  const into = new Map(order.map((id) => [id, new Set<string>()]));
  for (const r of relations) {
    if (r.from === r.to) continue;
    out.get(r.from)?.add(r.to);
    into.get(r.to)?.add(r.from);
  }
  const connected = (ids: string[]) => ids.some((a) => ids.some((b) => a !== b && out.get(a)!.has(b)));
  const packs: Pack[] = [];
  const taken = new Set<string>();
  const add = (members: string[]) => {
    const pack: Pack = { id: `pack:${packs.length}`, members, ...gridOf(members, sizes) };
    packs.push(pack);
    members.forEach((id) => taken.add(id));
  };

  // A frame that holds only boxes, none connected to another.
  for (const cluster of clusterIds) {
    if ([...clusterParents.values()].includes(cluster)) continue;
    const members = order.filter((id) => nodeCluster.get(id) === cluster && !taken.has(id));
    const all = order.filter((id) => nodeCluster.get(id) === cluster);
    if (members.length >= 3 && members.length === all.length && !connected(members)) add(members);
  }
  // Twins: the same neighbours, in the same frame.
  const twins = new Map<string, string[]>();
  for (const id of order) {
    if (taken.has(id)) continue;
    const key = `${nodeCluster.get(id) ?? ""}|${[...into.get(id)!].sort().join(",")}|${[...out.get(id)!].sort().join(",")}`;
    twins.set(key, [...(twins.get(key) ?? []), id]);
  }
  for (const members of twins.values()) {
    if (members.length >= 4 && !connected(members)) add(members);
  }
  return packs;
}


function buildArchitecture(doc: ArchifyArchitecture, options: SceneOptions): ArchifyScene {
  const scene = emptyScene(doc);
  const entities = archifyEntities(doc);
  const relations = archifyRelations(doc);
  const repo = doc.meta.repository;
  const sizes = new Map(entities.map((e) => [e.id, measure(e)]));

  // Boundaries nest by what they hold: the smallest one that contains another is its parent.
  const sets = doc.boundaries.map((b) => new Set(b.wraps));
  const inside = (inner: number, outer: number) =>
    inner !== outer &&
    [...sets[inner]].every((id) => sets[outer].has(id)) &&
    (sets[inner].size < sets[outer].size || inner > outer);
  const clusters: LCluster[] = doc.boundaries.map((boundary, at) => {
    let parent: number | null = null;
    sets.forEach((_, outer) => {
      if (inside(at, outer) && (parent === null || sets[outer].size <= sets[parent].size)) parent = outer;
    });
    return { id: `b${at}`, parent: parent === null ? null : `b${parent}`, pad: boundary.kind === "security-group" ? 16 : 20 };
  });
  const nodeCluster = new Map<string, string | null>();
  for (const entity of entities) {
    let best: number | null = null;
    sets.forEach((set, at) => {
      if (set.has(entity.id) && (best === null || set.size <= sets[best].size)) best = at;
    });
    nodeCluster.set(entity.id, best === null ? null : `b${best}`);
  }
  const HEADER = 26;

  // Where the document placed every component itself, that is where they go.
  const cell = doc.layout ? { origin: [40, 80], cols: 4, gapX: 30, gapY: 40, cellW: 130, cellH: 64, ...doc.layout } : null;
  const own = new Map<string, Box>();
  for (const component of doc.components) {
    let at = component.pos ?? null;
    if (!at && cell && component.row !== undefined && component.col !== undefined) {
      const origin = cell.origin as [number, number];
      at = [origin[0] + component.col * (cell.cellW + cell.gapX), origin[1] + component.row * (cell.cellH + cell.gapY)];
    }
    if (!at) break;
    const [w, h] = component.size ?? (cell ? [cell.cellW, cell.cellH] : [130, 64]);
    own.set(component.id, [at[0], at[1], w, h]);
  }
  const authored = own.size === doc.components.length;

  let boxes: Map<string, Box>;
  let frames: Map<string, Box>;
  let direction: "LR" | "TB" = "LR";
  if (authored) {
    boxes = own;
    frames = clusterFrames(boxes, nodeCluster, clusters, HEADER);
  } else {
    const order = entities.map((e) => e.id);
    const packs = findPacks(order, relations, nodeCluster, clusters.map((c) => c.id), new Map(clusters.map((c) => [c.id, c.parent])), sizes);
    const packOf = new Map(packs.flatMap((p) => p.members.map((id) => [id, p] as const)));
    const standIn = (id: string) => packOf.get(id)?.id ?? id;
    const nodes: LNode[] = [
      ...entities.filter((e) => !packOf.has(e.id)).map((e) => ({ id: e.id, w: sizes.get(e.id)!.w, h: sizes.get(e.id)!.h, cluster: nodeCluster.get(e.id) })),
      ...packs.map((p) => ({ id: p.id, w: p.w, h: p.h, cluster: nodeCluster.get(p.members[0]) })),
    ];
    const seen = new Set<string>();
    const edges = relations.flatMap((r) => {
      const from = standIn(r.from);
      const to = standIn(r.to);
      const key = `${from}\u0000${to}`;
      if (from === to || seen.has(key)) return [];
      seen.add(key);
      return [{ from, to, labelW: Math.max(...relations.filter((q) => standIn(q.from) === from && standIn(q.to) === to).map((q) => pillWidth(q.label))) }];
    });
    const attempt = (dir: "LR" | "TB") =>
      layered(nodes, edges, clusters, {
        direction: dir,
        rankGap: dir === "LR" ? 78 : 54,
        rowGap: dir === "LR" ? 32 : 30,
        header: HEADER,
      });
    // Whichever direction the diagram reads larger in, on the screen it will be looked at in.
    const scale = (r: ReturnType<typeof attempt>) => {
      const all = [...r.boxes.values(), ...r.frames.values()];
      const w = Math.max(...all.map((b) => b[0] + b[2])) - Math.min(...all.map((b) => b[0]));
      const h = Math.max(...all.map((b) => b[1] + b[3])) - Math.min(...all.map((b) => b[1]));
      return Math.min(1060 / (w + 72), 640 / (h + 72), 1.2);
    };
    let result = attempt("LR");
    const tb = attempt("TB");
    if (scale(tb) > scale(result) * 1.08) {
      result = tb;
      direction = "TB";
    }
    boxes = new Map<string, Box>();
    for (const [id, box] of result.boxes) {
      const pack = packs.find((p) => p.id === id);
      if (!pack) {
        boxes.set(id, box);
        continue;
      }
      for (const member of pack.members) {
        const [dx, dy] = pack.at.get(member)!;
        const m = sizes.get(member)!;
        boxes.set(member, [box[0] + dx, box[1] + dy, m.w, m.h]);
      }
    }
    frames = clusterFrames(boxes, nodeCluster, clusters, HEADER);
  }

  // A frame's title is a place no label may sit.
  const titles = doc.boundaries.flatMap((b, at): Box[] => {
    const frame = frames.get(`b${at}`);
    return frame ? [[frame[0], frame[1], Math.min(frame[2], textWidth(b.label.toUpperCase(), 10, true) * 1.18 + 36), 26]] : [];
  });
  const routes = routeAll(
    boxes,
    relations.map((r) => ({ id: r.id, from: r.from, to: r.to, labelW: pillWidth(r.label) })),
    { direction, avoid: titles },
  );
  scene.direction = direction;
  scene.nodes = entities.map((e) => nodeOf(e, sizes.get(e.id)!, boxes.get(e.id)!, repo, options));
  scene.edges = relations.flatMap((r) => edgeOf(r, routes.get(r.id)) ?? []);

  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    if (!depth.has(id)) {
      const parent = clusters.find((c) => c.id === id)?.parent ?? null;
      depth.set(id, parent ? depthOf(parent) + 1 : 0);
    }
    return depth.get(id)!;
  };
  scene.frames = doc.boundaries.flatMap((boundary, at): SceneFrame[] => {
    const box = frames.get(`b${at}`);
    return box
      ? [{ id: `b${at}`, kind: boundary.kind, label: boundary.label, box, depth: depthOf(`b${at}`), style: boundary.kind }]
      : [];
  });
  return finish(scene);
}

// ---------------------------------------------------------------------------------------------
// Lane grids: workflow and lifecycle
// ---------------------------------------------------------------------------------------------

interface GridItem {
  id: string;
  m: Measured;
  lane: number;
  col?: number;
}

interface GridResult {
  boxes: Map<string, Box>;
  rank: Map<string, number>;
  rankCount: number;
  colX: [number, number][];
  lanes: Box[];
  headerH: number;
  /** An authored column number, as the rank it became. */
  colOf: (col: number) => number;
}

const LANE_LABEL_W = 148;
/** Between boxes stacked in one lane and column — more than a line's stub and margin together. */
const STACK_GAP = 32;
const PHASE_H = 40;

function laneGrid(
  items: GridItem[],
  edges: { from: string; to: string; labelW: number }[],
  laneCount: number,
  /** Extra room above a lane's boxes, by lane: for a group's title, or a loop and its label. */
  topRoom: Map<number, number>,
  withPhases: boolean,
): GridResult {
  const ids = items.map((i) => i.id);
  const preset = new Map(items.flatMap((i) => (i.col !== undefined ? [[i.id, i.col] as const] : [])));
  const { rank, count } = denseRanks(assignRanks(ids, edges.map((e) => [e.from, e.to]), preset));
  const rankCount = Math.max(1, count);

  const presetToRank = new Map<number, number>();
  for (const item of items) if (item.col !== undefined) presetToRank.set(item.col, rank.get(item.id)!);
  const presetKeys = [...presetToRank.keys()].sort((a, b) => a - b);
  const colOf = (col: number): number => {
    if (!presetKeys.length) return Math.min(rankCount - 1, Math.max(0, col));
    const next = presetKeys.find((k) => k >= col);
    return presetToRank.get(next ?? presetKeys[presetKeys.length - 1])!;
  };

  const widths = Array.from({ length: rankCount }, (_, r) =>
    Math.max(0, ...items.filter((i) => rank.get(i.id) === r).map((i) => i.m.w)),
  );
  const colX: [number, number][] = [];
  let cursor = LANE_LABEL_W + 30;
  for (let r = 0; r < rankCount; r++) {
    colX.push([cursor, cursor + widths[r]]);
    const labelled = edges
      .filter((e) => rank.get(e.from) === r && rank.get(e.to) === r + 1)
      .reduce((widest, e) => Math.max(widest, e.labelW), 0);
    cursor += widths[r] + Math.max(72, labelled + 40);
  }
  const totalW = cursor - 40 + 36;

  const headerH = withPhases ? PHASE_H : 0;
  const boxes = new Map<string, Box>();
  const lanes: Box[] = [];
  let top = headerH;
  for (let lane = 0; lane < laneCount; lane++) {
    const cells = new Map<number, GridItem[]>();
    for (const item of items.filter((i) => i.lane === lane)) {
      const r = rank.get(item.id)!;
      cells.set(r, [...(cells.get(r) ?? []), item]);
    }
    const heights = [...cells.values()].map((cell) => cell.reduce((s, i) => s + i.m.h, 0) + STACK_GAP * (cell.length - 1));
    const header = topRoom.get(lane) ?? 0;
    const height = Math.max(104, Math.max(0, ...heights) + 44 + header);
    for (const [r, cell] of cells) {
      const total = cell.reduce((s, i) => s + i.m.h, 0) + STACK_GAP * (cell.length - 1);
      let y = top + header / 2 + (height - total) / 2 + (header ? header / 2 : 0);
      for (const item of cell) {
        const x = colX[r][0] + (widths[r] - item.m.w) / 2;
        boxes.set(item.id, [x, y, item.m.w, item.m.h]);
        y += item.m.h + STACK_GAP;
      }
    }
    lanes.push([0, top, totalW, height]);
    top += height + 12;
  }
  return { boxes, rank, rankCount, colX, lanes, headerH, colOf };
}

function buildWorkflow(doc: ArchifyWorkflow, options: SceneOptions): ArchifyScene {
  const scene = emptyScene(doc);
  const entities = archifyEntities(doc);
  const relations = archifyRelations(doc);
  const repo = doc.meta.repository;
  const laneIndex = new Map(doc.lanes.map((l, at) => [l.id, at]));
  const items: GridItem[] = doc.nodes.map((n, at) => ({
    id: n.id,
    m: measure(entities[at]),
    lane: laneIndex.get(n.lane) ?? 0,
    col: n.col,
  }));
  const topRoom = new Map<number, number>();
  for (const g of doc.groups) if (laneIndex.has(g.lane)) topRoom.set(laneIndex.get(g.lane)!, 24);
  const grid = laneGrid(items, relations.map((r) => ({ from: r.from, to: r.to, labelW: pillWidth(r.label) })), doc.lanes.length, topRoom, doc.phases.length > 0);
  const routes = routeAll(grid.boxes, relations.map((r) => ({ id: r.id, from: r.from, to: r.to, labelW: pillWidth(r.label) })), { direction: "LR" });

  scene.nodes = entities.map((e, at) => nodeOf(e, items[at].m, grid.boxes.get(e.id)!, repo, options));
  scene.edges = relations.flatMap((r) => edgeOf(r, routes.get(r.id)) ?? []);
  const frames: SceneFrame[] = [];
  doc.lanes.forEach((lane, at) => {
    frames.push({
      id: `lane-${lane.id}`,
      kind: lane.variant === "exception" ? "lane-exception" : "lane",
      label: lane.label,
      box: grid.lanes[at],
      depth: 0,
      style: lane.variant ?? "normal",
    });
  });
  const span = (from: number, to: number): [number, number] => [grid.colX[grid.colOf(from)][0], grid.colX[grid.colOf(to)][1]];
  doc.phases.forEach((phase) => {
    const [x0, x1] = span(phase.fromCol, phase.toCol);
    frames.push({ id: `phase-${phase.id}`, kind: "phase", label: phase.label, box: [x0 - 10, 4, x1 - x0 + 20, 28], depth: 1, style: phase.variant ?? "default" });
  });
  doc.groups.forEach((group) => {
    const lane = laneIndex.get(group.lane);
    if (lane === undefined) return;
    const from = grid.colOf(group.fromCol);
    const to = grid.colOf(group.toCol);
    const members = items.filter((i) => i.lane === lane && grid.rank.get(i.id)! >= from && grid.rank.get(i.id)! <= to);
    if (!members.length) return;
    const parts = members.map((i) => grid.boxes.get(i.id)!);
    const x0 = Math.min(...parts.map((b) => b[0])) - 12;
    const y0 = Math.min(...parts.map((b) => b[1])) - 28;
    const x1 = Math.max(...parts.map((b) => b[0] + b[2])) + 12;
    const y1 = Math.max(...parts.map((b) => b[1] + b[3])) + 12;
    frames.push({ id: `group-${group.id}`, kind: "group", label: group.label, box: [x0, y0, x1 - x0, y1 - y0], depth: 1, style: group.variant ?? "default" });
  });
  scene.frames = frames;
  return finish(scene);
}

function buildLifecycle(doc: ArchifyLifecycle, options: SceneOptions): ArchifyScene {
  const scene = emptyScene(doc);
  const entities = archifyEntities(doc);
  const relations = archifyRelations(doc);
  const repo = doc.meta.repository;
  const laneIndex = new Map(doc.lanes.map((l, at) => [l.id, at]));
  const shapeOf = (type: string): SceneShape => (type === "decision" ? "diamond" : type === "start" ? "pill" : "card");
  const items: GridItem[] = doc.states.map((s, at) => ({
    id: s.id,
    m: measure(entities[at], shapeOf(s.type)),
    lane: laneIndex.get(s.lane) ?? 0,
    col: s.col,
  }));
  // A state that loops onto itself needs room above it for the loop and its label.
  const topRoom = new Map<number, number>();
  for (const t of doc.transitions) {
    if (t.from === t.to) topRoom.set(laneIndex.get(doc.states.find((s) => s.id === t.from)!.lane) ?? 0, 44);
  }
  const grid = laneGrid(items, relations.map((r) => ({ from: r.from, to: r.to, labelW: pillWidth(r.label) })), doc.lanes.length, topRoom, false);
  const routes = routeAll(grid.boxes, relations.map((r) => ({ id: r.id, from: r.from, to: r.to, labelW: pillWidth(r.label) })), { direction: "LR" });

  scene.nodes = entities.map((e, at) => nodeOf(e, items[at].m, grid.boxes.get(e.id)!, repo, options, doc.states[at].step ?? ""));
  scene.edges = relations.flatMap((r) => edgeOf(r, routes.get(r.id)) ?? []);
  scene.frames = doc.lanes.map((lane, at) => ({
    id: `lane-${lane.id}`,
    kind: "lane" as FrameKind,
    label: lane.label,
    box: grid.lanes[at],
    depth: 0,
    style: "normal",
  }));
  return finish(scene);
}

// ---------------------------------------------------------------------------------------------
// Dataflow
// ---------------------------------------------------------------------------------------------

function buildDataflow(doc: ArchifyDataflow, options: SceneOptions): ArchifyScene {
  const scene = emptyScene(doc);
  const entities = archifyEntities(doc);
  const relations = archifyRelations(doc);
  const repo = doc.meta.repository;
  const sizes = entities.map((e) => measure(e));
  const labelW = (r: ArchifyRelation) => pillWidth(r.label, r.classification);

  const preset = new Map(doc.nodes.flatMap((n) => (n.stage !== undefined ? [[n.id, n.stage] as const] : [])));
  const { rank } = denseRanks(assignRanks(doc.nodes.map((n) => n.id), relations.map((r) => [r.from, r.to]), preset));
  // The stage labels the document wrote name the stages the nodes name; a stage index with no label
  // is called by its position.
  const stageOfNode = new Map(doc.nodes.map((n) => [n.id, n.stage !== undefined ? n.stage : rank.get(n.id)!]));
  const stageIds = [...new Set([...stageOfNode.values(), ...doc.stages.map((_, at) => at)])].sort((a, b) => a - b);
  const stageAt = new Map(stageIds.map((s, at) => [s, at]));

  // Rows: the document's, closed up; a node that gave none takes the next free row of its stage.
  const rowOf = new Map<string, number>();
  const taken = new Map<number, Set<number>>();
  const given = [...new Set(doc.nodes.flatMap((n) => (n.row !== undefined ? [n.row] : [])))].sort((a, b) => a - b);
  doc.nodes.forEach((n) => {
    if (n.row === undefined) return;
    const stage = stageAt.get(stageOfNode.get(n.id)!)!;
    let row = given.indexOf(n.row);
    while (taken.get(stage)?.has(row)) row++;
    taken.set(stage, (taken.get(stage) ?? new Set()).add(row));
    rowOf.set(n.id, row);
  });
  doc.nodes.forEach((n) => {
    if (rowOf.has(n.id)) return;
    const stage = stageAt.get(stageOfNode.get(n.id)!)!;
    let row = 0;
    while (taken.get(stage)?.has(row)) row++;
    taken.set(stage, (taken.get(stage) ?? new Set()).add(row));
    rowOf.set(n.id, row);
  });
  const rows = Math.max(1, ...[...rowOf.values()].map((r) => r + 1));

  const widths = stageIds.map((_, c) =>
    Math.max(150, ...doc.nodes.flatMap((n, at) => (stageAt.get(stageOfNode.get(n.id)!) === c ? [sizes[at].w] : []))),
  );
  const colX: [number, number][] = [];
  let cursor = 24;
  widths.forEach((w, c) => {
    colX.push([cursor, cursor + w]);
    const labelled = relations
      .filter((r) => stageAt.get(stageOfNode.get(r.from)!) === c && stageAt.get(stageOfNode.get(r.to)!) === c + 1)
      .reduce((widest, r) => Math.max(widest, labelW(r)), 0);
    cursor += w + Math.max(84, labelled + 44);
  });
  const rowH = Array.from({ length: rows }, (_, r) =>
    Math.max(0, ...doc.nodes.flatMap((n, at) => (rowOf.get(n.id) === r ? [sizes[at].h] : []))),
  );
  const headerH = 44;
  const rowTop: number[] = [];
  let y = headerH + 20;
  rowH.forEach((h, r) => {
    rowTop[r] = y;
    y += Math.max(h, 60) + 34;
  });

  const boxes = new Map<string, Box>();
  doc.nodes.forEach((n, at) => {
    const c = stageAt.get(stageOfNode.get(n.id)!)!;
    const r = rowOf.get(n.id)!;
    const m = sizes[at];
    boxes.set(n.id, [colX[c][0] + (widths[c] - m.w) / 2, rowTop[r] + (Math.max(rowH[r], 60) - m.h) / 2, m.w, m.h]);
  });
  const routes = routeAll(boxes, relations.map((r) => ({ id: r.id, from: r.from, to: r.to, labelW: labelW(r) })), { direction: "LR" });

  scene.nodes = entities.map((e, at) => nodeOf(e, sizes[at], boxes.get(e.id)!, repo, options));
  scene.edges = relations.flatMap((r) => edgeOf(r, routes.get(r.id)) ?? []);
  const bottom = y - 10;
  scene.frames = stageIds.map((stage, c) => ({
    id: `stage-${c}`,
    kind: "stage" as FrameKind,
    label: doc.stages[stage]?.label ?? `${c + 1}`,
    box: [colX[c][0] - 18, 0, widths[c] + 36, bottom] as Box,
    depth: 0,
    style: c % 2 ? "odd" : "even",
  }));
  return finish(scene);
}

// ---------------------------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------------------------

function buildSequence(doc: ArchifySequence, options: SceneOptions): ArchifyScene {
  const scene = emptyScene(doc);
  const entities = archifyEntities(doc);
  const relations = archifyRelations(doc);
  const repo = doc.meta.repository;
  const HEAD_H = 54;
  const widths = entities.map((e) => Math.max(124, Math.min(210, Math.ceil(textWidth(e.label, LABEL_FONT, true) + 34))));
  const index = new Map(entities.map((e, at) => [e.id, at]));

  // The distance between neighbouring lifelines: enough for the heads, then enough for every label
  // that has to fit between the two lifelines it connects.
  const gaps = entities.slice(1).map((_, at) => (widths[at] + widths[at + 1]) / 2 + 26);
  const spans = relations
    .map((r, at) => ({ at, a: index.get(r.from)!, b: index.get(r.to)!, need: pillWidth(r.label) + 48 }))
    .filter((s) => s.a !== s.b)
    .map((s) => ({ ...s, lo: Math.min(s.a, s.b), hi: Math.max(s.a, s.b) }))
    .sort((p, q) => p.hi - p.lo - (q.hi - q.lo));
  for (const span of spans) {
    const have = gaps.slice(span.lo, span.hi).reduce((s, g) => s + g, 0);
    if (have < span.need) for (let k = span.lo; k < span.hi; k++) gaps[k] += (span.need - have) / (span.hi - span.lo);
  }
  const centres: number[] = [widths[0] / 2 + 20];
  gaps.forEach((g, at) => centres.push(centres[at] + g));

  // Down the page: a fixed step, a little more for a note, a self-call's loop, or a band's title.
  const phaseStart = new Map<number, string>();
  doc.phases.forEach((p) => phaseStart.set(p.from, p.label));
  const ys: number[] = [];
  let cursor = HEAD_H + 46;
  relations.forEach((r, at) => {
    if (phaseStart.has(at)) cursor += 28;
    ys.push(cursor);
    cursor += 42 + (r.from === r.to ? 24 : 0);
  });
  const end = cursor + 10;

  scene.nodes = entities.map((e, at) => {
    const m: Measured = { w: widths[at], h: HEAD_H, lines: wrapToWidth(e.label, LABEL_FONT, widths[at] - 24, 1, true), sublabel: e.sublabel ? clipToWidth(e.sublabel, SUB_FONT, widths[at] - 20) : "", shape: "head", tagFit: false };
    const node = nodeOf(e, m, [centres[at] - widths[at] / 2, 0, widths[at], HEAD_H], repo, options);
    node.life = [centres[at], HEAD_H, end];
    return node;
  });

  const activations = activationsOf(doc);
  const levels: number[] = [];
  const open = new Map<string, number[]>();
  activations.forEach((a, at) => {
    const active = (open.get(a.participant) ?? []).filter((to) => to >= a.from);
    levels[at] = active.length;
    open.set(a.participant, [...active, a.to]);
  });
  /** How far right of its lifeline the innermost activation bar covering message `at` sits, or null. */
  const barOffset = (participant: string, at: number): number | null => {
    let level = -1;
    activations.forEach((a, k) => {
      if (a.participant === participant && a.from <= at && a.to >= at) level = Math.max(level, levels[k]);
    });
    return level < 0 ? null : level * 6;
  };
  /** Where an arrow meets a lifeline: at the edge of its bar, `toward` being the side it faces. */
  const meet = (i: number, at: number, toward: number): number => {
    const offset = barOffset(entities[i].id, at);
    return offset === null ? centres[i] : centres[i] + offset + toward * 5;
  };
  scene.activations = activations.map((a, at): SceneActivation => ({
    participant: a.participant,
    x: centres[index.get(a.participant)!] + levels[at] * 6,
    y1: ys[a.from] - 8,
    y2: ys[a.to] + 8,
  }));

  scene.messages = relations.map((r, at): SceneMessage => {
    const a = index.get(r.from)!;
    const b = index.get(r.to)!;
    const self = a === b;
    const w = pillWidth(r.label);
    const dir = b > a ? 1 : -1;
    const x1 = self ? meet(a, at, 1) : meet(a, at, dir);
    const x2 = self ? x1 : meet(b, at, -dir);
    const cx = self ? x1 + 34 + w / 2 : (x1 + x2) / 2;
    return {
      id: r.id,
      index: at,
      from: r.from,
      to: r.to,
      y: ys[at],
      x1,
      x2,
      label: r.label,
      style: r.style,
      note: r.note ?? "",
      self,
      at: [cx - w / 2, self ? ys[at] + 2 : ys[at] - 25, w, 20],
    };
  });
  scene.bands = doc.phases.map((p): SceneBand => ({ label: p.label, y1: ys[p.from] - 36, y2: ys[p.to] + 22 }));
  return finish(scene, [[0, 0, centres[centres.length - 1] + widths[widths.length - 1] / 2 + 20, end]]);
}

// ---------------------------------------------------------------------------------------------

export function buildScene(doc: ArchifyDocument, options: SceneOptions): ArchifyScene {
  switch (doc.diagram_type) {
    case "architecture":
      return buildArchitecture(doc, options);
    case "workflow":
      return buildWorkflow(doc, options);
    case "sequence":
      return buildSequence(doc, options);
    case "dataflow":
      return buildDataflow(doc, options);
    case "lifecycle":
      return buildLifecycle(doc, options);
  }
}
