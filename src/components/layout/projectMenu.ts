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
  Code2,
  Copy,
  ExternalLink,
  FolderInput,
  FolderOpen,
  FolderTree,
  GitBranchPlus,
  Palette,
  PanelRightOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import { WORKSPACE_COLORS } from "../../lib/workspaceColors";
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
  /** Absent where the repository is not the open one: a branch is made in the repository on screen. */
  onNewBranch?: () => void;
  onSettings: () => void;
  onRemove: () => void;
  /** The rest are offered where the caller wires them — the unfolded row and the folded chip both
   *  do, so folding the panel no longer takes verbs away. */
  onOpenVsCode?: () => void;
  onRename?: () => void;
  onColor?: (color: string) => void;
  pinned?: boolean;
  onTogglePin?: () => void;
  groups?: { id: string; name: string }[];
  groupId?: string | null;
  onSetGroup?: (groupId: string | null) => void;
  onNewGroup?: () => void;
  /** Absent when there is no other workspace to move it to. */
  onMove?: () => void;
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

  if (context.onOpenVsCode) {
    items.push({ label: t("sidebar.openInVsCode"), icon: Code2, disabled: broken, onClick: context.onOpenVsCode });
  }

  const arrange: MenuItem[] = [];
  if (context.onRename) arrange.push({ label: t("sidebar.menuRename"), icon: Pencil, onClick: context.onRename });
  if (context.onColor) {
    const pick = context.onColor;
    arrange.push({
      label: t("sidebar.menuColor"),
      icon: Palette,
      onClick: () => {},
      children: WORKSPACE_COLORS.map((color) => ({
        label: color,
        swatch: color,
        checked: color.toLowerCase() === context.project.color.toLowerCase(),
        onClick: () => pick(color),
      })),
    });
  }
  if (context.onTogglePin) {
    arrange.push({
      label: context.pinned ? t("sidebar.menuUnpin") : t("sidebar.menuPin"),
      icon: context.pinned ? PinOff : Pin,
      onClick: context.onTogglePin,
    });
  }
  if (context.onSetGroup) {
    const setGroup = context.onSetGroup;
    arrange.push({
      label: t("sidebar.menuGroup"),
      icon: FolderTree,
      onClick: () => {},
      children: [
        ...(context.groups ?? []).map((group) => ({
          label: group.name,
          disabled: group.id === context.groupId,
          onClick: () => setGroup(group.id),
        })),
        ...(context.groupId ? [{ label: t("sidebar.menuNoGroup"), onClick: () => setGroup(null) }] : []),
        ...(context.onNewGroup ? [{ label: t("sidebar.menuNewGroup"), icon: Plus, separated: true, onClick: context.onNewGroup }] : []),
      ],
    });
  }
  if (context.onMove) arrange.push({ label: t("sidebar.moveToWorkspace"), icon: FolderInput, onClick: context.onMove });
  if (arrange.length > 0) {
    arrange[0] = { ...arrange[0], separated: true };
    items.push(...arrange);
  }

  items.push(
    ...(context.onNewBranch
      ? [
          {
            label: t("sidebar.newBranch"),
            icon: GitBranchPlus,
            separated: true,
            disabled: broken,
            onClick: context.onNewBranch,
          },
        ]
      : []),
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
