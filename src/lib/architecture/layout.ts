/**
 * Document → scene: every zone, card, line and label placed, with no DOM.
 *
 * The layout is a box model, the way a page lays out rows and columns: a card has a fixed width and
 * the height its text needs; a row is its children side by side, a column one under another; a zone
 * is a column or row with a header and padding around it. Zones inside a column stretch to the
 * column's width — nested containers that fill their parent are what make the reference drawings
 * read as one system — while cards keep their size. Nothing is measured from a rendered page, so
 * the canvas, the exported file and a test all get the same geometry.
 *
 * Hand placements (`doc.positions`) are applied over that box model: a placed card or zone sits
 * where it was put, relative to its zone, and everything inside a moved zone moves with it; a zone
 * then grows to hold whatever was dragged towards its edge. With no placements the drawing is the
 * automatic one, which is what «Ordenar» goes back to.
 *
 * Lines are routed by archify's orthogonal router (`routeAll`) with the cards as the only obstacles:
 * zones are crossed freely, as they are in a hand-drawn architecture diagram, and their titles are
 * only kept clear of the label pills.
 */
import { clipToWidth, textWidth, wrapToWidth } from "../diagrams/archify/text";
import { routeAll, type RouteRequest } from "../diagrams/archify/layout/route";
import type { Box, Pt } from "../diagrams/archify/scene";
import {
  isGroup,
  isZone,
  resourceFor,
  type ArchDoc,
  type Category,
  type ConnectionKind,
  type LayoutNode,
  type Position,
  type ResolvedComponents,
  type Zone,
  type ZoneStyle,
} from "./types";

export type { Box, Pt };

export const CARD_W = 228;
const CARD_PAD = { top: 11, right: 12, bottom: 11, left: 14 };
export const TILE = 44;
const TILE_GAP = 10;
export const TEXT_X = CARD_PAD.left + TILE + TILE_GAP;
const TEXT_W = CARD_W - TEXT_X - CARD_PAD.right;
export const FONT = { name: 13, type: 10.5, resource: 9, description: 10, shared: 9.5, pill: 9.5 } as const;
export const LINE = { name: 16, type: 14, resource: 12, description: 13, shared: 13 } as const;
const GROUP_GAP = 32;
const ROOT_GAP = 60;
export const BOARD_PAD = { top: 36, right: 44, bottom: 48, left: 44 };
export const PILL_H = 15;
const STEP_W = 18;

interface ZoneMetrics { head: number; pad: [number, number, number, number]; gap: number; radius: number }
export const ZONE_METRICS: Record<ZoneStyle, ZoneMetrics> = {
  cloud: { head: 46, pad: [22, 20, 20, 20], gap: 32, radius: 14 },
  group: { head: 40, pad: [22, 20, 22, 20], gap: 40, radius: 12 },
  cluster: { head: 30, pad: [20, 14, 14, 14], gap: 32, radius: 10 },
  tier: { head: 22, pad: [20, 12, 14, 12], gap: 32, radius: 8 },
  logical: { head: 24, pad: [20, 18, 18, 18], gap: 32, radius: 10 },
  providers: { head: 40, pad: [16, 14, 16, 14], gap: 32, radius: 12 },
};

const monoWidth = (s: string, size: number) => s.length * size * 0.6;
function clipMono(s: string, size: number, width: number): string {
  if (monoWidth(s, size) <= width) return s;
  const n = Math.max(1, Math.floor(width / (size * 0.6)) - 1);
  return s.slice(0, n) + "…";
}

export interface SceneCard {
  id: string;
  box: Box;
  name: string[];
  type?: string[];
  resource?: string;
  description: string[];
  icon?: string;
  badge?: string;
  category: Category;
  sharedFrom?: string;
  /** The id is in the layout but not in `components`. */
  missing?: boolean;
  /** The zone it sits in, or null at the top level. */
  parent: string | null;
}

export interface SceneZone {
  id: string;
  style: ZoneStyle;
  box: Box;
  title: string;
  subtitle?: string;
  icon?: string;
  depth: number;
  parent: string | null;
}

export interface SceneEdge {
  /** Index into `doc.connections`. */
  index: number;
  from: string;
  to: string;
  kind: ConnectionKind;
  step?: number;
  label: string;
  points: Pt[];
  /** The label's slot (step circle + pill), top-left box, or null when unlabelled. */
  at: Box | null;
}

export interface SceneChip { id: string; target: string; x: number; y: number }

export interface SceneHeader {
  title: string;
  description: string[];
  meta: Array<[string, string]>;
  box: Box;
}

export interface Scene {
  width: number;
  height: number;
  env: string;
  header: SceneHeader | null;
  zones: SceneZone[];
  cards: SceneCard[];
  edges: SceneEdge[];
  chips: SceneChip[];
  /** Zone headers, for whoever places more labels later. */
  titles: Box[];
}

export interface LayoutOptions {
  env: string;
  /** Labels for the header's metadata rows, already translated. */
  metaLabels: { version: string; date: string; environment: string; owner: string; author: string };
  /** What a connection's pill says; the protocol by default. */
  edgeLabel?: (index: number) => string;
}

type LBox =
  | { kind: "card"; card: SceneCard; w: number; h: number; offset: number }
  | { kind: "group"; dir: "row" | "column"; gap: number; align: "start" | "center"; offset: number; children: LBox[]; w: number; h: number }
  | { kind: "zone"; zone: Zone; style: ZoneStyle; dir: "row" | "column"; gap: number; align: "start" | "center"; offset: number; m: ZoneMetrics; minW: number; children: LBox[]; w: number; h: number; depth: number };

function buildCard(id: string, comps: ResolvedComponents, env: string): SceneCard {
  const c = comps[id];
  if (!c) return { id, box: [0, 0, CARD_W, 0], name: [clipToWidth(id, FONT.name, TEXT_W, true)], description: [], category: "external", missing: true, parent: null };
  const resource = c.resource != null ? clipMono(resourceFor(c.resource, env), FONT.resource, TEXT_W) : undefined;
  return {
    id,
    box: [0, 0, CARD_W, 0],
    name: wrapToWidth(c.name || id, FONT.name, TEXT_W, 2, true),
    type: c.type ? wrapToWidth(c.type, FONT.type, TEXT_W, 2) : undefined,
    resource: resource || undefined,
    description: c.description ? wrapToWidth(c.description, FONT.description, TEXT_W, 3) : [],
    icon: c.icon,
    badge: c.badge,
    category: c.category ?? "external",
    sharedFrom: c.sharedFrom,
    parent: null,
  };
}

export function cardHeight(card: SceneCard): number {
  let text = card.name.length * LINE.name;
  if (card.type) text += card.type.length * LINE.type;
  if (card.resource) text += LINE.resource;
  if (card.description.length) text += 2 + card.description.length * LINE.description;
  if (card.sharedFrom || card.missing) text += LINE.shared;
  return CARD_PAD.top + Math.max(TILE, text) + CARD_PAD.bottom;
}

function measure(node: LayoutNode, comps: ResolvedComponents, env: string, depth: number): LBox | null {
  if (typeof node === "string") {
    const card = buildCard(node, comps, env);
    const h = cardHeight(card);
    return { kind: "card", card, w: CARD_W, h, offset: 0 };
  }
  if (isZone(node)) {
    const style = node.style ?? "cluster";
    const m = ZONE_METRICS[style] ?? ZONE_METRICS.cluster;
    const dir = node.direction === "row" ? "row" : "column";
    const gap = node.gap ?? m.gap;
    const children = node.children.map((c) => measure(c, comps, env, depth + 1)).filter((x): x is LBox => !!x);
    const inner = stack(children, dir, gap);
    const titleW = (node.icon ? 28 : 0) + textWidth(resourceTitle(node, env), style === "cloud" ? 15 : 12.5, true) + (node.subtitle ? 10 + textWidth(node.subtitle, 10) : 0);
    const minW = Math.max(titleW + m.pad[1] + m.pad[3] + 8, 120);
    const w = Math.max(inner.w + m.pad[1] + m.pad[3], minW);
    const h = m.head + m.pad[0] + inner.h + m.pad[2];
    return { kind: "zone", zone: node, style, dir, gap, align: node.align ?? "start", offset: node.offset ?? 0, m, minW, children, w, h, depth };
  }
  if (isGroup(node)) {
    const dir = node.row ? "row" : "column";
    const gap = node.gap ?? GROUP_GAP;
    const children = (node.row ?? node.column ?? []).map((c) => measure(c, comps, env, depth)).filter((x): x is LBox => !!x);
    const inner = stack(children, dir, gap);
    return { kind: "group", dir, gap, align: node.align ?? "start", offset: node.offset ?? 0, children, w: inner.w, h: inner.h };
  }
  return null;
}

const resourceTitle = (z: Zone, env: string) => resourceFor(z.title ?? z.id, env);

/** The size of children stacked along `dir`, counting each child's offset across the axis. */
function stack(children: LBox[], dir: "row" | "column", gap: number): { w: number; h: number } {
  if (!children.length) return { w: 0, h: 0 };
  if (dir === "row") {
    const w = children.reduce((a, c) => a + c.w, 0) + gap * (children.length - 1);
    const h = Math.max(...children.map((c) => c.h + c.offset));
    return { w, h };
  }
  const w = Math.max(...children.map((c) => c.w + c.offset));
  const h = children.reduce((a, c) => a + c.h, 0) + gap * (children.length - 1);
  return { w, h };
}

/** Zones stretch across a column; once a zone's width changes, its own content stays put. */
function stretchInColumn(children: LBox[], width: number) {
  for (const c of children) if (c.kind === "zone" && c.w < width - c.offset) c.w = width - c.offset;
}

interface PlaceCtx {
  zones: SceneZone[];
  cards: SceneCard[];
  positions: Record<string, Position>;
  env: string;
}

/** Where `b`'s top-left ends up: its hand placement inside its zone, or its automatic place moved by
 *  however far its ancestors were moved. */
function finalOrigin(id: string, x: number, y: number, ctx: PlaceCtx, parent: { ox: number; oy: number }, shift: [number, number]): [number, number] {
  const p = ctx.positions[id];
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return [parent.ox + p.x, parent.oy + p.y];
  return [x + shift[0], y + shift[1]];
}

function place(b: LBox, x: number, y: number, ctx: PlaceCtx, parent: { id: string | null; ox: number; oy: number }, shift: [number, number]) {
  if (b.kind === "card") {
    const [fx, fy] = finalOrigin(b.card.id, x, y, ctx, parent, shift);
    b.card.box = [fx, fy, b.w, b.h];
    b.card.parent = parent.id;
    ctx.cards.push(b.card);
    return;
  }
  const isZ = b.kind === "zone";
  const pad = isZ ? b.m.pad : [0, 0, 0, 0];
  const head = isZ ? b.m.head : 0;
  let zone: SceneZone | null = null;
  let inner = { id: parent.id, ox: parent.ox, oy: parent.oy };
  let innerShift = shift;
  const firstCard = ctx.cards.length, firstZone = ctx.zones.length;
  if (isZ) {
    const [fx, fy] = finalOrigin(b.zone.id, x, y, ctx, parent, shift);
    const hand = ctx.positions[b.zone.id];
    zone = { id: b.zone.id, style: b.style, box: [fx, fy, hand?.w ?? b.w, hand?.h ?? b.h], title: resourceTitle(b.zone, ctx.env), subtitle: b.zone.subtitle, icon: b.zone.icon, depth: b.depth, parent: parent.id };
    ctx.zones.push(zone);
    inner = { id: b.zone.id, ox: fx, oy: fy };
    innerShift = [fx - x, fy - y];
  }
  const ix = x + pad[3], iy = y + head + pad[0];
  const iw = b.w - pad[1] - pad[3];
  const stacked = stack(b.children, b.dir, b.gap);
  if (b.dir === "column") {
    stretchInColumn(b.children, iw);
    let cy = iy;
    for (const c of b.children) {
      const cx = b.align === "center" ? ix + (iw - c.w) / 2 : ix + c.offset;
      place(c, cx, cy, ctx, inner, innerShift);
      cy += c.h + b.gap;
    }
  } else {
    let cx = b.align === "center" ? ix + (iw - stacked.w) / 2 : ix;
    for (const c of b.children) {
      const cy = b.align === "center" ? iy + (stacked.h - c.h) / 2 : iy + c.offset;
      place(c, cx, cy, ctx, inner, innerShift);
      cx += c.w + b.gap;
    }
  }
  // A zone holds what was dragged towards its edge: it grows right and down to keep its padding.
  if (zone) {
    const kids = [...ctx.cards.slice(firstCard), ...ctx.zones.slice(firstZone)].filter((k) => k.parent === zone!.id);
    for (const k of kids) {
      zone.box[2] = Math.max(zone.box[2], k.box[0] + k.box[2] - zone.box[0] + pad[1]);
      zone.box[3] = Math.max(zone.box[3], k.box[1] + k.box[3] - zone.box[1] + pad[2]);
    }
  }
}

function headerOf(doc: ArchDoc, opts: LayoutOptions): SceneHeader | null {
  const m = doc.meta ?? {};
  if (!m.title && !m.description) return null;
  const envName = m.environments ? `${m.environments[opts.env] ?? opts.env} (${opts.env})` : undefined;
  const meta: Array<[string, string]> = (
    [
      [opts.metaLabels.version, m.version],
      [opts.metaLabels.date, m.date],
      [opts.metaLabels.environment, envName],
      [opts.metaLabels.owner, m.owner],
      [opts.metaLabels.author, m.author],
    ] as Array<[string, string | undefined]>
  ).filter((r): r is [string, string] => !!r[1]);
  return { title: m.title || "", description: m.description ? wrapToWidth(m.description, 13, 860, 3) : [], meta, box: [0, 0, 0, 0] };
}

export function pillWidth(label: string, step?: number): number {
  const text = label ? Math.ceil(textWidth(label, FONT.pill)) + 12 : 0;
  return text + (step ? STEP_W : 0) + (label && step ? 2 : 0);
}

export function layoutDoc(doc: ArchDoc, comps: ResolvedComponents, opts: LayoutOptions): Scene {
  const env = opts.env;
  const root = { kind: "group" as const, dir: "row" as const, gap: ROOT_GAP, align: "start" as const, offset: 0, children: (doc.layout ?? []).map((n) => measure(n, comps, env, 0)).filter((x): x is LBox => !!x), w: 0, h: 0 };
  const rs = stack(root.children, "row", ROOT_GAP);
  root.w = rs.w;
  root.h = rs.h;
  const header = headerOf(doc, opts);
  let top = BOARD_PAD.top;
  if (header) {
    const metaW = header.meta.length ? Math.max(...header.meta.map(([k, v]) => textWidth(k, 10.5, true) + 18 + textWidth(v, 10.5))) + 30 : 0;
    const metaH = header.meta.length ? header.meta.length * 16.5 + 18 : 0;
    const textH = 30 + 15 + header.description.length * 18;
    const h = Math.max(textH, metaH);
    const w = Math.max(root.w, textWidth(header.title, 26, true) + metaW + 48);
    header.box = [BOARD_PAD.left, top, w, h];
    top += h + 22 + 28;
    (header as SceneHeader & { metaW?: number }).metaW = metaW;
  }
  const out: PlaceCtx = { zones: [], cards: [], positions: doc.positions ?? {}, env };
  place(root, BOARD_PAD.left, top, out, { id: null, ox: 0, oy: 0 }, [0, 0]);
  const right = Math.max(BOARD_PAD.left + root.w, ...out.cards.map((c) => c.box[0] + c.box[2]), ...out.zones.map((z) => z.box[0] + z.box[2]));
  const bottom = Math.max(top + root.h, ...out.cards.map((c) => c.box[1] + c.box[3]), ...out.zones.map((z) => z.box[1] + z.box[3]));
  const contentW = Math.max(right - BOARD_PAD.left, header ? header.box[2] : 0);
  if (header) header.box[2] = contentW;

  // Lines.
  const boxes = new Map<string, Box>(out.cards.map((c) => [c.id, c.box]));
  const titles: Box[] = out.zones.map((z) => {
    const titleW = (z.icon ? 28 : 0) + textWidth(z.title, z.style === "cloud" ? 15 : 12.5, true) + (z.subtitle ? 10 + textWidth(z.subtitle, 10) : 0);
    return [z.box[0], z.box[1], Math.min(z.box[2], titleW + 30), ZONE_METRICS[z.style].head] as Box;
  });
  const conns = doc.connections ?? [];
  const label = (i: number) => (opts.edgeLabel ? opts.edgeLabel(i) : conns[i].protocol || conns[i].label || "");
  const requests: RouteRequest[] = [];
  conns.forEach((e, i) => {
    if (!boxes.has(e.from) || !boxes.has(e.to) || e.from === e.to) return;
    requests.push({ id: String(i), from: e.from, to: e.to, labelW: pillWidth(label(i), e.step) });
  });
  // Zone titles are walls for lines as well as for labels; the outermost zone's band is left open,
  // since everything enters through it anyway. Cards in a column sit 32px apart for the same reason:
  // a line entering a card from above needs its stub (18) clear of the card over it (margin 9).
  const walls: Box[] = out.zones.filter((z) => z.depth > 0).map((z) => {
    const size = z.style === "tier" ? 9.5 : z.style === "logical" ? 10.5 : 12.5;
    const textW = (z.icon && z.style !== "tier" && z.style !== "logical" ? 28 : 0) + textWidth(z.style === "tier" ? z.title.toUpperCase() : z.title, size, true) + (z.subtitle ? 10 + textWidth(z.subtitle, 10) : 0);
    const band: Record<ZoneStyle, [number, number]> = { cloud: [10, 26], group: [9, 22], providers: [9, 22], cluster: [8, 20], tier: [9, 12], logical: [9, 13] };
    const [dy, h] = band[z.style];
    return [z.box[0] + 8, z.box[1] + dy, Math.min(z.box[2] - 16, textW + 14), h] as Box;
  });
  const routed = requests.length ? routeAll(boxes, requests, { direction: "TB", labelH: PILL_H, avoid: titles, obstacles: walls, lateral: true }) : new Map();
  const edges: SceneEdge[] = [];
  for (const r of requests) {
    const got = routed.get(r.id);
    if (!got) continue;
    const i = Number(r.id), e = conns[i];
    edges.push({ index: i, from: e.from, to: e.to, kind: e.kind === "async" ? "async" : "sync", step: e.step, label: label(i), points: got.points, at: got.at });
  }

  // Note chips on the top-right corner of what they annotate.
  const chips: SceneChip[] = [];
  for (const n of doc.notes ?? []) {
    const card = out.cards.find((c) => c.id === n.on);
    const zone = card ? null : out.zones.find((z) => z.id === n.on);
    const b = card?.box ?? zone?.box;
    if (!b) continue;
    const w = textWidth(n.id, 9.5, true) + 10;
    chips.push({ id: n.id, target: n.on, x: b[0] + b[2] - w - 10, y: card ? b[1] - 8 : b[1] + 8 });
  }

  const width = BOARD_PAD.left + contentW + BOARD_PAD.right;
  const height = bottom + BOARD_PAD.bottom;
  return { width, height, env, header, zones: out.zones, cards: out.cards, edges, chips, titles };
}
