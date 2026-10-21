/**
 * The canvas's nodes. Each draws itself with the same SVG fragment an export writes for it
 * (`cardSvg`, `zoneSvg`…), at its own origin, so what is on screen and what leaves the app are the
 * same drawing; the interactive parts — handles, the resize frame, a lens's badge — sit on top.
 *
 * A zone takes no pointer events but on its title band: the rest of it is see-through to the pane
 * beneath, so a drag across the inside of a big cloud pans or selects rather than picking the cloud
 * up. Its band is the drag handle, and its resize frame shows once it is selected.
 */
import { memo } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import type { Severity } from "../../../lib/architecture/rules";
import { useCanvasActions } from "./canvasState";

export interface CardData extends Record<string, unknown> {
  svg: string;
  w: number;
  h: number;
  dim: boolean;
  hot: boolean;
  /** A lens's pill on the card's lower right: a utilisation, a request rate, "off". */
  badge: { label: string; tone: "ok" | "warn" | "bad" | "down" | "n" } | null;
  severity: Severity | null;
  down: boolean;
  /** Read from a source: the card wears a small mark saying so. */
  sourced: boolean;
  sourcedLabel: string;
}

export interface ZoneData extends Record<string, unknown> {
  svg: string;
  head: number;
  dim: boolean;
}

export interface ArtData extends Record<string, unknown> {
  svg: string;
  w: number;
  h: number;
}

export type CardNode = Node<CardData, "card">;
export type ZoneNode = Node<ZoneData, "zone">;
export type ArtNode = Node<ArtData, "art">;
export type ArchNode = CardNode | ZoneNode | ArtNode;

const SEVERITY_COLOR: Record<Severity, string> = { critical: "var(--cf-danger)", warning: "var(--cf-warning)", suggestion: "var(--cf-accent)", risk: "#be185d" };
const TONE: Record<NonNullable<CardData["badge"]>["tone"], { bg: string; ink: string; line: string }> = {
  ok: { bg: "var(--arch-card)", ink: "var(--cf-success)", line: "var(--cf-success)" },
  warn: { bg: "var(--arch-card)", ink: "var(--cf-warning)", line: "var(--cf-warning)" },
  bad: { bg: "var(--cf-danger)", ink: "#fff", line: "var(--cf-danger)" },
  down: { bg: "#6b7280", ink: "#fff", line: "#6b7280" },
  n: { bg: "var(--arch-card)", ink: "var(--arch-ink2)", line: "var(--arch-line)" },
};

const SIDES = [
  { id: "t", position: Position.Top },
  { id: "r", position: Position.Right },
  { id: "b", position: Position.Bottom },
  { id: "l", position: Position.Left },
] as const;

export const CardView = memo(function CardView({ data, selected }: NodeProps<CardNode>) {
  const tone = data.badge ? TONE[data.badge.tone] : null;
  return (
    <div className={`arch-card${data.dim ? " is-dim" : ""}${data.hot ? " is-hot" : ""}${selected ? " is-sel" : ""}`} style={{ width: data.w, height: data.h }}>
      <svg width={data.w} height={data.h} overflow="visible" className="pointer-events-none block" dangerouslySetInnerHTML={{ __html: data.svg }} />
      {data.down ? <div className="pointer-events-none absolute inset-0 rounded-[10px] bg-[var(--arch-canvas)] opacity-55" /> : null}
      {data.severity ? <span className="pointer-events-none absolute -left-1 -top-1 h-[13px] w-[13px] rounded-full border-2 border-[var(--arch-card)]" style={{ background: SEVERITY_COLOR[data.severity] }} /> : null}
      {data.sourced ? (
        <span className="absolute bottom-1.5 left-[18px] h-[7px] w-[7px] rounded-full bg-[var(--cf-accent)] ring-2 ring-[var(--arch-card)]" title={data.sourcedLabel} />
      ) : null}
      {data.badge && tone ? (
        <span className="pointer-events-none absolute -bottom-[9px] right-[-8px] whitespace-nowrap rounded-full border px-[7px] text-[10px] font-bold leading-[15px]" style={{ background: tone.bg, color: tone.ink, borderColor: tone.line }}>
          {data.badge.label}
        </span>
      ) : null}
      {SIDES.map((s) => (
        <Handle key={s.id} id={s.id} type="source" position={s.position} className="arch-handle" />
      ))}
    </div>
  );
});

export const ZoneView = memo(function ZoneView({ id, data, selected, width, height }: NodeProps<ZoneNode>) {
  const actions = useCanvasActions();
  return (
    <div className={`arch-zone${data.dim ? " is-dim" : ""}${selected ? " is-sel" : ""}`} style={{ width, height }}>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={90}
        lineClassName="arch-resize-line"
        handleClassName="arch-resize-handle"
        onResizeEnd={(_, p) => actions?.resizeZone(id, p.x, p.y, p.width, p.height)}
      />
      <svg width={width} height={height} overflow="visible" className="pointer-events-none block" dangerouslySetInnerHTML={{ __html: data.svg }} />
      <div className="arch-zone-grip" style={{ height: data.head }} />
    </div>
  );
});

/** The document's header and the note chips: drawn, never moved or selected. */
export const ArtView = memo(function ArtView({ data }: NodeProps<ArtNode>) {
  return <svg width={data.w} height={data.h} overflow="visible" className="pointer-events-none block" dangerouslySetInnerHTML={{ __html: data.svg }} />;
});

export const NODE_TYPES = { card: CardView, zone: ZoneView, art: ArtView };
