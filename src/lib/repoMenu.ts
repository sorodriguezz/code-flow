import { GitBranch, Unlink } from "lucide-react";
import type { MenuItem } from "../components/common/ContextMenu";
import { confirmAction } from "../state/confirmStore";
import { translate } from "../state/languageStore";
import { useWorkspaceStore } from "../state/workspaceStore";

/**
 * The repository half of a document's context menu — a diagram's or a note's — built the way the
 * Flows explorer builds its own: "Save in a repository" with the workspace's repositories as a
 * submenu, or, once the document mirrors a file, the way back out.
 *
 * Shared because the two apps have to say the same thing about the same feature: a document saved in
 * a repository is a mirror of its file in either of them (see `repo_files.rs`), and a menu that
 * worded it two ways would be describing two features.
 */
export interface RepoMenuArgs {
  workspaceId: string | null;
  /** The repository file the document mirrors, or empty when it lives only in the app. */
  originPath: string;
  /**
   * Whether the document belongs to the workspace on screen. A global one from another workspace
   * is offered no repository: the list here is this workspace's, and saving into one of them would
   * tie the document to a checkout its home does not have.
   */
  own: boolean;
  onSave: (projectId: string) => void;
  onUnlink: () => void;
  separated?: boolean;
}

export function repoMenuItems({
  workspaceId,
  originPath,
  own,
  onSave,
  onUnlink,
  separated,
}: RepoMenuArgs): MenuItem[] {
  if (originPath) {
    return [
      {
        label: translate("repoSync.unlink"),
        icon: Unlink,
        separated,
        onClick: () => {
          void confirmAction(translate("repoSync.unlinkConfirm", { path: originPath })).then(
            (ok) => ok && onUnlink(),
          );
        },
      },
    ];
  }
  if (!own || !workspaceId) return [];
  // Read when the menu is built — on the right-click — rather than subscribed to: the menus are
  // built inside callbacks the trees memoise their rows on, which must not depend on this list.
  const projects = [...(useWorkspaceStore.getState().projectsByWorkspace[workspaceId] ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
  if (projects.length === 0) return [];
  return [
    {
      label: translate("repoSync.saveIn"),
      icon: GitBranch,
      separated,
      // A row with a submenu is never clicked itself — see `MenuItem.children`.
      onClick: () => {},
      children: projects.map((project) => ({
        label: project.name,
        onClick: () => onSave(project.id),
      })),
    },
  ];
}
