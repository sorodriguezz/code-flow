import { useRef, useState, type ReactNode } from "react";
import type { PaneNode } from "../../lib/bench/layout";
import { clampRatio } from "../../lib/bench/layout";

/**
 * Draws a tab's pane tree, with a draggable divider at every split.
 *
 * **Nested flex, one element per node**, rather than absolute rectangles computed from the tree.
 * Percentages compose on their own down the nesting, so a divider only ever has to know about the
 * one box it divides — which is what keeps a two-level arrangement (one pane left, two stacked
 * right) from needing any geometry at all.
 *
 * **The drag is local state until it is let go.** Ratios live in the store, and the store persists
 * every write to SQLite; a drag that wrote through on every pointermove would be sixty round trips
 * a second and a re-render of every xterm in the tab per frame. So the divider tracks its own live
 * ratio, paints with it, and commits once on release. `onResize` is therefore called exactly once
 * per gesture.
 */
export function PaneTree({
  node,
  path,
  onResize,
  renderPane,
}: {
  node: PaneNode;
  /** Where this node sits in the tree, as the `a`/`b` turns taken to reach it — the address the
   *  store's `setRatio` walks. The root is `""`. */
  path: string;
  onResize: (path: string, ratio: number) => void;
  renderPane: (terminalId: string) => ReactNode;
}) {
  if (node.kind === "leaf") return <>{renderPane(node.id)}</>;
  return (
    <Split node={node} path={path} onResize={onResize} renderPane={renderPane} />
  );
}

function Split({
  node,
  path,
  onResize,
  renderPane,
}: {
  node: Extract<PaneNode, { kind: "split" }>;
  path: string;
  onResize: (path: string, ratio: number) => void;
  renderPane: (terminalId: string) => ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  /** Non-null only while a drag is in flight; the store's value is the truth otherwise. */
  const [dragging, setDragging] = useState<number | null>(null);
  const row = node.dir === "row";
  const ratio = dragging ?? node.ratio;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Captured, so the drag survives the pointer leaving the divider — which it does immediately,
    // since the divider is four pixels wide and the hand moves faster than that.
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(node.ratio);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const span = row ? box.width : box.height;
    if (span < 1) return;
    const at = row ? e.clientX - box.left : e.clientY - box.top;
    setDragging(clampRatio(at / span));
  };

  const onPointerUp = () => {
    if (dragging === null) return;
    onResize(path, dragging);
    setDragging(null);
  };

  return (
    <div ref={boxRef} className={`flex min-h-0 min-w-0 flex-1 ${row ? "flex-row" : "flex-col"}`}>
      <div style={{ flexBasis: `${ratio * 100}%` }} className="flex min-h-0 min-w-0 flex-shrink flex-grow-0">
        <PaneTree node={node.a} path={`${path ? `${path}.` : ""}a`} onResize={onResize} renderPane={renderPane} />
      </div>

      {/* The divider. One pixel of layout drawn in the border colour, with a grab area either side
          that costs none — the same trade `ResizeHandle` makes for the app's panel seams, and the
          same reason: a one-pixel target is unusable, and widening the line itself would put a grey
          band between two terminals. Goes accent while held so the pane edges are legible during
          the drag, when they are the only feedback there is. */}
      <div
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`group relative z-10 shrink-0 ${row ? "w-px cursor-col-resize" : "h-px cursor-row-resize"}`}
        style={{ background: dragging !== null ? "var(--cf-accent)" : "var(--cf-border)" }}
      >
        <span
          aria-hidden
          className={`absolute ${row ? "inset-y-0 -left-1 -right-1" : "inset-x-0 -top-1 -bottom-1"}`}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1">
        <PaneTree node={node.b} path={`${path ? `${path}.` : ""}b`} onResize={onResize} renderPane={renderPane} />
      </div>
    </div>
  );
}
