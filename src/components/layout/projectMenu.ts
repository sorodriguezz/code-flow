/**
 * What right-clicking a repository in the sidebar offers.
 *
 * The sidebar had no context menu at all, and because the app swallows the webview's own (see
 * `contextMenuGuard`), right-clicking a repository did nothing whatsoever — while every tree in
 * the API client, the editor, the database workspace and the keyring had had one for a long time.
 *
 * The row's hover strip keeps the two verbs it has room for; this is where the rest live. Nothing
 * here is destructive to the working copy: "remove" takes the repository off the list and leaves
 * every file where it is, which is what its confirmation says.
 */

import {
  Copy,
  ExternalLink,
  FolderOpen,
  GitBranchPlus,
  PanelRightOpen,
  Settings2,
  Trash2,
} from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import type { Project } from "../../types/domain";
import type { Translate } from "../../state/languageStore";

export interface ProjectMenuContext {
  project: Project;
  /** The folder is gone, or is no longer a repository. Most verbs mean nothing then. */
  broken: boolean;
  /** Already showing in a window of its own — "open" then means "bring that window forward". */
  detached: boolean;
  t: Translate;
  onOpen: () => void;
  onDetach: () => void;
  onFocusWindow: () => void;
  onReveal: () => void;
  onCopyPath: () => void;
  onNewBranch: () => void;
  onSettings: () => void;
  onRemove: () => void;
}

export function projectMenuItems(context: ProjectMenuContext): MenuItem[] {
  const { broken, detached, t } = context;

  const items: MenuItem[] = [
    detached
      ? {
          label: t("windows.focusWindow"),
          icon: ExternalLink,
          onClick: context.onFocusWindow,
        }
      : {
          label: t("sidebar.menuOpen"),
          icon: FolderOpen,
          disabled: broken,
          onClick: context.onOpen,
        },
  ];

  if (!detached) {
    items.push({
      label: t("windows.openInWindow"),
      icon: PanelRightOpen,
      disabled: broken,
      onClick: context.onDetach,
    });
  }

  items.push(
    {
      label: t("sidebar.newBranch"),
      icon: GitBranchPlus,
      separated: true,
      disabled: broken,
      onClick: context.onNewBranch,
    },
    {
      // Works even on a broken row, and deliberately: "the folder is gone" is exactly when somebody
      // wants to go and look at where it was.
      label: t("sidebar.menuReveal"),
      icon: FolderOpen,
      separated: true,
      onClick: context.onReveal,
    },
    {
      label: t("sidebar.menuCopyPath"),
      icon: Copy,
      onClick: context.onCopyPath,
    },
    {
      label: t("sidebar.menuSettings"),
      icon: Settings2,
      onClick: context.onSettings,
    },
    {
      label: t("sidebar.menuRemove"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: context.onRemove,
    },
  );

  return items;
}
