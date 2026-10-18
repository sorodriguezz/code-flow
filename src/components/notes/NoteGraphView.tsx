import "@xyflow/react/dist/style.css";

import { memo, useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, Handle, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { LoaderCircle } from "lucide-react";
import { layoutGraph } from "../../lib/notes/graphLayout";
import { notesGraph } from "../../lib/tauri/notesCommands";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";

interface GraphNodeData extends Record<string, unknown> {
  title: string;
  degree: number;
  /** In the list the gallery is filtered to — the rest are drawn faint. */
  inView: boolean;
}

type GraphCanvasNode = Node<GraphNodeData, "note">;

const NoteDot = memo(function NoteDot({ data }: NodeProps<GraphCanvasNode>) {
  const size = Math.min(26, 8 + data.degree * 2.5);
  return (
    <div className={`flex flex-col items-center gap-1 ${data.inView ? "" : "opacity-30"}`} title={data.title}>
      <Handle type="target" position={Position.Top} isConnectable={false} style={{ opacity: 0, top: size / 2 }} />
      <span
        className="rounded-full border border-[var(--cf-surface)]"
        style={{ width: size, height: size, background: data.degree > 0 ? "var(--cf-accent)" : "var(--cf-text-faint)" }}
      />
      <span className="max-w-[160px] truncate text-[11px] text-[var(--cf-text)]">{data.title}</span>
      <Handle type="source" position={Position.Top} isConnectable={false} style={{ opacity: 0, top: size / 2 }} />
    </div>
  );
});

const NODE_TYPES = { note: NoteDot };

/**
 * The notes as a graph: one dot per note, a line per `[[link]]` between two of them, laid out so
 * notes that cite each other cluster (see `layoutGraph`). A dot's size is how connected it is; a
 * note with no links at all sits grey on the edge — the ones a vault forgets. Clicking one opens it.
 *
 * `visibleIds` is the gallery's current filter (a book, a tag, a search): the graph stays whole,
 * so the links out of the filter still show, and what is outside it is drawn faint.
 */
export function NoteGraphView({ visibleIds }: { visibleIds: Set<string> }) {
  return (
    <ReactFlowProvider>
      <Graph visibleIds={visibleIds} />
    </ReactFlowProvider>
  );
}

function Graph({ visibleIds }: { visibleIds: Set<string> }) {
  const t = useT();
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

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as GraphCanvasNode[], edges: [] as Edge[] };
    const degree = new Map<string, number>();
    for (const [from, to] of graph.edges) {
      degree.set(from, (degree.get(from) ?? 0) + 1);
      degree.set(to, (degree.get(to) ?? 0) + 1);
    }
    const positions = layoutGraph(
      graph.nodes.map((n) => n.id),
      graph.edges,
    );
    return {
      nodes: graph.nodes.map((note) => ({
        id: note.id,
        type: "note" as const,
        position: positions.get(note.id) ?? { x: 0, y: 0 },
        data: { title: note.title || t("notes.untitled"), degree: degree.get(note.id) ?? 0, inView: visibleIds.size === 0 || visibleIds.has(note.id) },
        draggable: false,
        connectable: false,
      })),
      edges: graph.edges.map(([from, to]) => ({
        id: `${from}>${to}`,
        source: from,
        target: to,
        selectable: false,
        style: { stroke: "color-mix(in oklab, var(--cf-text) 30%, transparent)", strokeWidth: 1 },
      })),
    };
  }, [graph, visibleIds, t]);

  if (error) return <p className="p-4 text-[12.5px] text-[var(--cf-danger)]">{error}</p>;
  if (!graph) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle size={16} className="animate-spin text-[var(--cf-text-muted)]" />
      </div>
    );
  }
  return (
    <div className="relative h-full min-h-0">
      <ReactFlow<GraphCanvasNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeClick={(_, node) => void openNote(node.id)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        maxZoom={2.5}
        deleteKeyCode={null}
        panActivationKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomActivationKeyCode={null}
        proOptions={{ hideAttribution: true }}
        style={{ background: "var(--cf-sunken)" }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
      </ReactFlow>
      <p className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-[var(--cf-text-faint)]">
        {t("notes.graphLegend", { notes: graph.nodes.length, links: graph.edges.length })}
      </p>
    </div>
  );
}
