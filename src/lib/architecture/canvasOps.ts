/**
 * What the canvas does to a document, as pure functions from one document to the next: move a card
 * or a zone (into another zone, or to the top level), resize a zone, drop a new component or zone at
 * a point, connect, and delete — each returning a new document and leaving the old one untouched.
 *
 * Membership is the `layout` tree, placement is `positions`: moving into another zone is taking the
 * node out of where it sits in the tree and appending it to the zone's children, then writing where
 * it was let go. Groups (`row`/`column`) left empty by a move are pruned, so a tree a model wrote
 * does not fill up with husks as the person rearranges it.
 */
import { isGroup, isZone, type ArchComponent, type ArchDoc, type Connection, type LayoutNode, type Position, type Zone, type ZoneStyle } from "./types";

const clone = <T,>(value: T): T => structuredClone(value);

/** The zone `id` sits in: a zone id, `null` at the top level, `undefined` when it is not in the layout. */
export function parentZoneOf(layout: LayoutNode[] | undefined, id: string): string | null | undefined {
  const walk = (nodes: LayoutNode[], parent: string | null): string | null | undefined => {
    for (const n of nodes) {
      if (n === id || (isZone(n) && n.id === id)) return parent;
      if (isZone(n)) { const r = walk(n.children, n.id); if (r !== undefined) return r; }
      else if (isGroup(n)) { const r = walk(n.row ?? n.column ?? [], parent); if (r !== undefined) return r; }
    }
    return undefined;
  };
  return walk(layout ?? [], null);
}

export function findZone(layout: LayoutNode[] | undefined, id: string): Zone | null {
  for (const n of layout ?? []) {
    if (isZone(n)) {
      if (n.id === id) return n;
      const inner = findZone(n.children, id);
      if (inner) return inner;
    } else if (isGroup(n)) {
      const inner = findZone(n.row ?? n.column, id);
      if (inner) return inner;
    }
  }
  return null;
}

/** Whether `id` is `ancestor` or anything inside it. */
export function isWithin(layout: LayoutNode[] | undefined, id: string, ancestor: string): boolean {
  if (id === ancestor) return true;
  const zone = findZone(layout, ancestor);
  if (!zone) return false;
  return parentZoneOf(zone.children, id) !== undefined;
}

/** `layout` without `id` (a component id, or a zone with everything in it), and what was taken out. */
function detach(nodes: LayoutNode[], id: string): { nodes: LayoutNode[]; taken: LayoutNode | null } {
  let taken: LayoutNode | null = null;
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (n === id || (isZone(n) && n.id === id)) { taken ??= n; continue; }
    if (isZone(n)) {
      const r = detach(n.children, id);
      taken ??= r.taken;
      out.push({ ...n, children: r.nodes });
    } else if (isGroup(n)) {
      const key = n.row ? "row" : "column";
      const r = detach(n[key] ?? [], id);
      taken ??= r.taken;
      if (r.nodes.length) out.push({ ...n, [key]: r.nodes });
    } else out.push(n);
  }
  return { nodes: out, taken };
}

function attach(nodes: LayoutNode[], node: LayoutNode, target: string | null): LayoutNode[] {
  if (target === null) return [...nodes, node];
  let done = false;
  const walk = (list: LayoutNode[]): LayoutNode[] =>
    list.map((n) => {
      if (done) return n;
      if (isZone(n)) {
        if (n.id === target) { done = true; return { ...n, children: [...n.children, node] }; }
        return { ...n, children: walk(n.children) };
      }
      if (isGroup(n)) { const key = n.row ? "row" : "column"; return { ...n, [key]: walk(n[key] ?? []) }; }
      return n;
    });
  const out = walk(nodes);
  return done ? out : [...nodes, node];
}

const round = (p: Position): Position => {
  const out: Position = { x: Math.round(p.x), y: Math.round(p.y) };
  if (p.w != null) out.w = Math.round(p.w);
  if (p.h != null) out.h = Math.round(p.h);
  return out;
};

/** Writes where `id` sits, keeping a zone's hand-set size unless a new one is given. */
export function setPosition(doc: ArchDoc, id: string, pos: Position): ArchDoc {
  const next = clone(doc);
  const old = next.positions?.[id];
  next.positions = { ...(next.positions ?? {}), [id]: round({ ...pos, w: pos.w ?? old?.w, h: pos.h ?? old?.h }) };
  return next;
}

/**
 * Moves `id` to `target` (a zone id, or `null` for the top level) and puts it at `pos` inside it.
 * A zone is never moved into itself or into anything it contains — that would cut it out of the tree.
 */
export function moveNode(doc: ArchDoc, id: string, target: string | null, pos: Position): ArchDoc {
  const layout = doc.layout ?? [];
  const current = parentZoneOf(layout, id);
  if (current === undefined) {
    // Not in the layout yet (a component the tree never named): it joins the target.
    const next = setPosition(doc, id, pos);
    next.layout = attach(next.layout ?? [], id, target);
    return next;
  }
  if (current === target || (target !== null && isWithin(layout, target, id))) return setPosition(doc, id, pos);
  const { nodes, taken } = detach(clone(layout), id);
  if (!taken) return setPosition(doc, id, pos);
  const next = setPosition(doc, id, pos);
  next.layout = attach(nodes, taken, target);
  return next;
}

/** Forgets the hand placements of `ids` (all of them when not given): «Ordenar». */
export function clearPositions(doc: ArchDoc, ids?: string[]): ArchDoc {
  const next = clone(doc);
  if (!ids) delete next.positions;
  else if (next.positions) {
    for (const id of ids) delete next.positions[id];
    if (!Object.keys(next.positions).length) delete next.positions;
  }
  return next;
}

/** A free id from a name: `bookings_api`, then `bookings_api_2`… — unique across components and zones. */
export function freeId(doc: ArchDoc, name: string): string {
  const base = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "component";
  const taken = (id: string) => !!doc.components?.[id] || !!findZone(doc.layout, id);
  let id = base, n = 2;
  while (taken(id)) id = `${base}_${n++}`;
  return id;
}

/** Adds a component at `pos` inside `target`. */
export function addComponentAt(doc: ArchDoc, component: ArchComponent, target: string | null, pos: Position): { doc: ArchDoc; id: string } {
  const id = freeId(doc, component.name ?? "component");
  const next = setPosition(doc, id, pos);
  next.components = { ...(next.components ?? {}), [id]: component };
  next.layout = attach(next.layout ?? [], id, target);
  return { doc: next, id };
}

/** Adds an empty zone at `pos` inside `target`. */
export function addZoneAt(doc: ArchDoc, zone: { title: string; style: ZoneStyle; icon?: string }, target: string | null, pos: Position): { doc: ArchDoc; id: string } {
  const id = freeId(doc, zone.title || zone.style);
  const next = setPosition(doc, id, pos);
  const node: Zone = { id, title: zone.title, style: zone.style, ...(zone.icon ? { icon: zone.icon } : {}), children: [] };
  next.layout = attach(next.layout ?? [], node, target);
  return { doc: next, id };
}

/** A copy of a component next to it, in the same zone. */
export function duplicateComponent(doc: ArchDoc, id: string, pos: Position, copyName: (name: string) => string): { doc: ArchDoc; id: string } | null {
  const c = doc.components?.[id];
  if (!c) return null;
  const parent = parentZoneOf(doc.layout, id) ?? null;
  return addComponentAt(doc, { ...clone(c), name: copyName(c.name ?? id), evidence: undefined }, parent, pos);
}

/** A connection, unless the same one already exists. Answers the new connection's index, or the existing one's. */
export function connect(doc: ArchDoc, connection: Connection): { doc: ArchDoc; index: number } {
  const conns = doc.connections ?? [];
  const same = conns.findIndex((e) => e.from === connection.from && e.to === connection.to);
  if (same >= 0 || connection.from === connection.to) return { doc, index: same };
  const next = clone(doc);
  next.connections = [...conns, connection];
  return { doc: next, index: next.connections.length - 1 };
}

export function reverseConnection(doc: ArchDoc, index: number): ArchDoc {
  const e = doc.connections?.[index];
  if (!e) return doc;
  const next = clone(doc);
  next.connections![index] = { ...e, from: e.to, to: e.from };
  return next;
}

export interface Removal {
  components?: string[];
  zones?: string[];
  connections?: number[];
  /**
   * Where the contents of each removed zone go, already relative to the zone they land in — the
   * canvas knows where everything is on screen. Without an entry a child keeps its own placement.
   */
  childPositions?: Record<string, Position>;
  /** A removed zone takes what is inside it with it, instead of handing it to its parent. */
  withContent?: boolean;
}

/**
 * Removes components, zones and connections, and everything that names what went: a component's
 * connections, its notes, its mention in a decision's or a risk's `affects`, its placement.
 */
export function removeElements(doc: ArchDoc, what: Removal): ArchDoc {
  let next = clone(doc);
  const gone = new Set(what.components ?? []);
  const zonesGone = new Set(what.zones ?? []);

  for (const zoneId of zonesGone) {
    const zone = findZone(next.layout, zoneId);
    if (!zone) continue;
    if (what.withContent) {
      const collect = (nodes: LayoutNode[]) => nodes.forEach((n) => {
        if (typeof n === "string") gone.add(n);
        else if (isZone(n)) { zonesGone.add(n.id); collect(n.children); }
        else if (isGroup(n)) collect(n.row ?? n.column ?? []);
      });
      collect(zone.children);
      next.layout = detach(next.layout ?? [], zoneId).nodes;
    } else {
      // Unwrapped: the zone's place in its parent is taken by what it contained.
      const parent = parentZoneOf(next.layout, zoneId) ?? null;
      const { nodes } = detach(next.layout ?? [], zoneId);
      next.layout = zone.children.reduce<LayoutNode[]>((acc, child) => attach(acc, child, parent), nodes);
      for (const [id, pos] of Object.entries(what.childPositions ?? {})) next = setPosition(next, id, pos);
    }
  }

  const drop = new Set(what.connections ?? []);
  (next.connections ?? []).forEach((e, i) => { if (gone.has(e.from) || gone.has(e.to)) drop.add(i); });
  if (next.connections) next.connections = next.connections.filter((_, i) => !drop.has(i));
  for (const id of gone) {
    if (next.components) delete next.components[id];
    next.layout = detach(next.layout ?? [], id).nodes;
  }
  const named = (id: string) => gone.has(id) || zonesGone.has(id);
  if (next.positions) for (const id of Object.keys(next.positions)) if (named(id)) delete next.positions[id];
  if (next.notes) next.notes = next.notes.filter((n) => !named(n.on));
  for (const list of [next.decisions, next.risks]) for (const d of list ?? []) if (d.affects) d.affects = d.affects.filter((id) => !gone.has(id));
  return next;
}
