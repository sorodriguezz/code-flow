import { createContext, memo, useContext, useEffect, useRef, useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { Check, Hourglass, Minus, Pin, X } from "lucide-react";
import { AiGlyph, type AiGlyphName } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { familyColor, nodeIcon } from "../../lib/flows/nodeIcons";
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
  outputLabels: string[];
  /** Output ports on the canvas — the catalogue's, plus the error port when it routes failures. */
  outputs: number;
  /** Whether the last port is the error port. */
  errorPort: boolean;
  /** What the run on screen did with it. */
  run: { status: FlowNodeRunStatus; error: string; title: string; waiting?: boolean } | null;
  pinned: boolean;
  pinnedTitle: string;
  /** What an AI proposal on screen does to it. */
  diff?: "added" | "changed" | "removed";
  diffTitle?: string;
}

export interface NoteNodeData extends Record<string, unknown> {
  text: string;
  placeholder: string;
}

export type CfNode = Node<CfNodeData, "cf">;
export type NoteNode = Node<NoteNodeData, "note">;
export type FlowCanvasNode = CfNode | NoteNode;

/** What a note needs from the editor, through context rather than node data: callbacks in `data`
 *  would change identity every render and defeat the node cache. */
export interface CanvasActions {
  /** A resize begins — the editor records the undo step once, here. */
  beginGesture: () => void;
  commitNoteText: (id: string, text: string) => void;
}

export const CanvasActionsContext = createContext<CanvasActions>({
  beginGesture: () => {},
  commitNoteText: () => {},
});

const AI_GLYPHS = new Set<string>(["bot", "cpu", "list-checks", "file-braces", "message-square-text", "eye", "pencil"]);

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
  const { descriptor, name, typeLabel, disabled, inputLabels, outputLabels, outputs, errorPort, run, pinned, pinnedTitle, diff, diffTitle } = data;
  const Icon = nodeIcon(descriptor.icon);
  const glyph =
    descriptor.family === "ai" && AI_GLYPHS.has(descriptor.icon) ? (
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
        {run?.status === "running" && descriptor.family === "ai" && (
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
        {Array.from({ length: descriptor.inputs }, (_, index) => (
          <Handle
            key={`i${index}`}
            id={`i${index}`}
            type="target"
            position={Position.Left}
            style={{ top: portTop(index, descriptor.inputs) }}
          />
        ))}
        {inputLabels.map((label, index) => (
          <span
            key={`il${index}`}
            className="cf-flow-port-label is-input"
            style={{ top: portTop(index, descriptor.inputs) }}
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
      </div>
    </div>
  );
});

/**
 * A sticky note: text on the canvas that runs nothing. Double-click to write; the change lands as
 * one undo step when the box loses focus, not one per keystroke.
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
        className={`cf-flow-note ${!editing && !data.text ? "is-empty" : ""}`}
        onDoubleClick={() => setEditing(true)}
      >
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
