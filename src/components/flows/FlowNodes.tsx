import { createContext, memo, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Handle, NodeResizer, Position, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import { Check, Hourglass, Minus, Pin, Trash2, X } from "lucide-react";
import { AiGlyph, type AiGlyphName } from "../common/AiGlyph";
import { ColorSwatchPicker } from "../common/ColorSwatchPicker";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { familyColor, nodeIcon } from "../../lib/flows/nodeIcons";
import { appLogo } from "../../lib/flows/appLogos";
import { BrandGlyph } from "../ai/ProviderGlyph";
import type { FlowNodeDescriptor, FlowNodeRunStatus } from "../../lib/tauri/flowsCommands";

/**
 * The two kinds of thing on the Flujos canvas: a node, and a sticky note.
 *
 * A node is drawn the way the plan's prototype draws it — a 64px tile in its family's hue, the name
 * hanging under it — and **the tile is the whole measured box**. The name is absolutely positioned
 * outside it, so React Flow measures 64×64 and every handle sits on the tile's edge rather than on a
 * box that grows with a long name.
 */

export interface CfNodeData extends Record<string, unknown> {
  descriptor: FlowNodeDescriptor;
  name: string;
  /** The node type's own name, shown under a node that has been renamed. */
  typeLabel: string;
  disabled: boolean;
  /** Translated port names, empty when the ports are unnamed. */
  inputLabels: string[];
  /** Input ports — the catalogue's, or a Merge's `inputs` setting (`inputCount`). */
  inputs: number;
  outputLabels: string[];
  /** Output ports on the canvas — the catalogue's, plus the error port when it routes failures. */
  outputs: number;
  /** The service an Apps node calls (`serviceOf`), drawn as its mark; `""` for the node's glyph. */
  logo: string;
  /** Whether the last port is the error port. */
  errorPort: boolean;
  /** What the run on screen did with it. */
  run: { status: FlowNodeRunStatus; error: string; title: string; waiting?: boolean } | null;
  /** Its clock while it runs, what it took once it ran; `""` when there is nothing to show. */
  time: string;
  pinned: boolean;
  pinnedTitle: string;
  /** What it still needs before it can run (`nodeIssues`), a line each; `""` when nothing. */
  issue?: string;
  /** What an AI proposal on screen does to it. */
  diff?: "added" | "changed" | "removed";
  diffTitle?: string;
}

export interface NoteNodeData extends Record<string, unknown> {
  text: string;
  placeholder: string;
  /** `noteColor`: a `#rrggbb`, or `""` for the default yellow. */
  color: string;
  /** A proposal is on the canvas: the note is looked at, not painted. */
  locked: boolean;
}

/** A note's colour when it has none of its own — `.cf-flow-note`'s `--cf-note-ink` in flows.css. */
export const NOTE_DEFAULT_INK = "#facc15";

export type CfNode = Node<CfNodeData, "cf">;
export type NoteNode = Node<NoteNodeData, "note">;
export type FlowCanvasNode = CfNode | NoteNode;

/** What a note needs from the editor, through context rather than node data: callbacks in `data`
 *  would change identity every render and defeat the node cache. */
export interface CanvasActions {
  /** A resize begins — the editor records the undo step once, here. */
  beginGesture: () => void;
  commitNoteText: (id: string, text: string) => void;
  /** One connection out, by its key — one undo step, like the Delete key. */
  removeConnection: (id: string) => void;
  /** The remove button's label, translated by the editor like the notes' placeholder. */
  removeConnectionLabel: string;
  /** Paints a note — the whole selection when the note is part of it. */
  setNoteColor: (id: string, color: string) => void;
  /** The note whose palette is open. Here rather than in the note, because the note's right-click
   *  menu opens it too (the way the chat's folders do). */
  noteColorFor: string | null;
  setNoteColorFor: (id: string | null) => void;
  noteColorLabel: string;
  noteColorNoneLabel: string;
}

export const CanvasActionsContext = createContext<CanvasActions>({
  beginGesture: () => {},
  commitNoteText: () => {},
  removeConnection: () => {},
  removeConnectionLabel: "",
  setNoteColor: () => {},
  noteColorFor: null,
  setNoteColorFor: () => {},
  noteColorLabel: "",
  noteColorNoneLabel: "",
});

const AI_GLYPHS = new Set<string>(["bot", "cpu", "list-checks", "file-braces", "message-square-text", "eye", "scan-eye", "messages-square", "pencil", "brain-circuit", "binary", "database-zap", "wand", "reply", "scan-search", "audio-lines"]);

/** AI nodes that compute vectors rather than reason: no ThinkingOrb while they run. */
const COMPUTES_ONLY = new Set<string>(["ai.embed", "ai.vectors"]);

/** Where the `index`-th of `count` ports sits along the tile's edge. */
const portTop = (index: number, count: number) => (count <= 1 ? "50%" : `${((index + 1) / (count + 1)) * 100}%`);

/** The mark in a node's corner for what the run did with it. */
function RunBadge({ status, title, waiting }: { status: FlowNodeRunStatus; title: string; waiting?: boolean }) {
  if (waiting) {
    return (
      <span className="cf-flow-node__badge is-waiting" title={title}>
        <Hourglass size={10} strokeWidth={2.5} />
      </span>
    );
  }
  const icon =
    status === "success" ? <Check size={10} strokeWidth={3} /> : status === "error" ? <X size={10} strokeWidth={3} /> : status === "skipped" || status === "canceled" ? <Minus size={10} strokeWidth={3} /> : null;
  if (!icon) return null;
  return (
    <span className={`cf-flow-node__badge is-${status}`} title={title}>
      {icon}
    </span>
  );
}

export const FlowNodeView = memo(function FlowNodeView({ data }: NodeProps<CfNode>) {
  const { descriptor, name, typeLabel, disabled, inputLabels, inputs, outputLabels, outputs, errorPort, run, time, pinned, pinnedTitle, diff, diffTitle, logo, issue } = data;
  const Icon = nodeIcon(descriptor.icon);
  const mark = logo ? appLogo(logo) : undefined;
  // AI by what the node is, not where the palette files it: "Analizar PR" lives under Git and PRs
  // and still reasons — its glyph and its orb come from the `ai.` id.
  const isAi = descriptor.typeId.startsWith("ai.");
  const glyph = mark ? (
    <BrandGlyph id={logo} logo={mark} size={26} />
  ) : isAi && AI_GLYPHS.has(descriptor.icon) ? (
    <AiGlyph name={descriptor.icon as AiGlyphName} size={26} />
  ) : (
    <Icon size={26} strokeWidth={1.75} />
  );
  return (
    <div
      className={`cf-flow-node ${descriptor.family === "trigger" ? "is-trigger" : ""} ${disabled ? "is-disabled" : ""} ${
        run ? `is-run-${run.status}` : ""
      } ${diff ? `is-diff-${diff}` : ""}`}
      style={{ "--node-color": familyColor(descriptor.family) } as CSSProperties}
    >
      <div className="cf-flow-node__tile">
        {glyph}
        {run && <RunBadge status={run.status} title={run.title} waiting={run.waiting} />}
        {/* A model at work — the one mark the app keeps for reasoning, and only while it lasts. */}
        {run?.status === "running" && isAi && !COMPUTES_ONLY.has(descriptor.typeId) && (
          <span className="cf-flow-node__orb" title={run.title}>
            <ThinkingOrb size="sm" />
          </span>
        )}
        {diff && (
          <span className="cf-flow-node__diff" title={diffTitle}>
            {diff === "added" ? "+" : diff === "changed" ? "~" : "−"}
          </span>
        )}
        {pinned && (
          <span className="cf-flow-node__pin" title={pinnedTitle}>
            <Pin size={9} strokeWidth={2.5} />
          </span>
        )}
        {/* Unfinished: what it lacks, before a run finds out (beside a run's own mark, not over it). */}
        {issue && (
          <span className="cf-flow-node__issue" title={issue} aria-label={issue}>
            !
          </span>
        )}
        {Array.from({ length: inputs }, (_, index) => (
          <Handle
            key={`i${index}`}
            id={`i${index}`}
            type="target"
            position={Position.Left}
            style={{ top: portTop(index, inputs) }}
          />
        ))}
        {inputLabels.map((label, index) => (
          <span
            key={`il${index}`}
            className="cf-flow-port-label is-input"
            style={{ top: portTop(index, inputs) }}
          >
            {label}
          </span>
        ))}
        {Array.from({ length: outputs }, (_, index) => (
          <Handle
            key={`o${index}`}
            id={`o${index}`}
            type="source"
            position={Position.Right}
            className={errorPort && index === outputs - 1 ? "is-error-port" : undefined}
            style={{ top: portTop(index, outputs) }}
          />
        ))}
        {outputLabels.map((label, index) => (
          <span
            key={`ol${index}`}
            className={`cf-flow-port-label ${errorPort && index === outputs - 1 ? "is-error-port" : ""}`}
            style={{ top: portTop(index, outputs) }}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="cf-flow-node__label">
        <span className="cf-flow-node__name">{name}</span>
        {typeLabel !== name && <span className="cf-flow-node__type">{typeLabel}</span>}
        {time && <span className={`cf-flow-node__time ${run?.status === "running" ? "is-live" : ""}`}>{time}</span>}
      </div>
    </div>
  );
});

/**
 * A sticky note: text on the canvas that runs nothing. Double-click to write; the change lands as
 * one undo step when the box loses focus, not one per keystroke.
 *
 * Its colour is a dot in the corner, shown on hover and while selected, that opens the app's
 * palette (`ColorSwatchPicker`, as the chat's folders and the workspaces use) — the note's
 * right-click menu opens the same one.
 */
export const NoteNodeView = memo(function NoteNodeView({ id, data, selected }: NodeProps<NoteNode>) {
  const actions = useContext(CanvasActionsContext);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.text);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setText(data.text);
  }, [data.text, editing]);

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (text !== data.text) actions.commitNoteText(id, text);
  };

  return (
    <>
      <NodeResizer
        isVisible={selected && !editing}
        minWidth={120}
        minHeight={56}
        onResizeStart={actions.beginGesture}
      />
      <div
        className={`cf-flow-note ${editing ? "is-editing" : !data.text ? "is-empty" : ""}`}
        style={data.color ? ({ "--cf-note-ink": data.color } as CSSProperties) : undefined}
        onDoubleClick={() => setEditing(true)}
      >
        {!editing && !data.locked && (
          <div
            // `nodrag`/`nopan`: a press on the dot is the dot's, not the start of moving the note.
            className={`cf-flow-note__color nodrag nopan ${actions.noteColorFor === id ? "is-open" : ""}`}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <ColorSwatchPicker
              value={data.color}
              onChange={(color) => actions.setNoteColor(id, color)}
              title={actions.noteColorLabel}
              allowNone
              noneTitle={actions.noteColorNoneLabel}
              noneColor={NOTE_DEFAULT_INK}
              open={actions.noteColorFor === id}
              onOpenChange={(open) => actions.setNoteColorFor(open ? id : null)}
              trigger={<span className="cf-flow-note__swatch" />}
            />
          </div>
        )}
        {editing ? (
          <textarea
            ref={field}
            // `nodrag`/`nowheel`/`nopan` are React Flow's escape hatches: inside the box, a press
            // selects text and a wheel scrolls it, instead of moving the note or the canvas.
            className="nodrag nowheel nopan"
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setText(data.text);
                setEditing(false);
              }
            }}
          />
        ) : (
          data.text || data.placeholder
        )}
      </div>
    </>
  );
});

/** How long the remove button outlives the pointer leaving the line — enough to cross the gap
 *  between the line and the button without it going away under the cursor. */
const EDGE_LEAVE_MS = 160;

/**
 * A connection: React Flow's own bezier (the same path, label and hit area as its default edge),
 * plus a button to take it out — shown while the pointer is on the line and while the connection is
 * selected, at the middle of the line, under the items count when the last run left one there.
 * The other ways out are the Delete key on a selected connection and its right-click menu.
 *
 * `deletable: false` (a proposal on the canvas) leaves just the line.
 */
export const FlowEdgeView = memo(function FlowEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  deletable,
  label,
  labelStyle,
  labelShowBg,
  labelBgStyle,
  labelBgPadding,
  labelBgBorderRadius,
  style,
  markerStart,
  markerEnd,
  pathOptions,
  interactionWidth,
}: EdgeProps) {
  const actions = useContext(CanvasActionsContext);
  const [hot, setHot] = useState(false);
  const leaving = useRef<number | undefined>(undefined);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: (pathOptions as { curvature?: number } | undefined)?.curvature,
  });

  useEffect(() => () => window.clearTimeout(leaving.current), []);

  const enter = () => {
    window.clearTimeout(leaving.current);
    setHot(true);
  };
  const leave = () => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setHot(false), EDGE_LEAVE_MS);
  };

  return (
    <>
      <g className={hot ? "cf-flow-edge is-hot" : "cf-flow-edge"} onPointerEnter={enter} onPointerLeave={leave}>
        <BaseEdge
          path={path}
          labelX={labelX}
          labelY={labelY}
          label={label}
          labelStyle={labelStyle}
          labelShowBg={labelShowBg}
          labelBgStyle={labelBgStyle}
          labelBgPadding={labelBgPadding}
          labelBgBorderRadius={labelBgBorderRadius}
          style={style}
          markerStart={markerStart}
          markerEnd={markerEnd}
          interactionWidth={interactionWidth}
        />
      </g>
      {deletable !== false && (hot || selected) && (
        <EdgeLabelRenderer>
          <button
            type="button"
            // `nodrag`/`nopan`: a press here is the button's, not the start of a pan.
            className="cf-flow-edge-remove nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (label ? 18 : 0)}px)` }}
            title={actions.removeConnectionLabel}
            aria-label={actions.removeConnectionLabel}
            onPointerEnter={enter}
            onPointerLeave={leave}
            onClick={(event) => {
              event.stopPropagation();
              actions.removeConnection(id);
            }}
          >
            <Trash2 size={11} strokeWidth={2.25} />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
