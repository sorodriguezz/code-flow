import { useEffect } from "react";
import { NotebookPen } from "lucide-react";
import { EmptyState } from "../common/EmptyState";
import { ResizeHandle } from "../common/ResizeHandle";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { NoteExplorer } from "./NoteExplorer";
import { NoteEditor } from "./NoteEditor";
import { NoteGallery } from "./NoteGallery";
import { CARD } from "./notesChrome";
import { ensureNotesStoreLoaded, useNotesStore } from "../../state/notesStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useT } from "../../state/languageStore";

/**
 * The Notes workspace's shell: the explorer, and whichever surface the selection calls for.
 *
 * It sits in the app rail below Remote rather than in the tab bar, for the same reason every app
 * on that rail does — a note belongs to the workspace, not to whichever repository happens to be
 * selected, and a tab beside Graph/Changes/Editor would imply it reloaded when you clicked a
 * different repo. Notes are the least repository-bound thing in the app: the decision you wrote
 * down last March is about the system, not about a checkout.
 *
 * **Unlike `RemoteView`, nothing here needs to stay mounted.** A remote session is a live pty whose
 * scrollback dies with the component; a note is a document, and the one piece of state that would
 * be lost — the unsaved draft — is written by `flush` on every path that could drop it (close,
 * switch, workspace change). So the editor is unmounted when no note is open, which is what lets
 * Monaco be lazily loaded and released rather than held for the session.
 */
export function NotesView() {
  const workspaceId = useNotesStore((s) => s.workspaceId);
  const loading = useNotesStore((s) => s.loading);
  const activeId = useNotesStore((s) => s.activeId);
  // A boolean, deliberately, and not `s.draft`. The draft object is replaced on every keystroke,
  // so subscribing to it would re-render this component — and therefore the whole explorer tree
  // beside it — once per character typed. All this view needs to know is whether a body has
  // arrived yet, and `Object.is` on a boolean is stable across every edit.
  const hasDraft = useNotesStore((s) => s.draft !== null);

  const sidebarWidth = useLayoutStore((s) => s.sizes.notesSidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  useEffect(() => {
    void ensureNotesStoreLoaded();
  }, []);

  // The unsaved draft, written when the view goes away — a workspace switch, a window close, the
  // user navigating to another app on the rail. `flush` is a no-op when nothing is dirty, so this
  // costs nothing in the common case and is the difference between losing a sentence and not in
  // the uncommon one.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void useNotesStore.getState().flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      void useNotesStore.getState().flush();
    };
  }, []);

  if (workspaceId === null) {
    return (
      <EmptyState
        icon={NotebookPen}
        title={t("notes.noWorkspaceTitle")}
        subtitle={t("notes.noWorkspaceSubtitle")}
      />
    );
  }

  return (
    <div className={`flex h-full min-h-0 ${CARD}`} data-tour="notes-view">
      <div
        style={{ width: sidebarWidth }}
        className="flex shrink-0 flex-col border-r border-[var(--cf-border)]"
      >
        {loading ? <ViewSkeleton /> : <NoteExplorer />}
      </div>

      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={200}
        max={480}
        onChange={(value) => setSize("notesSidebarWidth", value)}
        onCommit={(value) => commitSize("notesSidebarWidth", value)}
      />

      <div className="min-w-0 flex-1">
        {activeId === null ? (
          <NoteGallery />
        ) : !hasDraft ? (
          // The body is still in flight. A skeleton rather than the gallery, because falling back
          // to the gallery for two frames makes clicking a note look like it did nothing.
          <ViewSkeleton />
        ) : (
          // Deliberately **not** keyed on the note id. Keying would remount the editor on every
          // switch, and remounting `@monaco-editor/react` disposes its model — throwing away the
          // undo history and the view state that `NoteMonaco`'s per-note `path` exists to keep.
          // Switching notes changes the `path` prop instead, which is the swap Monaco is built for.
          <NoteEditor />
        )}
      </div>
    </div>
  );
}
