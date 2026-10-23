/**
 * What the canvas's pieces share while a gesture is under way: which nodes are moving (their lines
 * stop following the routed path and track the pointer instead), and the actions a node needs to
 * reach the canvas — a zone's resize, a library item's drop.
 */
import { createContext, useContext } from "react";
import { create } from "zustand";
import type { Category, ZoneStyle } from "../../../lib/architecture/types";

interface DragState {
  /** Nodes being dragged, and everything inside a dragged zone. */
  moving: Set<string>;
  /** Cleared when the next scene arrives, so a line never snaps back to its old route for a frame. */
  settling: boolean;
  setMoving: (ids: Set<string>) => void;
  settle: () => void;
  clear: () => void;
}

export const useArchDragStore = create<DragState>((set) => ({
  moving: new Set(),
  settling: false,
  setMoving: (moving) => set({ moving, settling: false }),
  settle: () => set({ settling: true }),
  clear: () => set({ moving: new Set(), settling: false }),
}));

/** What `carryOver` reads of a React Flow node. */
interface Carried {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  dragging?: boolean;
}

/**
 * The nodes a new scene brings, with what React Flow already learned of the ones on the canvas.
 *
 * - **Their measured size.** A node handed over without `measured` makes React Flow forget where its
 *   dots are and measure it again. WebKit (the app's webview on macOS) never gets round to it, so
 *   after the first edit no line was drawn (an edge needs both ends' dots) and no dot could be grabbed.
 *   A size that really changed is still measured: the node stays observed, and its new box fires.
 * - **Where a node being dragged is now.** A scene that lands mid-drag (the previous drop's, say) would
 *   otherwise throw the card back to the document's place under the pointer.
 */
export function carryOver<N extends Carried>(next: N[], prev: readonly N[]): N[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const old = before.get(n.id);
    if (!old || (!old.measured && !old.dragging)) return n;
    const kept: N = { ...n };
    if (old.measured) kept.measured = old.measured;
    if (old.dragging) {
      kept.position = old.position;
      kept.dragging = true;
    }
    return kept;
  });
}

/** Something from the component library, on its way to the canvas. */
export type LibraryItem =
  | { kind: "component"; icon: string; name: string; type?: string; category: Category }
  | { kind: "zone"; style: ZoneStyle; icon?: string; title: string };

export interface CanvasActions {
  resizeZone: (id: string, x: number, y: number, w: number, h: number) => void;
  /** Drops an item at a screen point — `false` when the point is not over the canvas. */
  dropAt: (item: LibraryItem, clientX: number, clientY: number) => boolean;
  /** Adds an item in the middle of what is on screen (a click rather than a drag). */
  addCentered: (item: LibraryItem) => void;
  isOverCanvas: (clientX: number, clientY: number) => boolean;
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null);
export const useCanvasActions = () => useContext(CanvasActionsContext);
