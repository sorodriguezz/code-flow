import { create } from "zustand";
import { focusedCodeEditor } from "../components/editor/pasteJsonAsCode";
import { useEditorStatusStore } from "../state/editorStatusStore";
import { useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pushErrorToast } from "../state/toastStore";
import { translate } from "../state/languageStore";

/**
 * A code block of the repository chat, sent to the editor — the two buttons `ChatMessageBubble` puts
 * on a block's bar when the chat gives it a `CodeBlockTarget`.
 *
 * - **Insert** types it at the caret of the focused pane, replacing the selection — one edit, so one
 *   ⌘Z takes it back, and the file is dirty rather than saved: the user decides.
 * - **Apply** opens `ApplyCodeModal`: the block against the file it names (or the one on screen) as a
 *   diff the user can edit before writing it.
 *
 * Only into this repository: the editor follows the active project, and a block from one
 * repository's chat typed into another's file is never what was meant.
 */

export function insertCodeAtCaret(projectId: string, code: string): void {
  const editor = focusedCodeEditor();
  if (!editor || useWorkspaceStore.getState().activeProjectId !== projectId) {
    pushErrorToast(translate("chat.insertCodeNoEditor"));
    return;
  }
  const selection = editor.getSelection();
  if (!selection) return;
  editor.pushUndoStop();
  editor.executeEdits("cf-chat-insert", [{ range: selection, text: code, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  useUiStore.getState().setActiveView("editor");
  editor.focus();
}

export interface ApplyCodeRequest {
  /** The chat tab that asked — the one that draws the dialog. */
  tabKey: string;
  projectId: string;
  code: string;
  /** Where it goes first: the block's own path, else the file on screen, else empty. */
  path: string;
}

interface ApplyCodeState {
  request: ApplyCodeRequest | null;
  open: (request: Omit<ApplyCodeRequest, "path"> & { path: string | null }) => void;
  close: () => void;
}

export const useApplyCodeStore = create<ApplyCodeState>((set) => ({
  request: null,
  open: ({ path, ...rest }) => {
    // A scratch tab's path starts with `/` and names no file of the repository.
    const shown = useEditorStatusStore.getState().status?.path;
    const onScreen =
      useWorkspaceStore.getState().activeProjectId === rest.projectId && shown && !shown.startsWith("/") ? shown : null;
    set({ request: { ...rest, path: path ?? onScreen ?? "" } });
  },
  close: () => set({ request: null }),
}));
