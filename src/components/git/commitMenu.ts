/**
 * What right-clicking a commit offers.
 *
 * The graph had no context menu at all — and because the app swallows the webview's own (see
 * `contextMenuGuard`), right-clicking a commit did nothing whatsoever. Every other tree in the app
 * has had one for a long time; this was an omission rather than a decision.
 *
 * A separate module from `GraphView` for the reason `hostMenu` and `cellMenu` are: the view is
 * already 800 lines of virtualised layout, and a list of verbs with their guards is a different kind
 * of thing that wants to be read on its own.
 *
 * **What is offered depends on the commit**, and the guards are the interesting part:
 *
 * - Amend is only ever on the *last* commit, because that is the only one git can rewrite without
 *   rebasing everything after it.
 * - Revert and cherry-pick refuse a dirty tree — checked here so the menu can grey the entry and
 *   say why, rather than letting the click fail with an error a second later.
 * - Both refuse merge commits, which the backend also refuses; the menu just says so first.
 */

import {
  Copy,
  CornerUpLeft,
  GitBranchPlus,
  GitCommitVertical,
  Pencil,
  Tag,
} from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import type { CommitInfo } from "../../types/domain";
import type { Translate } from "../../state/languageStore";

export interface CommitMenuContext {
  commit: CommitInfo;
  /** The commit HEAD points at — amend is offered on this one and no other. */
  headCommitId: string | null;
  /** Anything staged or modified. Revert and cherry-pick are inert while this is true. */
  dirty: boolean;
  t: Translate;
  onCopyHash: (commit: CommitInfo) => void;
  onCopyMessage: (commit: CommitInfo) => void;
  onBranchHere: (commit: CommitInfo) => void;
  onTag: (commit: CommitInfo) => void;
  onAmend: () => void;
  onRevert: (commit: CommitInfo) => void;
  onCherryPick: (commit: CommitInfo) => void;
}

export function commitMenuItems(context: CommitMenuContext): MenuItem[] {
  const { commit, headCommitId, dirty, t } = context;
  const isHead = headCommitId !== null && commit.id === headCommitId;
  const isMerge = commit.parent_ids.length > 1;

  const items: MenuItem[] = [
    {
      label: t("graph.menuCopyHash"),
      icon: Copy,
      onClick: () => context.onCopyHash(commit),
    },
    {
      label: t("graph.menuCopyMessage"),
      icon: Copy,
      onClick: () => context.onCopyMessage(commit),
    },
    {
      label: t("graph.menuBranchHere"),
      icon: GitBranchPlus,
      separated: true,
      onClick: () => context.onBranchHere(commit),
    },
    {
      label: t("graph.menuTag"),
      icon: Tag,
      onClick: () => context.onTag(commit),
    },
  ];

  // Only on HEAD. Anywhere else it would mean a rebase, which this app deliberately does not do —
  // see the header of `git/history.rs`.
  if (isHead) {
    items.push({
      label: t("graph.menuAmend"),
      icon: Pencil,
      separated: true,
      onClick: context.onAmend,
    });
  }

  items.push({
    // Disabled entries stay in the list rather than disappearing: a menu whose length changes with
    // the state of the working tree is one you cannot learn the shape of.
    label: isMerge
      ? t("graph.menuRevertMerge")
      : dirty
        ? t("graph.menuRevertDirty")
        : t("graph.menuRevert"),
    icon: CornerUpLeft,
    separated: !isHead,
    disabled: dirty || isMerge,
    onClick: () => context.onRevert(commit),
  });

  items.push({
    label: isMerge
      ? t("graph.menuCherryPickMerge")
      : dirty
        ? t("graph.menuCherryPickDirty")
        : t("graph.menuCherryPick"),
    icon: GitCommitVertical,
    disabled: dirty || isMerge || isHead,
    onClick: () => context.onCherryPick(commit),
  });

  return items;
}
