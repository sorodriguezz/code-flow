import { create } from "zustand";

/**
 * Which operation a confirmation is about. Drives the icons and the tone of the little animated
 * diagram in the modal — the point being that "merge X into Y" is a sentence you can read the
 * wrong way round, while an arrow from one branch pill into another is not.
 */
export type ConfirmFlowKind =
  | "merge"
  | "detach"
  | "checkout"
  | "branch-create"
  | "branch-delete"
  | "stash-apply"
  | "stash-pop"
  | "stash-drop"
  // Not a git operation, but the same "out of here, into there" question — and the same reason for
  // drawing it: which workspace a project ends up in is exactly what a sentence gets to bury.
  | "workspace-move";

export interface ConfirmFlow {
  kind: ConfirmFlowKind;
  /** Left node: where the change comes from (the branch being merged in, the stash applied…). */
  source: string;
  /** Right node: what the action actually modifies. Highlighted — it's the side at risk. */
  target: string;
  /** Optional line under the diagram, for the consequence the diagram can't draw. */
  note?: string;
}

interface ConfirmRequest {
  message: string;
  danger: boolean;
  /** Overrides the generic "Confirm" button label when naming the action is clearer. */
  confirmLabel?: string;
  flow?: ConfirmFlow;
  resolve: (value: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  ask: (request: Omit<ConfirmRequest, "resolve">) => Promise<boolean>;
  respond: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,

  ask: (request) =>
    new Promise<boolean>((resolve) => {
      // Asking again while a dialog is already up would drop the first promise on the floor and
      // hang whatever was awaiting it, so the pending one is answered "no" before being replaced.
      get().request?.resolve(false);
      set({ request: { ...request, resolve } });
    }),

  respond: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/** Drop-in replacement for `window.confirm()` that pops the app's own styled modal instead
 * of the browser-native dialog — every discard/delete action in the app should route
 * through this rather than rolling its own confirm UI. */
export const confirmAction = (message: string, danger = true, confirmLabel?: string) =>
  useConfirmStore.getState().ask({ message, danger, confirmLabel });

/** Same modal plus the animated `source → target` diagram — for the branch and stash operations
 * where which way round the change flows is the thing worth being sure about. */
export const confirmFlow = (args: {
  flow: ConfirmFlow;
  message: string;
  danger?: boolean;
  confirmLabel?: string;
}) =>
  useConfirmStore.getState().ask({
    message: args.message,
    danger: args.danger ?? false,
    confirmLabel: args.confirmLabel,
    flow: args.flow,
  });
