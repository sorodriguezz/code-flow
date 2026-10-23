/**
 * Arquitectura's canvas: the document drawn as React Flow nodes — zones, cards, the header, note
 * chips — with the routed connections between them, and the component library beside it.
 *
 * Every gesture is an edit of the document, never of a canvas-only state: a drag writes where the
 * node was let go (and, dropped inside another zone, moves it there in the layout tree), a resize
 * writes the zone's size, a new line is a connection, Delete removes from the document. The scene is
 * then laid out and routed again from the document, so what is on screen is always what an export
 * would draw. The React Flow nodes keep only what a gesture in flight needs (a position mid-drag).
 *
 * Selection lives in `architectureViewStore`, shared with the lenses: the canvas reports what was
 * clicked and draws what is selected, so a finding chosen in Review lights up here and a card chosen
 * here opens the inspector.
 */
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type EdgeChange,
  type NodeChange,
  type OnNodeDrag,
} from "@xyflow/react";
import { AlertTriangle, Keyboard, LayoutGrid, Maximize2, Minus, MousePointerClick, Plus, Redo2, Undo2 } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { componentFor } from "../../../lib/architecture/catalog";
import { addComponentAt, addZoneAt, clearPositions, connect, duplicateComponent, moveNode, removeElements, reverseConnection, setPosition, type Removal } from "../../../lib/architecture/canvasOps";
import { CARD_W, ZONE_METRICS } from "../../../lib/architecture/layout";
import type { Severity } from "../../../lib/architecture/rules";
import { cardSvg, chipSvg, labelSvg, sceneDefs, zoneSvg, type ArchPalette } from "../../../lib/architecture/svg";
import type { ArchDoc, Position as Pos, ZoneStyle } from "../../../lib/architecture/types";
import { useArchitectureStore } from "../../../state/architectureStore";
import { useArchitectureViewStore, type Lens, type Selection } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { useThemeStore } from "../../../state/themeStore";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { ContextMenu, type MenuItem } from "../../common/ContextMenu";
import { Tooltip } from "../../common/Tooltip";
import { popoverClass } from "../../common/recipes";
import { mutate } from "../edits";
import type { ArchModel } from "../useArchModel";
import { EDGE_TYPES, type ArchEdgeT } from "./ArchEdge";
import { ArchLibrary } from "./ArchLibrary";
import { CanvasActionsContext, carryOver, useArchDragStore, type CanvasActions, type LibraryItem } from "./canvasState";
import { NODE_TYPES, type ArchNode, type CardData } from "./nodes";

interface Props {
  model: ArchModel;
  palette: ArchPalette;
  lens: Lens;
  documentKey: string;
}

const chipId = (id: string) => `art:chip:${id}`;
const edgeId = (index: number) => `e:${index}`;
const edgeIndex = (id: string) => (id.startsWith("e:") ? Number(id.slice(2)) : -1);
const ZONE_SIZE = { w: 380, h: 240 };
/**
 * The export's order, set by hand (`zIndexMode="manual"`): zones at their depth, then the lines, then
 * the cards, then the note chips. All positive on purpose — React Flow's own lifting put a line between
 * two top-level cards at a negative z, which WebKit stops painting after the first redraw.
 */
const EDGE_Z = 500;
const CARD_Z = 1000;
const PICKED_CARD_Z = 1010;
const CHIP_Z = 1100;
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, suggestion: 2, risk: 3 };

const fmtPct = (x: number) => `${Math.round(Math.min(x, 9.99) * 100)} %`;
const fmtRps = (x: number) => `${x >= 10 ? Math.round(x) : x.toFixed(1)} rps`;

/** What a selection lights up: the cards and connections involved. */
export function hotOf(selection: Selection | null, doc: ArchDoc): { cards: Set<string>; edges: Set<number>; focus: boolean } {
  const cards = new Set<string>(), edges = new Set<number>();
  const conns = doc.connections ?? [];
  if (!selection) return { cards, edges, focus: false };
  if (selection.kind === "card") {
    cards.add(selection.id);
    conns.forEach((e, i) => { if (e.from === selection.id || e.to === selection.id) { edges.add(i); cards.add(e.from); cards.add(e.to); } });
  } else if (selection.kind === "cards") {
    selection.ids.forEach((id) => cards.add(id));
    conns.forEach((e, i) => { if (cards.has(e.from) && cards.has(e.to)) edges.add(i); });
  } else if (selection.kind === "edge") {
    const e = conns[selection.index];
    if (e) { edges.add(selection.index); cards.add(e.from); cards.add(e.to); }
  } else if (selection.kind === "step") {
    conns.forEach((e, i) => { if (e.step === selection.step) { edges.add(i); cards.add(e.from); cards.add(e.to); } });
  }
  // A single zone selected is a frame to resize, not a focus.
  return { cards, edges, focus: cards.size > 0 || edges.size > 0 };
}

function selectedIds(selection: Selection | null): Set<string> {
  if (!selection) return new Set();
  if (selection.kind === "card" || selection.kind === "zone") return new Set([selection.id]);
  if (selection.kind === "cards") return new Set(selection.ids);
  return new Set();
}

const editable = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

export function ArchCanvasArea(props: Props) {
  return (
    <ReactFlowProvider key={props.documentKey}>
      <CanvasArea {...props} />
    </ReactFlowProvider>
  );
}

function CanvasArea({ model, palette, lens }: Props) {
  const t = useT();
  const rf = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const { scene, doc, comps, sim, findings } = model;
  const selection = useArchitectureViewStore((s) => s.selection);
  const hover = useArchitectureViewStore((s) => s.hover);
  const focus = useArchitectureViewStore((s) => s.focus);
  const select = useArchitectureViewStore((s) => s.select);
  const setLens = useArchitectureViewStore((s) => s.setLens);
  const setDiagramTab = useArchitectureViewStore((s) => s.setDiagramTab);
  const revealInspector = useArchitectureViewStore((s) => s.revealInspector);
  const canUndo = useArchitectureStore((s) => s.past.length > 0);
  const canRedo = useArchitectureStore((s) => s.future.length > 0);
  const resolved = useThemeStore((s) => s.resolved);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; heading?: string } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [warningsOpen, setWarningsOpen] = useState(false);
  // A line being drawn: every card shows its dots, so the far end is a target to aim at.
  const [connecting, setConnecting] = useState(false);
  // Below this width the library folds to its rail on its own, so the canvas keeps room to draw in.
  const area = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 720));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // The canvas just gained or lost the library's width: the drawing is fitted to what is left.
  const firstNarrow = useRef(true);
  useEffect(() => {
    if (firstNarrow.current) { firstNarrow.current = false; return; }
    const id = setTimeout(() => void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 200 }), 60);
    return () => clearTimeout(id);
  }, [narrow, rf]);

  // ---------- geometry ----------

  const parentOf = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const z of scene.zones) map.set(z.id, z.parent);
    for (const c of scene.cards) map.set(c.id, c.parent);
    return map;
  }, [scene]);
  const zoneIds = useMemo(() => new Set(scene.zones.map((z) => z.id)), [scene]);
  const depthOf = useMemo(() => new Map(scene.zones.map((z) => [z.id, z.depth])), [scene]);

  /** Everything inside `id` (a zone), at any depth. */
  const descendants = useCallback((id: string): string[] => {
    const out: string[] = [];
    for (const [child, parent] of parentOf) {
      let p = parent;
      while (p) { if (p === id) { out.push(child); break; } p = parentOf.get(p) ?? null; }
    }
    return out;
  }, [parentOf]);

  /** A node's box as it is now on the canvas (mid-drag included). */
  const liveBox = useCallback((id: string): [number, number, number, number] | null => {
    const n = rf.getInternalNode(id);
    if (!n) return null;
    return [n.internals.positionAbsolute.x, n.internals.positionAbsolute.y, n.measured.width ?? n.width ?? 0, n.measured.height ?? n.height ?? 0];
  }, [rf]);

  /** The innermost zone under a point, skipping `exclude` (a dragged zone and what it holds). */
  const zoneAt = useCallback((x: number, y: number, exclude: Set<string> = new Set()): string | null => {
    let best: { id: string; depth: number; area: number } | null = null;
    for (const z of scene.zones) {
      if (exclude.has(z.id)) continue;
      const b = liveBox(z.id) ?? z.box;
      if (x < b[0] || y < b[1] || x > b[0] + b[2] || y > b[1] + b[3]) continue;
      const depth = depthOf.get(z.id) ?? 0, area = b[2] * b[3];
      if (!best || depth > best.depth || (depth === best.depth && area < best.area)) best = { id: z.id, depth, area };
    }
    return best?.id ?? null;
  }, [scene, liveBox, depthOf]);

  /** `box`'s top-left relative to `zone`, kept clear of the zone's title band. */
  const relativeTo = useCallback((zone: string | null, x: number, y: number): Pos => {
    // On the board itself there is no edge: up and left of the origin are places like any other.
    if (!zone) return { x, y };
    const b = liveBox(zone) ?? scene.zones.find((z) => z.id === zone)!.box;
    const style = scene.zones.find((z) => z.id === zone)?.style ?? "cluster";
    return { x: Math.max(8, x - b[0]), y: Math.max(ZONE_METRICS[style].head + 6, y - b[1]) };
  }, [liveBox, scene]);

  // ---------- nodes ----------

  const built = useMemo<ArchNode[]>(() => {
    const boxOf = new Map(scene.zones.map((z) => [z.id, z.box]));
    const rel = (box: [number, number, number, number], parent: string | null) => {
      const pb = parent ? boxOf.get(parent) : null;
      return { x: box[0] - (pb?.[0] ?? 0), y: box[1] - (pb?.[1] ?? 0) };
    };
    const worst = new Map<string, Severity>();
    if (lens === "review") for (const f of findings) for (const id of f.affects) { const w = worst.get(id); if (!w || SEVERITY_RANK[f.severity] < SEVERITY_RANK[w]) worst.set(id, f.severity); }
    // The title block stays an export's: on screen the toolbar already names the document, and the
    // inspector holds its version, date and owner.
    const out: ArchNode[] = [];
    for (const z of scene.zones) {
      const [, , w, h] = z.box;
      out.push({
        id: z.id, type: "zone", position: rel(z.box, z.parent), parentId: z.parent ?? undefined, width: w, height: h,
        dragHandle: ".arch-zone-grip", zIndex: z.depth + 1, connectable: false, className: "arch-zone-node",
        data: { svg: zoneSvg({ ...z, box: [0, 0, w, h] }, palette), head: ZONE_METRICS[z.style].head, dim: false },
      });
    }
    for (const c of scene.cards) {
      const [, , w, h] = c.box;
      const comp = comps[c.id], m = sim.metrics[c.id];
      let badge: CardData["badge"] = null;
      if (lens === "simulate" && comp && m) {
        const approx = comp.sim?.estimated ? "≈ " : "";
        if (comp.category === "actor") badge = comp.sim?.rps ? { label: approx + fmtRps(m.load || (comp.sim.rps ?? 0)), tone: "n" } : null;
        else if (m.down) badge = { label: t("arch.sim.off"), tone: "down" };
        else if (m.load) badge = { label: approx + fmtPct(m.util) + (m.err > 0.001 ? ` · ${fmtPct(m.err)} ${t("arch.sim.errShort")}` : ""), tone: m.util >= 0.85 ? "bad" : m.util >= 0.6 ? "warn" : "ok" };
      }
      const evidence = comp?.evidence ?? [];
      out.push({
        id: c.id, type: "card", position: rel(c.box, c.parent), parentId: c.parent ?? undefined, width: w, height: h, zIndex: CARD_Z,
        data: {
          svg: cardSvg({ ...c, box: [0, 0, w, h] }, palette, t("arch.missing")), w, h, dim: false, hot: false, badge,
          severity: worst.get(c.id) ?? null, down: lens === "simulate" && !!m?.down,
          sourced: evidence.length > 0, sourcedLabel: evidence.slice(0, 3).join("\n"),
        },
      });
    }
    for (const chip of scene.chips) {
      out.push({ id: chipId(chip.id), type: "art", position: { x: chip.x, y: chip.y }, draggable: false, selectable: false, connectable: false, focusable: false, zIndex: CHIP_Z, data: { svg: chipSvg({ ...chip, x: 0, y: 0 }, palette), w: 40, h: 15 } });
    }
    return out;
    // `iconsReady`: a card drawn before its provider's pack landed holds a stand-in glyph until then.
  }, [scene, palette, lens, sim, comps, findings, t, model.iconsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const [nodes, setNodes] = useState<ArchNode[]>(built);
  // The new scene's nodes, keeping what React Flow measured and where a dragged card is now.
  useEffect(() => { setNodes((prev) => carryOver(built, prev)); }, [built]);

  // A drop moves lines onto the live elbow until the next scene routes them again.
  useEffect(() => {
    if (useArchDragStore.getState().settling) useArchDragStore.getState().clear();
  }, [scene]);

  // Selection and focus: flags on the nodes as they are, so a click never resets a drag in flight.
  const active = hover ?? selection;
  const hot = useMemo(() => hotOf(active, doc), [active, doc]);
  const picked = useMemo(() => selectedIds(selection), [selection]);
  const shown = useMemo(() => nodes.map((n) => {
    if (n.type === "card") {
      const dim = hot.focus && !hot.cards.has(n.id);
      const isHot = hot.cards.has(n.id);
      const selected = picked.has(n.id);
      if (n.data.dim === dim && n.data.hot === isHot && !!n.selected === selected) return n;
      // A picked card comes over its neighbours, as React Flow's own lifting did before the order was
      // set by hand.
      return { ...n, selected, zIndex: selected ? PICKED_CARD_Z : CARD_Z, data: { ...n.data, dim, hot: isHot } };
    }
    if (n.type === "zone") {
      const selected = picked.has(n.id);
      return !!n.selected === selected ? n : { ...n, selected };
    }
    return n;
  }), [nodes, hot, picked]);

  const edges = useMemo<ArchEdgeT[]>(() => {
    const maxRps = Math.max(1, ...Object.values(sim.edge));
    return scene.edges.map((e) => {
      const async = e.kind === "async";
      let width = 1.5, color = async ? palette.edgeAsync : palette.edge, marker: "sync" | "async" | "hot" | "down" = async ? "async" : "sync";
      let text = e.label;
      if (lens === "simulate") {
        const r = sim.edge[e.index] ?? 0;
        width = 1.1 + 3.4 * Math.sqrt(r / maxRps);
        text = r >= 0.05 ? fmtRps(r) : "";
        if (sim.metrics[e.to]?.down) { color = palette.danger; marker = "down"; }
      }
      if (hot.edges.has(e.index)) { color = palette.hot; width = Math.max(width, 2); marker = "hot"; }
      return {
        id: edgeId(e.index), source: e.from, target: e.to, type: "arch" as const,
        // Under the cards and above the zones, the export's order — see `EDGE_Z`.
        zIndex: EDGE_Z,
        selected: selection?.kind === "edge" && selection.index === e.index,
        data: { edge: e, label: labelSvg(e, palette, text), width, color, dashed: async, marker, dim: hot.focus && !hot.edges.has(e.index) },
      };
    });
  }, [scene, palette, lens, sim, hot, selection]);

  // ---------- selection from the canvas ----------

  const pending = useRef<{ nodes: Set<string>; edges: Set<number> } | null>(null);
  const flushSelection = useCallback(() => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    const ids = [...p.nodes].filter((id) => !id.startsWith("art:"));
    if (!ids.length) {
      select(p.edges.size ? { kind: "edge", index: [...p.edges].pop()! } : null);
      return;
    }
    if (ids.length === 1) {
      // Selected, not inspected: React Flow selects a card on the press that starts a drag too, and a
      // card only moved is not a card asked about — `onNodeClick` is what brings the inspector up.
      select(zoneIds.has(ids[0]) ? { kind: "zone", id: ids[0] } : { kind: "card", id: ids[0] });
      return;
    }
    const cards = ids.filter((id) => !zoneIds.has(id));
    select(cards.length ? { kind: "cards", ids: cards } : { kind: "zone", id: ids[ids.length - 1] });
  }, [select, zoneIds]);

  /** A click, which a drag never ends in (d3-drag swallows the click after a move): the inspector. */
  const onNodeClick = useCallback((_: ReactMouseEvent, node: ArchNode) => {
    if (node.type === "card") revealInspector();
  }, [revealInspector]);

  const startPending = useCallback(() => {
    if (pending.current) return pending.current;
    const sel = useArchitectureViewStore.getState().selection;
    pending.current = { nodes: selectedIds(sel), edges: new Set(sel?.kind === "edge" ? [sel.index] : []) };
    queueMicrotask(flushSelection);
    return pending.current;
  }, [flushSelection]);

  const onNodesChange = useCallback((changes: NodeChange<ArchNode>[]) => {
    const rest = changes.filter((c) => c.type !== "select" && c.type !== "remove");
    if (rest.length) setNodes((ns) => applyNodeChanges(rest, ns));
    const sel = changes.filter((c) => c.type === "select");
    if (sel.length) {
      const p = startPending();
      for (const c of sel) if (c.type === "select") (c.selected ? p.nodes.add(c.id) : p.nodes.delete(c.id));
    }
  }, [startPending]);

  const onEdgesChange = useCallback((changes: EdgeChange<ArchEdgeT>[]) => {
    const sel = changes.filter((c) => c.type === "select");
    if (!sel.length) return;
    const p = startPending();
    for (const c of sel) if (c.type === "select") { const i = edgeIndex(c.id); if (i < 0) continue; c.selected ? p.edges.add(i) : p.edges.delete(i); }
  }, [startPending]);

  // ---------- gestures ----------

  const onNodeDragStart: OnNodeDrag<ArchNode> = useCallback((_, __, dragged) => {
    const ids = new Set<string>();
    for (const n of dragged) { ids.add(n.id); if (zoneIds.has(n.id)) descendants(n.id).forEach((d) => ids.add(d)); }
    useArchDragStore.getState().setMoving(ids);
  }, [zoneIds, descendants]);

  /**
   * Where a dragged node was let go, as a box on the canvas. From the node React Flow hands the drop —
   * never from the canvas's own copy (`liveBox`), which in a controlled flow is a step behind until the
   * last move's update lands: a quick drag read from it saved where the card had been, and the card
   * jumped back there.
   */
  const droppedBox = useCallback((n: ArchNode): [number, number, number, number] | null => {
    const live = liveBox(n.id);
    const parent = n.parentId ? rf.getInternalNode(n.parentId)?.internals.positionAbsolute : { x: 0, y: 0 };
    if (!parent) return live;
    const w = n.measured?.width ?? n.width ?? live?.[2] ?? 0;
    const h = n.measured?.height ?? n.height ?? live?.[3] ?? 0;
    return [parent.x + n.position.x, parent.y + n.position.y, w, h];
  }, [liveBox, rf]);

  const onNodeDragStop: OnNodeDrag<ArchNode> = useCallback((_, __, dragged) => {
    const before = useArchitectureStore.getState().draft?.text;
    const moves: Array<{ id: string; target: string | null; pos: Pos }> = [];
    for (const n of dragged) {
      if (n.id.startsWith("art:")) continue;
      const box = droppedBox(n);
      if (!box) continue;
      const exclude = new Set([n.id, ...(zoneIds.has(n.id) ? descendants(n.id) : [])]);
      const target = zoneAt(box[0] + box[2] / 2, box[1] + Math.min(box[3] / 2, 40), exclude);
      moves.push({ id: n.id, target, pos: relativeTo(target, box[0], box[1]) });
    }
    if (moves.length) mutate((d) => moves.reduce((acc, m) => moveNode(acc, m.id, m.target, m.pos), d));
    if (useArchitectureStore.getState().draft?.text === before) useArchDragStore.getState().clear();
    else useArchDragStore.getState().settle();
  }, [droppedBox, zoneAt, relativeTo, zoneIds, descendants]);

  const onConnect = useCallback((c: { source: string | null; target: string | null }) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const index = mutate<number>((d) => { const r = connect(d, { from: c.source!, to: c.target! }); return { doc: r.doc, result: r.index }; });
    if (index != null && index >= 0) select({ kind: "edge", index });
  }, [select]);

  const isValidConnection = useCallback((c: { source: string | null; target: string | null }) =>
    !!c.source && !!c.target && c.source !== c.target && !!comps[c.source] && !!comps[c.target] && !zoneIds.has(c.source) && !zoneIds.has(c.target), [comps, zoneIds]);

  // ---------- the library's drops ----------

  const isOverCanvas = useCallback((x: number, y: number) => {
    const el = wrapper.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (x < r.left || y < r.top || x > r.right || y > r.bottom) return false;
    const under = document.elementFromPoint(x, y);
    return !!under && el.contains(under) && !!under.closest(".react-flow") && !under.closest(".react-flow__panel");
  }, []);

  const place = useCallback((item: LibraryItem, fx: number, fy: number) => {
    const zone = zoneAt(fx, fy);
    if (item.kind === "zone") {
      const pos = relativeTo(zone, fx - 40, fy - 20);
      const id = mutate<string>((d) => { const r = addZoneAt(d, { title: item.title, style: item.style as ZoneStyle, icon: item.icon }, zone, { ...pos, ...ZONE_SIZE }); return { doc: r.doc, result: r.id }; });
      if (id) select({ kind: "zone", id });
      return;
    }
    const pos = relativeTo(zone, fx - CARD_W / 2, fy - 30);
    const id = mutate<string>((d) => { const r = addComponentAt(d, componentFor(item.icon, item.name, item.category, item.type), zone, pos); return { doc: r.doc, result: r.id }; });
    if (id) select({ kind: "card", id });
  }, [zoneAt, relativeTo, select]);

  const actions = useMemo<CanvasActions>(() => ({
    resizeZone: (id, x, y, w, h) => { mutate((d) => setPosition(d, id, { x, y, w, h })); },
    isOverCanvas,
    dropAt: (item, cx, cy) => {
      if (!isOverCanvas(cx, cy)) return false;
      const p = rf.screenToFlowPosition({ x: cx, y: cy });
      place(item, p.x, p.y);
      return true;
    },
    addCentered: (item) => {
      const r = wrapper.current?.getBoundingClientRect();
      if (!r) return;
      const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      place(item, p.x, p.y);
    },
  }), [isOverCanvas, rf, place]);

  // ---------- deleting ----------

  const removal = useCallback((sel: Selection | null, withContent = false): Removal | null => {
    if (!sel) return null;
    if (sel.kind === "card") return { components: [sel.id] };
    if (sel.kind === "cards") return { components: sel.ids };
    if (sel.kind === "edge") return { connections: [sel.index] };
    if (sel.kind === "zone") {
      if (withContent) return { zones: [sel.id], withContent: true };
      // Its contents stay where they are on screen, now inside the zone's own parent.
      const parent = parentOf.get(sel.id) ?? null;
      const childPositions: Record<string, Pos> = {};
      for (const [child, p] of parentOf) {
        if (p !== sel.id) continue;
        const b = liveBox(child);
        if (b) childPositions[child] = relativeTo(parent, b[0], b[1]);
      }
      return { zones: [sel.id], childPositions };
    }
    return null;
  }, [parentOf, liveBox, relativeTo]);

  const remove = useCallback((sel: Selection | null, withContent = false) => {
    const what = removal(sel, withContent);
    if (!what) return;
    mutate((d) => removeElements(d, what));
    select(null);
  }, [removal, select]);

  const duplicate = useCallback((id: string) => {
    const b = liveBox(id);
    if (!b) return;
    const parent = parentOf.get(id) ?? null;
    const pos = relativeTo(parent, b[0] + 24, b[1] + 24);
    const copy = mutate<string>((d) => { const r = duplicateComponent(d, id, pos, (name) => t("arch.copyOf", { title: name })); return r ? { doc: r.doc, result: r.id } : d; });
    if (copy) select({ kind: "card", id: copy });
  }, [liveBox, parentOf, relativeTo, select, t]);

  const arrange = useCallback(() => {
    mutate((d) => clearPositions(d));
    setTimeout(() => void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 250 }), 120);
  }, [rf]);

  const configure = useCallback((sel: Selection) => {
    select(sel);
    setLens("diagram");
    setDiagramTab("inspector");
  }, [select, setLens, setDiagramTab]);

  // ---------- menus ----------

  const openNodeMenu = useCallback((event: React.MouseEvent, id: string) => {
    event.preventDefault();
    if (id.startsWith("art:")) return;
    if (zoneIds.has(id)) {
      select({ kind: "zone", id });
      setMenu({
        x: event.clientX, y: event.clientY,
        items: [
          { label: t("arch.canvas.configure"), onClick: () => configure({ kind: "zone", id }) },
          { label: t("arch.canvas.deleteZone"), danger: true, separated: true, onClick: () => remove({ kind: "zone", id }) },
          { label: t("arch.canvas.deleteZoneAll"), danger: true, onClick: () => remove({ kind: "zone", id }, true) },
        ],
      });
      return;
    }
    const sel = useArchitectureViewStore.getState().selection;
    const many = sel?.kind === "cards" && sel.ids.includes(id) ? sel : null;
    if (!many) select({ kind: "card", id });
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        ...(many ? [] : [
          { label: t("arch.canvas.configure"), onClick: () => configure({ kind: "card", id }) },
          { label: t("arch.duplicate"), onClick: () => duplicate(id) },
        ]),
        { label: many ? t("arch.canvas.deleteMany", { n: many.ids.length }) : t("arch.insp.remove"), danger: true, separated: !many, onClick: () => remove(many ?? { kind: "card", id }) },
      ],
    });
  }, [zoneIds, select, t, configure, remove, duplicate]);

  const openEdgeMenu = useCallback((event: React.MouseEvent, id: string) => {
    event.preventDefault();
    const index = edgeIndex(id);
    const e = (doc.connections ?? [])[index];
    if (!e) return;
    select({ kind: "edge", index });
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: t("arch.canvas.configure"), onClick: () => configure({ kind: "edge", index }) },
        { label: t("arch.canvas.reverse"), onClick: () => { mutate((d) => reverseConnection(d, index)); } },
        { label: e.kind === "async" ? t("arch.canvas.makeSync") : t("arch.canvas.makeAsync"), onClick: () => { mutate((d) => { const next = structuredClone(d); const c = next.connections![index]; if (e.kind === "async") delete c.kind; else c.kind = "async"; return next; }); } },
        { label: t("arch.insp.removeConnection"), danger: true, separated: true, onClick: () => remove({ kind: "edge", index }) },
      ],
    });
  }, [doc, select, t, configure, remove]);

  const openPaneMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const p = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const zoneKinds: Array<{ style: ZoneStyle; icon?: string }> = [{ style: "cloud", icon: "cloud" }, { style: "group", icon: "group" }, { style: "cluster", icon: "namespace" }, { style: "tier" }, { style: "logical" }, { style: "providers", icon: "globe" }];
    setMenu({
      x: event.clientX, y: event.clientY,
      items: [
        { label: t("arch.canvas.addZone"), onClick: () => {}, children: zoneKinds.map((z) => ({ label: t(`arch.zoneStyle.${z.style}`), onClick: () => place({ kind: "zone", style: z.style, icon: z.icon, title: t(`arch.zoneStyle.${z.style}`) }, p.x, p.y) })) },
        { label: t("arch.canvas.arrange"), separated: true, onClick: arrange },
        { label: t("arch.fit"), onClick: () => void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 250 }) },
      ],
    });
  }, [rf, t, place, arrange]);

  // ---------- keys, focus ----------

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (editable(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    const sel = useArchitectureViewStore.getState().selection;
    if (event.key === "Delete" || event.key === "Backspace") { if (sel) { event.preventDefault(); remove(sel); } return; }
    if (mod && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) useArchitectureStore.getState().redo(); else useArchitectureStore.getState().undo(); return; }
    if (mod && event.key.toLowerCase() === "y") { event.preventDefault(); useArchitectureStore.getState().redo(); return; }
    if (mod && event.key.toLowerCase() === "d" && sel?.kind === "card") { event.preventDefault(); duplicate(sel.id); return; }
    if (event.key === "Escape") select(null);
  };

  useEffect(() => {
    if (!focus) return;
    const id = setTimeout(() => void rf.fitView({ nodes: [{ id: focus.id }], padding: 0.9, maxZoom: 1.1, duration: 300 }), 40);
    return () => clearTimeout(id);
  }, [focus, rf]);

  const defs = useMemo(() => ({ __html: sceneDefs(scene, palette) }), [scene, palette, model.iconsReady]); // eslint-disable-line react-hooks/exhaustive-deps
  const vars = {
    "--arch-hot": palette.hot, "--arch-card": palette.card, "--arch-canvas": palette.canvas, "--arch-halo": palette.halo,
    "--arch-ink2": palette.ink2, "--arch-line": palette.lineStrong, background: palette.canvas,
  } as React.CSSProperties;

  return (
    <CanvasActionsContext.Provider value={actions}>
      <div ref={area} className="flex h-full min-h-0 min-w-0">
        <ArchLibrary narrow={narrow} />
        <div ref={wrapper} className={`arch-flow @container relative min-h-0 min-w-0 flex-1${connecting ? " is-connecting" : ""}`} style={vars} onKeyDown={onKeyDown} tabIndex={-1} data-tour="arch-canvas">
          <svg aria-hidden className="absolute h-0 w-0 overflow-hidden"><defs dangerouslySetInnerHTML={defs} /></svg>
          <ReactFlow<ArchNode, ArchEdgeT>
            nodes={shown}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onConnectStart={() => setConnecting(true)}
            onConnectEnd={() => setConnecting(false)}
            isValidConnection={isValidConnection}
            onNodeContextMenu={(event, node) => openNodeMenu(event, node.id)}
            onEdgeContextMenu={(event, edge) => openEdgeMenu(event, edge.id)}
            onPaneContextMenu={openPaneMenu}
            onPaneClick={() => { setMenu(null); select(null); }}
            onMove={(_, v) => setZoom(v.zoom)}
            connectionMode={ConnectionMode.Loose}
            zIndexMode="manual"
            colorMode={resolved === "dark" ? "dark" : "light"}
            deleteKeyCode={null}
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            snapToGrid
            snapGrid={[4, 4]}
            minZoom={0.1}
            maxZoom={2.5}
            fitView
            fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
            connectionRadius={28}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color={palette.lineStrong} />
            {/* One island for the canvas's own controls — layout, history, zoom — centred under it, so
                both bottom corners stay free for the drawing. */}
            <Panel position="bottom-center" className="!mb-3">
              <div className="relative flex items-center gap-0.5 rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
                <Tooltip label={t("arch.canvas.arrange")} description={t("arch.canvas.arrangeHint")}>
                  <button type="button" className={buttonClass({ size: "sm", variant: "ghost", className: "h-[26px] px-2" })} onClick={arrange}><LayoutGrid size={14} /><span className="@max-[560px]:hidden">{t("arch.canvas.arrange")}</span></button>
                </Tooltip>
                <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
                <Tooltip label={t("arch.canvas.undo")}><button type="button" disabled={!canUndo} className={iconButtonClass({ size: "sm" })} onClick={() => useArchitectureStore.getState().undo()} aria-label={t("arch.canvas.undo")}><Undo2 size={14} /></button></Tooltip>
                <Tooltip label={t("arch.canvas.redo")}><button type="button" disabled={!canRedo} className={iconButtonClass({ size: "sm" })} onClick={() => useArchitectureStore.getState().redo()} aria-label={t("arch.canvas.redo")}><Redo2 size={14} /></button></Tooltip>
                <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
                <Tooltip label={t("arch.zoomOut")}><button type="button" className={iconButtonClass({ size: "sm" })} onClick={() => void rf.zoomOut({ duration: 150 })} aria-label={t("arch.zoomOut")}><Minus size={14} /></button></Tooltip>
                <button type="button" className="h-[26px] w-12 rounded-md text-center text-[12px] tabular-nums @max-[440px]:hidden text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]" onClick={() => void rf.zoomTo(1, { duration: 200 })}>{Math.round(zoom * 100)} %</button>
                <Tooltip label={t("arch.zoomIn")}><button type="button" className={iconButtonClass({ size: "sm" })} onClick={() => void rf.zoomIn({ duration: 150 })} aria-label={t("arch.zoomIn")}><Plus size={14} /></button></Tooltip>
                <Tooltip label={t("arch.fit")}><button type="button" className={iconButtonClass({ size: "sm" })} onClick={() => void rf.fitView({ padding: 0.08, maxZoom: 1, duration: 250 })} aria-label={t("arch.fit")}><Maximize2 size={13} /></button></Tooltip>
                <span aria-hidden className="mx-1 h-4 w-px bg-[var(--cf-border)]" />
                {model.warnings.length ? (
                  <Tooltip label={t("arch.warnings", { n: model.warnings.length })}>
                    <button type="button" aria-pressed={warningsOpen} onClick={() => setWarningsOpen(!warningsOpen)} className="inline-flex h-[26px] items-center gap-1 rounded-md px-1.5 text-[12px] font-medium tabular-nums text-[var(--cf-warning)] hover:bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] aria-pressed:bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)]">
                      <AlertTriangle size={13} />{model.warnings.length}
                    </button>
                  </Tooltip>
                ) : null}
                <Tooltip label={t("arch.canvas.keysTitle")} description={t("arch.canvas.keys")}>
                  <span className={iconButtonClass({ size: "sm", className: "cursor-help @max-[400px]:hidden" })}><Keyboard size={14} /></span>
                </Tooltip>
                {warningsOpen && model.warnings.length ? (
                  <div className={`${popoverClass} absolute bottom-[calc(100%+8px)] left-1/2 z-30 grid w-[380px] max-w-[80vw] -translate-x-1/2 gap-0.5 p-1.5`}>
                    {model.warnings.map((w, i) => (
                      <div key={i} className="flex gap-2 rounded-md px-2 py-1 text-[12px] leading-[1.4] text-[var(--cf-text)]">
                        <AlertTriangle size={13} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
                        {t(`arch.warn.${w.code}` as TranslationKey, w.params)}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </Panel>
          </ReactFlow>
          {!scene.cards.length && !scene.zones.length ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="m-0 flex items-center gap-2 text-[12.5px] text-[var(--cf-text-faint)]"><MousePointerClick size={15} />{t("arch.canvas.empty")}</p>
            </div>
          ) : null}
        </div>
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} heading={menu.heading} onClose={() => setMenu(null)} /> : null}
    </CanvasActionsContext.Provider>
  );
}

