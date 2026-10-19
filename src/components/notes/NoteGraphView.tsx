import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { LoaderCircle, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { layoutGraph } from "../../lib/notes/graphLayout";
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
  const notes = useMemo(
    () => graph.nodes.map((note) => ({ id: note.id, title: note.title || t("notes.untitled") })),
    [graph, t],
  );
  return <GraphCanvas nodes={notes} edges={graph.edges} visibleIds={visibleIds} onOpen={onOpen} />;
}

/** The palette, read once from the document rather than written here: the app has fourteen themes
 *  and a user-chosen accent, and every one of them is already a CSS variable. */
interface Palette {
  background: string;
  line: string;
  accent: string;
  faint: string;
  text: string;
  textMuted: string;
}

/**
 * CSS variables as colours a canvas can use.
 *
 * `getComputedStyle(el).getPropertyValue("--cf-text-faint")` hands back the *token*, and most of
 * this app's are `color-mix(…)` over other tokens — which `fillStyle` does not understand and
 * silently ignores, leaving whatever colour was set before. Reading it through a probe element's
 * `color` makes the browser resolve the whole chain to an `rgb()` first.
 */
function readPalette(host: HTMLElement): Palette {
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
  };
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

/** The chrome of the zoom controls, which float over the canvas and need an edge of their own. */
const CONTROL = iconButtonClass({
  size: "xs",
  className: "border border-[var(--cf-border)] bg-[var(--cf-surface)]/85 backdrop-blur-sm",
});

/** Below this zoom the labels would be a grey smear, so only the highlighted ones are drawn. */
const LABEL_ZOOM = 0.62;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;

function GraphCanvas({
  nodes: notes,
  edges,
  visibleIds,
  onOpen,
}: {
  nodes: { id: string; title: string }[];
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
  const frameRef = useRef<number | null>(null);
  const dirtyRef = useRef(true);

  visibleRef.current = visibleIds;

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
    context.textAlign = "center";
    context.textBaseline = "top";
    const fontFamily = getComputedStyle(canvas).fontFamily;
    for (const node of sim.nodes) {
      const radius = radiusOf(node);
      const shown = inView(node.id);
      const highlighted = lit(node.id);
      const alpha = shown ? (highlighted ? 1 : 0.22) : highlighted ? 0.3 : 0.12;
      context.globalAlpha = alpha;
      context.beginPath();
      context.arc(node.x, node.y, radius, 0, Math.PI * 2);
      context.fillStyle = node.degree > 0 ? palette.accent : palette.faint;
      context.fill();
      // The dot sits on the lines it owns; a rim in the background colour cuts them off at its edge
      // instead of letting them run visibly underneath it.
      context.lineWidth = 1.5 / camera.scale;
      context.strokeStyle = palette.background;
      context.stroke();
      if (hovered?.id === node.id) {
        context.beginPath();
        context.arc(node.x, node.y, radius + 3.5 / camera.scale, 0, Math.PI * 2);
        context.strokeStyle = fade(palette.accent, 0.8);
        context.lineWidth = 1.5 / camera.scale;
        context.stroke();
      }

      if (!labels && !(hovered && highlighted)) continue;
      // Divided by the zoom, like every other length here: the canvas is drawn in graph
      // coordinates, so this is what keeps a label the same size on screen at any zoom.
      context.font = `${11 / camera.scale}px ${fontFamily}`;
      context.fillStyle = hovered?.id === node.id ? palette.text : palette.textMuted;
      context.globalAlpha = alpha;
      const title = titles.get(node.id) ?? "";
      const label = title.length > 28 ? `${title.slice(0, 27)}…` : title;
      context.fillText(label, node.x, node.y + radius + 3 / camera.scale);
    }
    context.globalAlpha = 1;
  }, [titles]);

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
      if (moving || dirtyRef.current) {
        dirtyRef.current = false;
        draw();
      }
      if (moving || dirtyRef.current) frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [draw]);

  const invalidate = useCallback(() => {
    dirtyRef.current = true;
    wake();
  }, [wake]);

  /** Whether the current graph has been framed yet — see the resize effect. */
  const fittedRef = useRef(false);

  const fit = useCallback(() => {
    const sim = simRef.current;
    const { width, height } = sizeRef.current;
    if (!sim || sim.nodes.length === 0 || width === 0) return;
    fittedRef.current = true;
    const box = bounds(sim.nodes);
    const scale = Math.min(width / (box.maxX - box.minX), height / (box.maxY - box.minY));
    cameraRef.current = {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      scale: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale)),
    };
    invalidate();
  }, [invalidate]);

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
    const seeded = layoutGraph(
      notes.map((note) => note.id),
      edges,
    );
    simRef.current = createSimulation(
      notes.map((note) => ({
        id: note.id,
        ...(seeded.get(note.id) ?? { x: 0, y: 0 }),
        degree: degree.get(note.id) ?? 0,
      })),
      links,
    );
    hoverRef.current = null;
    neighboursRef.current = new Set();
    // Framed by the pane, which has no size yet on the first pass — effects run before the browser
    // has laid the canvas out. The resize below does it as soon as there is a box to frame into.
    fittedRef.current = false;
    fit();
  }, [notes, edges, fit]);

  // The canvas follows the pane, in device pixels: a backing store sized in CSS pixels is the
  // blurry-canvas bug, and on Windows the ratio is whatever the display scaling is set to.
  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    paletteRef.current = readPalette(host);
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
      paletteRef.current = readPalette(host);
      invalidate();
    };
    const observer = new MutationObserver(reread);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => observer.disconnect();
  }, [invalidate]);

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
    const node = nodeAt(sim.nodes, at.x, at.y, radiusOf);
    if (node) node.pinned = true;
    dragRef.current = { node, x: event.clientX, y: event.clientY, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const sim = simRef.current;
    if (!sim) return;
    const drag = dragRef.current;
    const at = toGraph(event);
    if (!drag) {
      setHover(nodeAt(sim.nodes, at.x, at.y, radiusOf));
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
      <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-[var(--cf-text-faint)]">
        {t("notes.graphLegend", { notes: notes.length, links: edges.length })}
      </p>
    </div>
  );
}
