import "@xyflow/react/dist/style.css";

import { memo, useEffect, useMemo } from "react";
import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { CircleHelp, GitMerge, Lock } from "lucide-react";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { useT } from "../../../state/languageStore";
import type { TeamItem, TeamRunState } from "../../../types/team";
import { itemKindKey, memberColor, statusTone } from "./teamLook";

const NODE_W = 228;
const NODE_H = 76;
const GAP_X = 64;
const GAP_Y = 18;

interface ItemData extends Record<string, unknown> {
  item: TeamItem;
  provider: string;
  color: string;
  selected: boolean;
}
type ItemNode = Node<ItemData, "item">;

/**
 * Columns by how far down the plan an item sits: past every item it depends on, past the item it
 * continues, reviews or integrates, and — for work the lead assigned — past the lead turn that
 * assigned it. A lead turn sits past everything that existed when it started. Pure.
 */
export function layoutTeam(items: TeamItem[]): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const leadOfRound = new Map<number, TeamItem>();
  for (const i of items) if (i.kind === "plan" || i.kind === "final" || i.kind === "answer") if (!leadOfRound.has(i.round)) leadOfRound.set(i.round, i);
  const visiting = new Set<string>();
  const of = (item: TeamItem): number => {
    const known = depth.get(item.id);
    if (known !== undefined) return known;
    if (visiting.has(item.id)) return 0;
    visiting.add(item.id);
    const parents: TeamItem[] = [];
    for (const d of item.depends_on) {
      const p = byId.get(d);
      if (p) parents.push(p);
    }
    const ref = byId.get(item.ref_item);
    if (ref) parents.push(ref);
    const isLead = item.kind === "plan" || item.kind === "final" || item.kind === "answer";
    if (isLead) {
      for (const other of items) if (other.id !== item.id && other.created_at < item.created_at && !(other.kind === "plan" && other.round === item.round)) parents.push(other);
    } else {
      const lead = leadOfRound.get(item.round);
      if (lead && lead.id !== item.id) parents.push(lead);
    }
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(of)) + 1;
    visiting.delete(item.id);
    depth.set(item.id, d);
    return d;
  };
  for (const i of items) of(i);
  const columns = new Map<number, TeamItem[]>();
  for (const i of items) {
    const d = depth.get(i.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(i);
    columns.set(d, col);
  }
  const out = new Map<string, { x: number; y: number }>();
  for (const [d, col] of columns) {
    col.sort((a, b) => a.member_name.localeCompare(b.member_name) || a.created_at.localeCompare(b.created_at));
    col.forEach((item, row) => out.set(item.id, { x: d * (NODE_W + GAP_X), y: row * (NODE_H + GAP_Y) }));
  }
  return out;
}

const ItemCard = memo(function ItemCard({ data }: NodeProps<ItemNode>) {
  const t = useT();
  const { item, provider, color, selected } = data;
  const tone = statusTone(item.status);
  return (
    <div
      style={{ width: NODE_W, height: NODE_H, borderLeftColor: color }}
      className={`flex flex-col justify-between overflow-hidden rounded-lg border border-l-[3px] bg-[var(--cf-surface)] px-2.5 py-1.5 text-left shadow-sm transition-shadow ${
        selected ? "border-[var(--cf-accent)] shadow-[0_0_0_2px_color-mix(in_oklab,var(--cf-accent)_35%,transparent)]" : "border-[var(--cf-border)]"
      } ${item.status === "skipped" || item.status === "cancelled" ? "opacity-50" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-[var(--cf-border-strong)]" />
      <div className="flex min-w-0 items-center gap-1.5">
        <ProviderGlyph providerId={provider} size={12} />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" style={{ color }}>
          {item.member_name || t("team.lead")}
        </span>
        {item.status === "running" && <ThinkingOrb size="sm" />}
        {item.status === "waiting" && <CircleHelp size={13} className="text-[var(--cf-warning)]" />}
        {item.status === "gated" && <Lock size={12} className="text-[var(--cf-warning)]" />}
        {item.merged && <GitMerge size={12} className="text-[var(--cf-success)]" />}
      </div>
      <p className="line-clamp-2 text-[12px] leading-snug text-[var(--cf-text)]">{item.title}</p>
      <div className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        <span>{t(`team.status.${item.status}` as never)}</span>
        <span>·</span>
        <span className="truncate">{t(itemKindKey(item.kind))}</span>
        {item.lap > 0 && <span className="ml-auto">{t("team.lapN", { n: String(item.lap) })}</span>}
      </div>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-[var(--cf-border-strong)]" />
    </div>
  );
});

const NODE_TYPES = { item: ItemCard };

function Canvas({ state, selected, onSelect }: { state: TeamRunState; selected: string | null; onSelect: (id: string | null) => void }) {
  const flow = useReactFlow();
  const memberIndex = useMemo(() => new Map(state.run.members.map((m, i) => [m.id, i])), [state.run.members]);
  const providerOf = useMemo(() => new Map(state.run.members.map((m) => [m.id, m.provider])), [state.run.members]);
  const positions = useMemo(() => layoutTeam(state.items), [state.items]);
  const nodes: ItemNode[] = useMemo(
    () =>
      state.items.map((item) => ({
        id: item.id,
        type: "item",
        position: positions.get(item.id) ?? { x: 0, y: 0 },
        data: { item, provider: providerOf.get(item.member_id) ?? "", color: memberColor(memberIndex.get(item.member_id) ?? 0), selected: item.id === selected },
        draggable: false,
      })),
    [state.items, positions, providerOf, memberIndex, selected],
  );
  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    const byId = new Map(state.items.map((i) => [i.id, i]));
    for (const item of state.items) {
      const live = item.status === "running";
      for (const dep of item.depends_on) {
        if (!byId.has(dep)) continue;
        out.push({
          id: `d-${dep}-${item.id}`,
          source: dep,
          target: item.id,
          animated: live,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
          style: { stroke: "var(--cf-border-strong)", strokeWidth: 1.4 },
        });
      }
      if (item.ref_item && byId.has(item.ref_item)) {
        out.push({
          id: `r-${item.ref_item}-${item.id}`,
          source: item.ref_item,
          target: item.id,
          animated: live,
          markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
          style: { stroke: item.kind === "review" ? "var(--cf-warning)" : "var(--cf-accent)", strokeDasharray: "5 4", strokeWidth: 1.3 },
        });
      }
    }
    // The lead's turn to the work it assigned.
    const leadOfRound = new Map<number, TeamItem>();
    for (const i of state.items) if (i.kind === "plan" && !leadOfRound.has(i.round)) leadOfRound.set(i.round, i);
    for (const item of state.items) {
      if (item.kind === "plan" || item.kind === "final" || item.kind === "answer" || item.depends_on.length > 0 || item.ref_item) continue;
      const lead = leadOfRound.get(item.round);
      if (!lead) continue;
      out.push({ id: `l-${lead.id}-${item.id}`, source: lead.id, target: item.id, style: { stroke: "var(--cf-border)", strokeDasharray: "2 4" } });
    }
    return out;
  }, [state.items]);

  const shape = state.items.length;
  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.15, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [shape, flow]);

  return (
    <ReactFlow<ItemNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      onNodeClick={(_, node) => onSelect(node.id === selected ? null : node.id)}
      onPaneClick={() => onSelect(null)}
      minZoom={0.1}
      maxZoom={1.6}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

/** The run as a live graph: one card per item, coloured by member, arrows for what waits on what. */
export default function TeamGraph(props: { state: TeamRunState; selected: string | null; onSelect: (id: string | null) => void }) {
  return (
    <div className="absolute inset-0">
      <ReactFlowProvider>
        <Canvas {...props} />
      </ReactFlowProvider>
    </div>
  );
}
