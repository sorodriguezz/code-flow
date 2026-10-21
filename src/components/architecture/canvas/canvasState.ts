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
