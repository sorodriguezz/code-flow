import { create } from "zustand";

export type LineEnding = "LF" | "CRLF";

/**
 * What the Editor's status line says about the file in the focused pane — caret, indentation, line
 * endings, language (the user's ask, 2026-09-25, VS Code's bar as the reference). See
 * `EditorStatusLine` for the reader and `useEditorStatus` for the one writer.
 *
 * `cursorBlameStore`'s shape and for its reasons: the caret moves at key-repeat rate, so this is a
 * store of its own that only the status line subscribes to, it holds exactly **one** entry — the
 * focused pane's — and writes that change nothing are dropped before zustand hears of them, so
 * moving along a line re-renders one small bar and nothing else.
 */
export interface EditorStatus {
  groupId: string;
  path: string;
  /** The file's model path — the key a language picked by hand is filed under
   *  (`languageOverrideStore`). */
  fileKey: string;
  line: number;
  column: number;
  /** Characters selected across every selection; 0 for a bare caret. */
  selected: number;
  /** How many carets there are; 1 unless multi-cursor editing is in play. */
  cursors: number;
  tabSize: number;
  insertSpaces: boolean;
  eol: LineEnding;
  languageId: string;
  /** Monaco's display name for it — "TypeScript", "HTML" — or the id when it has none. */
  languageName: string;
}

/**
 * What the status line can ask the focused pane to do. Built once per editor instance, so its
 * identity is stable and a same-status write still bails out.
 */
export interface EditorStatusActions {
  goToLine: () => void;
  /** Converts the whole buffer; the file is dirty afterwards and saves with the new endings. */
  setEol: (eol: LineEnding) => void;
  /** How *new* indentation is typed, as VS Code's "Indent Using…" does; existing lines are kept. */
  setIndentation: (insertSpaces: boolean, tabSize: number) => void;
  /** Guess both again from what the file already contains. */
  detectIndentation: () => void;
  /** Rewrite the leading whitespace of every line to spaces or to tabs. */
  convertIndentation: (toSpaces: boolean) => void;
}

interface EditorStatusState {
  status: EditorStatus | null;
  actions: EditorStatusActions | null;
  publish: (status: EditorStatus, actions: EditorStatusActions) => void;
  /** Guarded: only clears if this group is the one currently showing, as `cursorBlameStore.clear`. */
  clear: (groupId: string) => void;
}

function sameStatus(a: EditorStatus, b: EditorStatus): boolean {
  return (
    a.groupId === b.groupId &&
    a.path === b.path &&
    a.fileKey === b.fileKey &&
    a.line === b.line &&
    a.column === b.column &&
    a.selected === b.selected &&
    a.cursors === b.cursors &&
    a.tabSize === b.tabSize &&
    a.insertSpaces === b.insertSpaces &&
    a.eol === b.eol &&
    a.languageId === b.languageId &&
    a.languageName === b.languageName
  );
}

export const useEditorStatusStore = create<EditorStatusState>((set, get) => ({
  status: null,
  actions: null,

  publish: (status, actions) => {
    const current = get();
    if (current.status && current.actions === actions && sameStatus(current.status, status)) return;
    set({ status, actions });
  },

  clear: (groupId) => {
    if (get().status?.groupId === groupId) set({ status: null, actions: null });
  },
}));
