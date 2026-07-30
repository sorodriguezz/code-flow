import { create } from "zustand";

import type { DbKind } from "../types/database";

/**
 * Which of the database workspace's modals is on screen.
 *
 * Same reasoning as `apiModalStore`: they are opened from places that can't see each other — the
 * explorer header, a connection's context menu, the empty state, and a console's toolbar — and the
 * connection dialog has to outlive the menu that opened it. `DatabaseView` is the sole renderer.
 */
export type DbModal =
  /** The connection dialog on a blank form for an engine already chosen. The engine is picked
   * *before* the dialog opens — from the menu the `+` expands — because it decides what every field
   * in the dialog means, and a dialog that opens on Postgres when you came for IRIS asks you to
   * undo a choice you never made. */
  | { kind: "newConnection"; engine: DbKind }
  /** The connection dialog on an existing connection. */
  | { kind: "connection"; connectionId: string }
  /** The connection dialog with nothing in particular selected — "manage my connections", which is
   * how it opens from the workspace rather than from one connection's menu. */
  | { kind: "connections" }
  /** One cell's full value, for the ones a grid row can't show. */
  | { kind: "cell"; column: string; value: string | null; editable: boolean; onSave?: (value: string | null) => void }
  /** The statements a pending batch of edits would run, before it runs them. */
  | { kind: "preview"; title: string; statements: string[]; onConfirm: () => void };

interface DbModalState {
  modal: DbModal | null;
  openDbModal: (modal: DbModal) => void;
  closeDbModal: () => void;
}

export const useDbModalStore = create<DbModalState>((set) => ({
  modal: null,
  openDbModal: (modal) => set({ modal }),
  closeDbModal: () => set({ modal: null }),
}));
