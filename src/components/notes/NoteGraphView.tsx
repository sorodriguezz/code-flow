import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LoaderCircle, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { layoutGroups } from "../../lib/notes/graphLayout";
import { bounds, createSimulation, isSettled, nodeAt, reheat, step, type SimLink, type SimNode, type Simulation } from "../../lib/notes/graphSim";
import { notesGraph } from "../../lib/tauri/notesCommands";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";
import { iconButtonClass } from "../common/Button";

/**
 * The notes as a graph, drawn on a canvas: one dot per note, a line per `[[link]]` between two of
 * them, held in shape by a live force simulation (`graphSim`) seeded from the deterministic layout
 * (`graphLayout`). A dot's size is how connected it is; a note nothing links sits small and grey on
 * the outside — the ones a vault forgets. Hovering lifts a note and everything it touches out of
 * the rest, dragging one pushes its neighbours around, and clicking opens it.
 *
 * **Each book is an island in its own colour** — its top-level book, so a book's sub-books stay
 * with it: laid out apart (`layoutGroups`) and pulled towards its own centre, painted in the book's
 * colour or, without one, a colour of a fixed set, with a legend once there are two. Labels never
 * pile up: the better-linked note keeps its name where two would overlap, and the other shows once
 * the zoom makes room.
 *
 * # Why a canvas and not React Flow
 *
 * This view used to be a React Flow graph of one HTML node per note. React Flow is built for
 * editable diagrams — a DOM element per node, measured, with handles, selection and a nodes-change
 * pipeline — and a vault's graph is none of those things: it is a thousand circles that move every
 * frame and are never edited. On Windows that difference showed up as the view simply not drawing:
 * nodes whose size is measured after mount, in a pane that gets its height from a flex parent, with
 * `fitView` running against the measurements, is a sequence with a lot of ways to end up framing
 * nothing. A canvas has no measurement step and no per-node DOM. It also buys what the old view
 * could not do at all — hover highlighting, dragging, labels that appear as you zoom in.
 *
 * `visibleIds` is the gallery's current filter (a book, a tag, a search): the graph stays whole, so
 * the links leaving the filter still show, and what is outside it is drawn faint.
 */
export function NoteGraphView({ visibleIds }: { visibleIds: Set<string> }) {
  const workspaceId = useNotesStore((s) => s.workspaceId);
  const openNote = useNotesStore((s) => s.openNote);
  const noteCount = useNotesStore((s) => s.notes.length);
  const [graph, setGraph] = useState<Awaited<ReturnType<typeof notesGraph>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void notesGraph(workspaceId)
      .then((found) => live && setGraph(found))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
    // Re-read when notes come and go; edits to links show on the next visit.
  }, [workspaceId, noteCount]);

  if (error) return <p className="p-4 text-[12.5px] text-[var(--cf-danger)]">{error}</p>;
  if (!graph) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle size={16} className="animate-spin text-[var(--cf-text-muted)]" />
      </div>
    );
  }
  return <Loaded graph={graph} visibleIds={visibleIds} onOpen={(id) => void openNote(id)} />;
}

/** The titles, memoised apart from the canvas: `visibleIds` changes with every keystroke in the
 *  gallery's search box, and a fresh array of notes on each of those would rebuild the simulation
 *  and throw the graph's positions away mid-type. */
function Loaded({
  graph,
  visibleIds,
  onOpen,
}: {
  graph: Awaited<ReturnType<typeof notesGraph>>;
  visibleIds: Set<string>;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const books = useNotesStore((s) => s.books);
  const { notes, groups } = useMemo(() => {
    const byId = new Map(books.map((book) => [book.id, book]));
    /** A book's top-level book — a guard against a cycle the database should never hold. */
    const rootOf = (id: string) => {
      let book = byId.get(id);
      for (let hops = 0; book?.parent_id && byId.has(book.parent_id) && hops < 64; hops++) book = byId.get(book.parent_id);
      return book?.id ?? id;
    };
    const notes = graph.nodes.map((note) => ({ id: note.id, title: note.title || t("notes.untitled"), group: rootOf(note.book_id) }));
    const counts = new Map<string, number>();
    for (const note of notes) counts.set(note.group, (counts.get(note.group) ?? 0) + 1);
    // The shelf's own order, so a book keeps its colour as notes come and go; then anything else.
    const order = [
      ...books.filter((book) => !book.parent_id && counts.has(book.id)).map((book) => book.id),
      ...[...counts.keys()].filter((id) => !byId.get(id) || byId.get(id)?.parent_id),
    ];
    const groups: GraphGroup[] = order.map((id, at) => ({
      id,
      name: byId.get(id)?.name ?? "—",
      color: byId.get(id)?.color || (order.length > 1 ? GROUP_COLORS[at % GROUP_COLORS.length] : ""),
      count: counts.get(id) ?? 0,
    }));
    return { notes, groups };
  }, [graph, books, t]);
  return <GraphCanvas nodes={notes} groups={groups} edges={graph.edges} visibleIds={visibleIds} onOpen={onOpen} />;
}

/** A book as the graph paints it. `color` is the book's own, a colour of [`GROUP_COLORS`] when it
 *  has none, or empty for the accent — a vault of one book. */
interface GraphGroup {
  id: string;
  name: string;
  color: string;
  count: number;
}

/** For books without a colour of their own: mid-tones that hold up on the dark themes and the
 *  light ones, far enough apart in hue to tell neighbours apart. */
const GROUP_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#fb923c", "#a3e635", "#e879f9"];

/** The palette, read once from the document rather than written here: the app has fourteen themes
 *  and a user-chosen accent, and every one of them is already a CSS variable. */
interface Palette {
  background: string;
  line: string;
  accent: string;
  faint: string;
  text: string;
  textMuted: string;
  /** Each book's colour, resolved — empty for the accent. */
  groups: Map<string, string>;
}

/**
 * CSS variables as colours a canvas can use.
 *
 * `getComputedStyle(el).getPropertyValue("--cf-text-faint")` hands back the *token*, and most of
 * this app's are `color-mix(…)` over other tokens — which `fillStyle` does not understand and
 * silently ignores, leaving whatever colour was set before. Reading it through a probe element's
 * `color` makes the browser resolve the whole chain to an `rgb()` first.
 */
function readPalette(host: HTMLElement, groups: GraphGroup[]): Palette {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  host.appendChild(probe);
  const resolve = (variable: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${variable})`;
    const value = getComputedStyle(probe).color;
    return value || fallback;
  };
  const palette = {
    background: resolve("--cf-sunken", "#101014"),
    line: resolve("--cf-border", "#2a2a33"),
    accent: resolve("--cf-accent", "#818cf8"),
    faint: resolve("--cf-text-faint", "#6b6b78"),
    text: resolve("--cf-text", "#e6e6ec"),
    textMuted: resolve("--cf-text-muted", "#9a9aa8"),
    groups: new Map<string, string>(),
  };
  for (const group of groups) {
    if (!group.color) continue;
    probe.style.color = palette.accent;
    probe.style.color = group.color;
    palette.groups.set(group.id, getComputedStyle(probe).color || palette.accent);
  }
  probe.remove();
  return palette;
}

/** `rgb(r g b)` with an alpha — the one thing the resolved colours do not carry. */
function fade(color: string, alpha: number): string {
  const channels = color.match(/[\d.]+/g);
  if (!channels || channels.length < 3) return color;
  const [r, g, b] = channels;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** How big a note's dot is. Square-rooted so a hub with forty links is bigger than one with four
 *  without being twenty times the size of it. */
const radiusOf = (node: SimNode) => 3.4 + Math.sqrt(node.degree) * 2.3;

/** The smallest a dot is drawn on screen, in CSS pixels: zoomed out over a big vault a dot in graph
 *  units would shrink to nothing and leave only the lines. */
const MIN_DOT = 2.5;

/** A dot's radius as drawn — and as hit — at `scale`, in graph units. */
const drawnRadius = (node: SimNode, scale: number) => Math.max(radiusOf(node), MIN_DOT / scale);

/** The chrome of the zoom controls, which float over the canvas and need an edge of their own. */
const CONTROL = iconButtonClass({
  size: "xs",
  className: "border border-[var(--cf-border)] bg-[var(--cf-surface)]/85 backdrop-blur-sm",
});

/** Below this zoom only the highlighted labels are drawn. Low, because labels never overlap (see
 *  the label pass): zoomed out, the best-linked notes keep their names and name the picture. */
const LABEL_ZOOM = 0.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;

function GraphCanvas({
  nodes: notes,
  groups,
  edges,
  visibleIds,
  onOpen,
}: {
  nodes: { id: string; title: string; group: string }[];
  groups: GraphGroup[];
  edges: [string, string][];
  visibleIds: Set<string>;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /** The simulation, the camera and what the pointer is doing: all of it changes per frame, so
   *  none of it is React state — a re-render per frame would be the whole cost of the view. */
  const simRef = useRef<Simulation | null>(null);
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<SimNode | null>(null);
  const neighboursRef = useRef<Set<string>>(new Set());
  const paletteRef = useRef<Palette | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const visibleRef = useRef(visibleIds);
  const groupsRef = useRef(groups);
  /** Node indices, best-linked first: the order labels claim their room in. */
  const labelOrderRef = useRef<number[]>([]);
  /** Label widths at 11px, by text — measured once rather than every frame. */
  const widthsRef = useRef(new Map<string, number>());
  const frameRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);

  visibleRef.current = visibleIds;
  groupsRef.current = groups;

  /** Who links to whom, by id — what a hover lights up. Both directions: a backlink is as much a
   *  neighbour as a link out. */
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [from, to] of edges) {
      if (!map.has(from)) map.set(from, new Set());
      if (!map.has(to)) map.set(to, new Set());
      map.get(from)?.add(to);
      map.get(to)?.add(from);
    }
    return map;
  }, [edges]);

  const titles = useMemo(() => new Map(notes.map((note) => [note.id, note.title])), [notes]);
  const groupOf = useMemo(() => new Map(notes.map((note) => [note.id, note.group])), [notes]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    const palette = paletteRef.current;
    if (!canvas || !sim || !palette) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const { width, height } = sizeRef.current;
    const ratio = window.devicePixelRatio || 1;
    const camera = cameraRef.current;
    const hovered = hoverRef.current;
    const neighbours = neighboursRef.current;
    const filtered = visibleRef.current;

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = palette.background;
    context.fillRect(0, 0, width, height);
    context.translate(width / 2, height / 2);
    context.scale(camera.scale, camera.scale);
    context.translate(-camera.x, -camera.y);

    const inView = (id: string) => filtered.size === 0 || filtered.has(id);
    const lit = (id: string) => !hovered || hovered.id === id || neighbours.has(id);

    context.lineWidth = 1 / camera.scale;
    for (const link of sim.links) {
      const a = sim.nodes[link.source];
      const b = sim.nodes[link.target];
      const touched = hovered ? hovered.id === a.id || hovered.id === b.id : false;
      const shown = inView(a.id) || inView(b.id);
      context.strokeStyle = touched
        ? fade(palette.accent, 0.9)
        : fade(palette.line, shown ? (hovered ? 0.25 : 0.65) : 0.12);
      context.lineWidth = (touched ? 1.6 : 1) / camera.scale;
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }

    const labels = camera.scale >= LABEL_ZOOM;
    const colorOf = (node: SimNode) => palette.groups.get(groupOf.get(node.id) ?? "") ?? palette.accent;
    const alphaOf = (node: SimNode) => {
      const highlighted = lit(node.id);
      return inView(node.id) ? (highlighted ? 1 : 0.22) : highlighted ? 0.3 : 0.12;
    };
    for (const node of sim.nodes) {
      const radius = drawnRadius(node, camera.scale);
      const color = colorOf(node);
      context.globalAlpha = alphaOf(node);
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      // A note nothing links is its book's colour, faded — still the ones a vault forgets.
      context.fillStyle = node.degree > 0 ? color : fade(color, 0.45);
      context.fill();
      // The dot sits on the lines it owns; a rim in the background colour cuts them off at its edge
      // instead of letting them run visibly underneath it.
      context.lineWidth = 1.5 / camera.scale;
      context.strokeStyle = palette.background;
      context.stroke();
      if (hovered?.id === node.id) {
        context.beginPath();
        context.arc(node.x, node.y, radius + 3.5 / camera.scale, 0, Math.PI * 2);
        context.strokeStyle = fade(color, 0.8);
        context.lineWidth = 1.5 / camera.scale;
        context.stroke();
      }
    }

    // Labels after every dot, so none is covered by one, and best-linked first: where two would
    // overlap the first keeps its room and the other waits for a closer zoom. The hovered note's
    // goes first of all. Boxes are kept in a grid of cells, so each label checks its neighbours only.
    if (labels || hovered) {
      const fontFamily = getComputedStyle(canvas).fontFamily;
      const drawFont = `${11 / camera.scale}px ${fontFamily}`;
      context.font = drawFont;
      context.textAlign = "center";
      context.textBaseline = "top";
      const cell = 160 / camera.scale;
      const placed = new Map<string, { x0: number; y0: number; x1: number; y1: number }[]>();
      const cellsOf = (box: { x0: number; y0: number; x1: number; y1: number }) => {
        const keys: string[] = [];
        for (let cx = Math.floor(box.x0 / cell); cx <= Math.floor(box.x1 / cell); cx++) {
          for (let cy = Math.floor(box.y0 / cell); cy <= Math.floor(box.y1 / cell); cy++) keys.push(`${cx},${cy}`);
        }
        return keys;
      };
      const order = hovered ? [sim.nodes.indexOf(hovered), ...labelOrderRef.current] : labelOrderRef.current;
      const done = new Set<number>();
      for (const at of order) {
        if (at < 0 || done.has(at)) continue;
        done.add(at);
        const node = sim.nodes[at];
        const highlighted = lit(node.id);
        if (!labels && !highlighted) continue;
        const title = titles.get(node.id) ?? "";
        const label = title.length > 28 ? `${title.slice(0, 27)}…` : title;
        let width = widthsRef.current.get(label);
        if (width === undefined) {
          context.font = `11px ${fontFamily}`;
          width = context.measureText(label).width;
          widthsRef.current.set(label, width);
          context.font = drawFont;
        }
        const half = (width / 2 + 3) / camera.scale;
        const top = node.y + drawnRadius(node, camera.scale) + 3 / camera.scale;
        const box = { x0: node.x - half, y0: top, x1: node.x + half, y1: top + 14 / camera.scale };
        const keys = cellsOf(box);
        const taken = keys.some((key) =>
          placed.get(key)?.some((other) => box.x0 < other.x1 && box.x1 > other.x0 && box.y0 < other.y1 && box.y1 > other.y0),
        );
        if (taken && hovered?.id !== node.id) continue;
        for (const key of keys) {
          const list = placed.get(key);
          if (list) list.push(box);
          else placed.set(key, [box]);
        }
        context.globalAlpha = alphaOf(node);
        context.fillStyle = hovered?.id === node.id ? palette.text : palette.textMuted;
        context.fillText(label, node.x, top);
      }
    }
    context.globalAlpha = 1;
  }, [titles, groupOf]);

  /** The camera framing the whole graph — what "fit" does, and what the view does by itself while
   *  a new graph is still spreading out (`followRef`). */
  const frameAll = useCallback(() => {
    const sim = simRef.current;
    const { width, height } = sizeRef.current;
    if (!sim || sim.nodes.length === 0 || width === 0) return false;
    // Room for the labels that hang off the outermost dots, not only for the dots.
    const box = bounds(sim.nodes, 220);
    const scale = Math.min(width / (box.maxX - box.minX), height / (box.maxY - box.minY));
    cameraRef.current = {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      scale: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale)),
    };
    return true;
  }, []);

  /** Keep framing the graph while it settles — it opens compact and spreads out over its first
   *  seconds — until the user takes the camera: a zoom, a pan, a drag. */
  const followRef = useRef(true);

  /** Runs the loop until the graph is asleep and nothing is waiting to be redrawn. Interactions
   *  call it rather than keeping a frame request alive the whole time the view is open. */
  const wake = useCallback(() => {
    if (frameRef.current !== null) return;
    const tick = () => {
      frameRef.current = null;
      const sim = simRef.current;
      if (!sim) return;
      const moving = !isSettled(sim);
      if (moving) step(sim);
      if (moving && followRef.current) frameAll();
      if (moving || dirtyRef.current) {
        dirtyRef.current = false;
        draw();
      }
      if (moving || dirtyRef.current) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [draw, frameAll]);

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
    wake();
  }, [wake]);

  /** Whether the current graph has been framed yet — see the resize effect. */
  const fittedRef = useRef(false);

  const fit = useCallback(() => {
    if (!frameAll()) return;
    fittedRef.current = true;
    invalidate();
  }, [frameAll, invalidate]);

  // The simulation, rebuilt when the graph itself changes — not when the filter does, which only
  // changes how it is painted.
  useEffect(() => {
    const index = new Map(notes.map((note, at) => [note.id, at]));
    const degree = new Map<string, number>();
    const links: SimLink[] = [];
    for (const [from, to] of edges) {
      const source = index.get(from);
      const target = index.get(to);
      if (source === undefined || target === undefined || source === target) continue;
      links.push({ source, target });
      degree.set(from, (degree.get(from) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
    const group = new Map(notes.map((note) => [note.id, note.group]));
    const { points, anchors } = layoutGroups(
      notes.map((note) => note.id),
      edges,
      (id) => group.get(id) ?? "",
    );
    const sim = createSimulation(
      notes.map((note) => {
        const anchor = anchors.get(note.group) ?? { x: 0, y: 0 };
        return {
          id: note.id,
          ...(points.get(note.id) ?? anchor),
          degree: degree.get(note.id) ?? 0,
          ax: anchor.x,
          ay: anchor.y,
        };
      }),
      links,
    );
    simRef.current = sim;
    labelOrderRef.current = sim.nodes.map((_, at) => at).sort((a, b) => sim.nodes[b].degree - sim.nodes[a].degree);
    hoverRef.current = null;
    neighboursRef.current = new Set();
    // Framed by the pane, which has no size yet on the first pass — effects run before the browser
    // has laid the canvas out. The resize below does it as soon as there is a box to frame into.
    fittedRef.current = false;
    followRef.current = true;
    fit();
  }, [notes, edges, fit]);

  // The canvas follows the pane, in device pixels: a backing store sized in CSS pixels is the
  // blurry-canvas bug, and on Windows the ratio is whatever the display scaling is set to.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    paletteRef.current = readPalette(host, groupsRef.current);
    const resize = () => {
      const rect = host.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height };
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      if (!fittedRef.current) fit();
      else invalidate();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [fit, invalidate]);

  // A theme switch or a new accent repaints the graph. The colours are resolved once and cached —
  // a `getComputedStyle` per frame would be a layout read sixty times a second.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const reread = () => {
      paletteRef.current = readPalette(host, groupsRef.current);
      invalidate();
    };
    // A book recoloured, added or emptied: its dots change colour without a relayout.
    reread();
    const observer = new MutationObserver(reread);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => observer.disconnect();
  }, [invalidate, groups]);

  // Once the view is left there is nothing to draw on.
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  /** A pointer position in graph coordinates. */
  const toGraph = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - rect.width / 2) / camera.scale + camera.x,
      y: (event.clientY - rect.top - rect.height / 2) / camera.scale + camera.y,
    };
  };

  /** What the pointer took hold of on press: a note (drag it) or the background (pan). `moved`
   *  is what tells a click apart from a drag that happens to end where a note is. */
  const dragRef = useRef<{ node: SimNode | null; x: number; y: number; moved: boolean } | null>(null);

  const setHover = (node: SimNode | null) => {
    if (hoverRef.current?.id === node?.id) return;
    hoverRef.current = node;
    neighboursRef.current = node ? (adjacency.get(node.id) ?? new Set()) : new Set();
    // Written to the element, not to a class: hovering happens per pointer move, and a re-render
    // of the canvas on each of those is the one thing this view is built to avoid.
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = node ? "pointer" : "grab";
    invalidate();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = toGraph(event);
    const node = nodeAt(sim.nodes, at.x, at.y, (n) => drawnRadius(n, cameraRef.current.scale));
    if (node) node.pinned = true;
    dragRef.current = { node, x: event.clientX, y: event.clientY, moved: false };
    followRef.current = false;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim) return;
    const drag = dragRef.current;
    const at = toGraph(event);
    if (!drag) {
      setHover(nodeAt(sim.nodes, at.x, at.y, (n) => drawnRadius(n, cameraRef.current.scale)));
      return;
    }
    // A couple of pixels of travel is a click with a shaky hand, not a drag.
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) drag.moved = true;
    if (drag.node) {
      drag.node.x = at.x;
      drag.node.y = at.y;
      reheat(sim);
      wake();
      return;
    }
    const camera = cameraRef.current;
    camera.x -= (event.clientX - drag.x) / camera.scale;
    camera.y -= (event.clientY - drag.y) / camera.scale;
    drag.x = event.clientX;
    drag.y = event.clientY;
    invalidate();
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.node) {
      drag.node.pinned = false;
      const sim = simRef.current;
      if (sim) reheat(sim, 0.15);
      wake();
      if (!drag.moved) onOpen(drag.node.id);
    }
  };

  // Not React's `onWheel`: that one is passive, so `preventDefault` does nothing and the wheel
  // scrolls the pane behind the graph while it zooms.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const camera = cameraRef.current;
      const rect = canvas.getBoundingClientRect();
      // The point under the cursor stays under it — zooming towards what you are looking at,
      // rather than towards the middle of the pane.
      const before = {
        x: (event.clientX - rect.left - rect.width / 2) / camera.scale + camera.x,
        y: (event.clientY - rect.top - rect.height / 2) / camera.scale + camera.y,
      };
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.scale * Math.exp(-event.deltaY * 0.0015)));
      followRef.current = false;
      camera.scale = next;
      camera.x = before.x - (event.clientX - rect.left - rect.width / 2) / next;
      camera.y = before.y - (event.clientY - rect.top - rect.height / 2) / next;
      dirtyRef.current = true;
      wake();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [wake]);

  // The filter is a repaint, not a relayout.
  useEffect(() => invalidate(), [visibleIds, invalidate]);

  const zoomBy = (factor: number) => {
    followRef.current = false;
    const camera = cameraRef.current;
    camera.scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, camera.scale * factor));
    invalidate();
  };

  return (
    <div ref={hostRef} className="relative h-full min-h-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-grab touch-none"
        role="img"
        aria-label={t("notes.graphLegend", { notes: notes.length, links: edges.length })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      />
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <button type="button" className={CONTROL} title={t("notes.graphZoomIn")} aria-label={t("notes.graphZoomIn")} onClick={() => zoomBy(1.25)}>
          <ZoomIn size={13} />
        </button>
        <button type="button" className={CONTROL} title={t("notes.graphZoomOut")} aria-label={t("notes.graphZoomOut")} onClick={() => zoomBy(0.8)}>
          <ZoomOut size={13} />
        </button>
        <button type="button" className={CONTROL} title={t("notes.graphFit")} aria-label={t("notes.graphFit")} onClick={fit}>
          <Maximize2 size={13} />
        </button>
      </div>
      {groups.length > 1 && (
        <ul className="pointer-events-none absolute left-3 top-2 flex max-h-[45%] flex-col gap-0.5 overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)]/85 px-2 py-1.5 text-[11px] backdrop-blur-sm">
          {groups.map((group) => (
            <li key={group.id} className="flex items-center gap-1.5 text-[var(--cf-text-muted)]">
              <span className="size-2 shrink-0 rounded-full" style={{ background: group.color || "var(--cf-accent)" }} />
              <span className="max-w-[180px] truncate text-[var(--cf-text)]">{group.name}</span>
              <span className="tabular-nums text-[var(--cf-text-faint)]">{group.count}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-[var(--cf-text-faint)]">
        {t("notes.graphLegend", { notes: notes.length, links: edges.length })}
      </p>
    </div>
  );
}
