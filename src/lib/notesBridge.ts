import { readFileText } from "./tauri/commands";
import { notesLinkFile } from "./tauri/notesCommands";
import { focusSatellite } from "./tauri/windows";
import { broadcast } from "./windowBus";
import { isMainWindow, MAIN_LABEL, WINDOW } from "./windowIdentity";
import { noteFromMarkdownFile } from "./notes/importMarkdown";
import { serializeTags } from "./notes/tags";
import { useUiStore } from "../state/uiStore";
import { useWindowStore } from "../state/windowStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { pushErrorToast } from "../state/toastStore";

/**
 * "Send to Notes": the bridge between a Markdown file in a repository and the Notes app — the notes
 * twin of `dbmlBridge.ts`, with the same two halves.
 *
 * **The note is the file.** Sending one does not import it: it files the file itself as a note — a
 * row whose `origin_path` names it — and from then on every save of the note writes the file and
 * every open re-reads it (`notes_save_note`, `notes_pull_file`). A note made in the app and then
 * "saved in a repository" ends in the same shape; this is the other way in. Sending the same file
 * twice reaches the same note.
 *
 * **Where the note opens** follows `dbmlBridge`'s rule: wherever the Notes app already is — its own
 * window when it has been detached, otherwise the main window's rail; a repository window, which has
 * no rail, hands it to the main one.
 */

/** Whether a path is a Markdown file this bridge carries — the extensions "Import Markdown" reads. */
export function isMarkdownPath(path: string | null | undefined): boolean {
  return Boolean(path && /\.(md|markdown|mdown)$/i.test(path));
}

/**
 * Shows a note in *this* window, workspace and all — the receiving end of the routing below, and the
 * local path when the Notes app is here. Crosses workspaces when it has to, as a recorded choice, for
 * the reason `showDiagramHere` gives.
 */
export async function showNoteHere(workspaceId: string, noteId: string): Promise<void> {
  // Imported here, not at the top, for the reason `showDiagramHere` gives: both entry points listen
  // for the message, and a static edge would pull the notes store into windows that never show one.
  const { useNotesStore } = await import("../state/notesStore");

  const workspace = useWorkspaceStore.getState();
  if (workspace.activeWorkspaceId !== workspaceId) workspace.setActiveWorkspace(workspaceId);
  const notes = useNotesStore.getState();
  if (notes.workspaceId !== workspaceId) {
    await notes.setWorkspace(workspaceId);
  } else {
    // The tree even when the workspace matches: the note, and its repository's book, may have been
    // made a moment ago by the window that sent us here.
    await notes.refresh();
  }
  if (isMainWindow()) useUiStore.getState().setActiveView("notes");

  // Already the open note: `openNote` would do nothing, and the file may have just changed (it was
  // saved before it was sent). `syncFromDisk` brings a clean draft up to date and leaves unsaved
  // edits alone.
  const store = useNotesStore.getState();
  if (store.activeId === noteId && store.draft?.id === noteId) {
    await store.syncFromDisk(noteId);
    return;
  }
  await store.openNote(noteId);
}

/**
 * Files a Markdown file as a note that mirrors it, and puts the note on screen wherever the Notes
 * app lives. Answers whether the note exists; a failure has already been reported.
 *
 * The title and the tags come from the file's front matter, or the file's name — the reading
 * "Import Markdown" gives a file (`noteFromMarkdownFile`). The body is read again by the backend,
 * exactly as it is on disk, because every save writes it back.
 *
 * The caller owns the buffer: a tab with unsaved edits must be written first, or the note opens on
 * the file as it was. `EditorView` does that.
 */
export async function sendToNotes(args: {
  workspaceId: string;
  projectId: string;
  repoPath: string;
  relPath: string;
}): Promise<boolean> {
  let noteId: string;
  try {
    const text = await readFileText(args.repoPath, args.relPath);
    const fileName = args.relPath.split("/").pop() ?? args.relPath;
    const { title, tags } = noteFromMarkdownFile(fileName, text);
    const sync = await notesLinkFile(
      args.workspaceId,
      args.projectId,
      args.relPath,
      title,
      serializeTags(tags),
    );
    if (!sync.row) return false;
    noteId = sync.row.id;
  } catch (error) {
    pushErrorToast(String(error));
    return false;
  }

  const detached = useWindowStore.getState().detachedLabel("app", "notes");
  if (detached && detached !== WINDOW.label) {
    broadcast({ kind: "open-note", to: detached, workspaceId: args.workspaceId, noteId });
    await focusSatellite(detached).catch(() => {
      // Gone since the list was pushed: the note is filed either way, which is what had to happen.
    });
    return true;
  }

  if (isMainWindow() || detached === WINDOW.label) {
    await showNoteHere(args.workspaceId, noteId);
    return true;
  }

  broadcast({ kind: "open-note", to: MAIN_LABEL, workspaceId: args.workspaceId, noteId });
  broadcast({ kind: "focus-main" });
  return true;
}
