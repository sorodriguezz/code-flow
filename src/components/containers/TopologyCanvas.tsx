import "@xyflow/react/dist/style.css";
import "./topology.css";

import { createContext, memo, useContext, useEffect, useMemo } from "react";
import { Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import { StateDot } from "./containerBits";
import { BAND_HEAD, NODE_H, NODE_W, layeredLayout, type Tone } from "./topologyModel";

/**
 * A read-only graph of what is connected to what — a cluster's objects or an Azure group's
 * resources — in columns (`layer`) and bands (`band`), laid out by `topologyModel`. Picking a node
 * lights it and what it touches and dims the rest; nothing is dragged, connected or deleted, so React
 * Flow's keys are all off (as in the code map). Loaded with its page only (React Flow is not small).
 */

export interface GraphNode {
  id: string;
  title: string;
  /** The line under the title: state, ports, hosts. */
  sub: string;
  /** What it is: `Deployment`, `App Service`. */
  badge: string;
  tone: Tone;
  layer: number;
  band: string;
  /** Referenced but not there, or outside the scope read: drawn dashed. */
  ghost?: boolean;
  /** Something is wrong with it (a service with no pods, failing pods). */
  flagged?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: string;
  label: string;
}

interface Spot {
  selected: string | null;
  linked: Set<string>;
}
const SpotContext = createContext<Spot>({ selected: null, linked: new Set() });

type NodeData = { node: GraphNode };
type BandData = { label: string; width: number; height: number };
type CanvasNode = Node<NodeData, "item"> | Node<BandData, "band">;

const ItemView = memo(function ItemView({ data }: NodeProps<Node<NodeData, "item">>) {
  const { node } = data;
  const spot = useContext(SpotContext);
  const selected = spot.selected === node.id;
  const dimmed = !!spot.selected && !selected && !spot.linked.has(node.id);
  return (
    <div
      className={`cf-topo-node ${selected ? "cf-topo-node--selected" : ""} ${dimmed ? "cf-topo-node--dimmed" : ""} ${node.ghost ? "cf-topo-node--ghost" : ""}`}
      style={{ width: NODE_W, height: NODE_H }}
      title={node.title}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="flex min-w-0 items-center gap-1.5">
        <StateDot tone={node.tone} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">{node.title}</span>
        {node.flagged && <AlertTriangle size={11} className="shrink-0 text-[var(--cf-warning)]" />}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
        <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1 text-[10px]">{node.badge}</span>
        <span className="min-w-0 truncate">{node.sub}</span>
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});

function BandView({ data }: NodeProps<Node<BandData, "band">>) {
  return (
    <div className="cf-topo-band" style={{ width: data.width, height: data.height }}>
      <span className="cf-topo-band-label">{data.label}</span>
    </div>
  );
}

const NODE_TYPES = { item: ItemView, band: BandView };

/** How each kind of link is drawn — colour and dash, the same for both graphs. */
const EDGE_STYLE: Record<string, { stroke: string; dash?: string }> = {
  routes: { stroke: "var(--cf-accent)" },
  selects: { stroke: "var(--cf-blue)" },
  owns: { stroke: "color-mix(in oklab, var(--cf-text) 22%, transparent)" },
  mounts: { stroke: "var(--cf-teal)", dash: "5 4" },
  env: { stroke: "var(--cf-teal)", dash: "2 4" },
  pull: { stroke: "color-mix(in oklab, var(--cf-text) 30%, transparent)", dash: "2 4" },
  claims: { stroke: "var(--cf-teal)", dash: "5 4" },
  scales: { stroke: "var(--cf-warning)", dash: "2 4" },
  ref: { stroke: "color-mix(in oklab, var(--cf-text) 34%, transparent)" },
  host: { stroke: "var(--cf-blue)" },
  setting: { stroke: "var(--cf-accent)" },
  vault: { stroke: "var(--cf-warning)", dash: "5 4" },
};

const PAD = 24;

function Canvas({ nodes, edges, bandLabel, selected, onSelect }: TopologyCanvasProps) {
  const flow = useReactFlow();
  const { positions, bands } = useMemo(() => layeredLayout(nodes, edges), [nodes, edges]);
  const linked = useMemo(() => {
    const set = new Set<string>();
    if (!selected) return set;
    for (const e of edges) {
      if (e.from === selected) set.add(e.to);
      if (e.to === selected) set.add(e.from);
    }
    return set;
  }, [edges, selected]);
  const canvasNodes = useMemo<CanvasNode[]>(() => {
    const out: CanvasNode[] = bands.map((band) => ({
      id: `band:${band.id}`,
      type: "band",
      position: { x: -PAD, y: band.y },
      data: { label: bandLabel(band.id), width: band.width + PAD * 2, height: band.height + PAD - BAND_HEAD / 2 },
      selectable: false,
      draggable: false,
      zIndex: 0,
    }));
    for (const node of nodes) {
      const at = positions.get(node.id);
      if (at) out.push({ id: node.id, type: "item", position: at, data: { node }, zIndex: 10 });
    }
    return out;
  }, [nodes, positions, bands, bandLabel]);
  const canvasEdges = useMemo<Edge[]>(
    () =>
      edges
        .filter((e) => positions.has(e.from) && positions.has(e.to))
        .map((e, i) => {
          const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.ref;
          const lit = !!selected && (e.from === selected || e.to === selected);
          const dim = !!selected && !lit;
          return {
            id: `${i}:${e.from}>${e.to}:${e.kind}`,
            source: e.from,
            target: e.to,
            // Labels only on what the pick lights: on a whole namespace they are noise.
            label: lit && e.label ? e.label : undefined,
            labelStyle: { fontSize: 10, fill: "var(--cf-text)" },
            labelBgStyle: { fill: "var(--cf-surface)" },
            markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: style.stroke },
            style: { stroke: style.stroke, strokeDasharray: style.dash, strokeWidth: lit ? 2 : 1.2, opacity: dim ? 0.15 : 1 },
            zIndex: lit ? 5 : 1,
          };
        }),
    [edges, positions, selected],
  );
  // A new graph (another namespace or group) is fitted once; a pick or a refresh keeps the view.
  const shape = useMemo(() => nodes.map((n) => n.id).join("|"), [nodes]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.15, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [shape, flow]);
  return (
    <SpotContext.Provider value={{ selected, linked }}>
      <ReactFlow<CanvasNode, Edge>
        className="cf-topo-canvas"
        nodes={canvasNodes}
        edges={canvasEdges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => node.type === "item" && onSelect(node.id === selected ? null : node.id)}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        minZoom={0.1}
        maxZoom={2}
        zoomOnDoubleClick={false}
        deleteKeyCode={null}
        panActivationKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomActivationKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
      </ReactFlow>
    </SpotContext.Provider>
  );
}

export interface TopologyCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bandLabel: (band: string) => string;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export default function TopologyCanvas(props: TopologyCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
