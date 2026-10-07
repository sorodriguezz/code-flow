import type { MenuItem } from "../common/ContextMenu";
import { repoMenuItems } from "../../lib/repoMenu";
import { useNotesStore } from "../../state/notesStore";

/**
 * A note's "Save in a repository" / "Unlink" rows, for the two menus that act on a note — the
 * explorer's and the editor's "More actions". Read from the store when the menu is built, so neither
 * menu's memoised callback has to depend on the note list.
 */
export function noteRepoItems(noteId: string): MenuItem[] {
  const { notes, workspaceId } = useNotesStore.getState();
  const note = notes.find((n) => n.id === noteId);
  if (!note) return [];
  return repoMenuItems({
    workspaceId,
    originPath: note.origin_path,
    // A global note of another workspace is on this shelf, but this workspace's repositories are
    // not its home's — see `RepoMenuArgs.own`.
    own: note.workspace_id === workspaceId,
    onSave: (projectId) => void useNotesStore.getState().saveToRepo(noteId, projectId),
    onUnlink: () => void useNotesStore.getState().unlinkFromRepo(noteId),
    separated: true,
  });
}
