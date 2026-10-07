import { create } from "zustand";

/**
 * Dragging a flow or a folder inside the Flows explorer.
 *
 * **Pointer events, not HTML5 drag-and-drop** — the constraint `diagramsDragStore` documents: Tauri's
 * native drag handler on the webview swallows `dragstart`. A separate store from every other tree's
 * for the reason that file gives: the gestures must never see each other's targets.
 *
 * The plan is resolved at hover time and stored, so the highlight under the pointer is by
 * construction the write a release performs. Folders here are one flat list, which makes the rules
 * simpler than the diagrams tree's: a flow is filed into a folder (or the top level) or placed next
 * to another flow; a folder is only ever placed next to another folder.
 */

export interface FlowsDrag {
  kind: "flow" | "folder";
  id: string;
  /** The folder it started in (`null` for the top level, and for any folder). */
  fromFolderId: string | null;
}

/** What releasing here would do. `null` is "nothing" — distinct from filing at the top level. */
export type FlowsDropPlan =
  /** File the flow into `folderId`, appended. `null` is the top level. */
  | { mode: "into"; folderId: string | null }
  /** Place it next to `anchorId` — a flow in `folderId`'s list, or a folder among folders. */
  | { mode: "order"; anchorId: string; after: boolean; folderId: string | null };

interface FlowsDragState {
  drag: FlowsDrag | null;
  over: FlowsDropPlan | null;
  /** Where the press began, so a click can be told from a drag. `null` once the drag is live. */
  origin: { x: number; y: number; drag: FlowsDrag } | null;

  press: (drag: FlowsDrag, x: number, y: number) => void;
  begin: () => void;
  hover: (plan: FlowsDropPlan | null) => void;
  end: () => void;
}

function planKey(plan: FlowsDropPlan | null): string {
  if (!plan) return "";
  return plan.mode === "into" ? `into:${plan.folderId ?? ""}` : `order:${plan.anchorId}:${plan.after}`;
}

export const useFlowsDragStore = create<FlowsDragState>((set, get) => ({
  drag: null,
  over: null,
  origin: null,

  press: (drag, x, y) => set({ origin: { x, y, drag } }),

  begin: () => {
    const origin = get().origin;
    if (!origin || get().drag) return;
    set({ drag: origin.drag, origin: null });
  },

  // Guarded twice, as in `diagramsDragStore`: nothing is tracked without a live drag, and an
  // unchanged plan is not written — rows call this on every `pointermove`.
  hover: (plan) => {
    if (!get().drag) return;
    if (planKey(get().over) === planKey(plan)) return;
    set({ over: plan });
  },

  end: () => set({ drag: null, over: null, origin: null }),
}));

/** Which half of a row the pointer is in — every row here is two zones, above and below. */
export function halfAt(offsetY: number, height: number): "before" | "after" {
  return height > 0 && offsetY / height >= 0.5 ? "after" : "before";
}

/**
 * What a release over a row would write, or `null` for nothing. Pure, and used for the highlight
 * and for the write alike.
 *
 * - **A flow over a folder's header** files it into that folder — the whole row, since a folder's
 *   place among folders is not somewhere a flow can go.
 * - **A flow over a flow** of this workspace is placed next to it, in that flow's list. Over a global
 *   flow of another workspace — drawn at the top level, but ordered in its home — it is filed at the
 *   top level instead.
 * - **A folder over a folder** is placed before or after it. Over anything else it does nothing.
 */
export function planDrop(
  drag: FlowsDrag,
  target:
    | { kind: "folder"; id: string }
    | { kind: "flow"; id: string; folderId: string | null; own: boolean },
  half: "before" | "after",
): FlowsDropPlan | null {
  if (drag.id === target.id) return null;
  if (drag.kind === "folder") {
    return target.kind === "folder"
      ? { mode: "order", anchorId: target.id, after: half === "after", folderId: null }
      : null;
  }
  if (target.kind === "folder") return { mode: "into", folderId: target.id };
  if (!target.own) return { mode: "into", folderId: null };
  return { mode: "order", anchorId: target.id, after: half === "after", folderId: target.folderId };
}
