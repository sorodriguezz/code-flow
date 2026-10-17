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

import { Bug, Check, Copy, CornerUpLeft, ExternalLink, FileDown, Files, GitBranchPlus, GitCommitVertical, GitCompareArrows, GitMerge, GitPullRequestArrow, LogIn, Pencil, RotateCcw, SkipForward, Tag, Trash2, Unlink, Upload } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import type { MenuItem } from "../common/ContextMenu";
import type { CommitInfo, CommitRef } from "../../types/domain";
import type { Translate } from "../../state/languageStore";

export interface CommitMenuContext {
  commit: CommitInfo;
  /** The commit HEAD points at — amend is offered on this one and no other. */
  headCommitId: string | null;
  /** Anything staged or modified. Revert and cherry-pick are inert while this is true. */
  dirty: boolean;
  t: Translate;
  onCopyHash: (commit: CommitInfo) => void;
  /** Every file the commit touched in one scroll — `MultiDiffModal`. */
  onOpenAllChanges?: (commit: CommitInfo) => void;
  onCopyMessage: (commit: CommitInfo) => void;
  onBranchHere: (commit: CommitInfo) => void;
  onTag: (commit: CommitInfo) => void;
  onAmend: () => void;
  onRevert: (commit: CommitInfo) => void;
  onCherryPick: (commit: CommitInfo) => void;
  /** A bisect is running — the entries mark this commit instead of starting one. */
  bisectActive: boolean;
  onBisect: (commit: CommitInfo, verdict: "good" | "bad" | "skip") => void;
  onReset: (commit: CommitInfo, mode: "soft" | "mixed" | "hard") => void;
  onCheckout: (commit: CommitInfo) => void;
  /** Absent when no remote can be read as a web page. */
  onOpenOnRemote?: (commit: CommitInfo) => void;
  onCopyLink?: (commit: CommitInfo) => void;
  /** Absent outside a repository linked to a project (the chat is a project's). */
  onExplain?: (commit: CommitInfo) => void;
  onSavePatch: (commit: CommitInfo) => void;
  onCopyPatch: (commit: CommitInfo) => void;
  onRebaseFrom: (commit: CommitInfo) => void;
  /** The commit already selected, which this one can be compared with — null when none is. */
  compareWith: CommitInfo | null;
  onCompare: (a: CommitInfo, b: CommitInfo) => void;
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
    ...(context.onCopyLink
      ? [{ label: t("graph.menuCopyLink"), icon: Copy, onClick: () => context.onCopyLink?.(commit) }]
      : []),
    ...(context.onOpenOnRemote
      ? [{ label: t("graph.menuOpenOnRemote"), icon: ExternalLink, onClick: () => context.onOpenOnRemote?.(commit) }]
      : []),
    {
      label: t("graph.menuPatch"),
      icon: FileDown,
      onClick: () => {},
      children: [
        { label: t("graph.menuSavePatch"), icon: FileDown, onClick: () => context.onSavePatch(commit) },
        { label: t("graph.menuCopyPatch"), icon: Copy, onClick: () => context.onCopyPatch(commit) },
      ],
    },
    ...(context.onOpenAllChanges
      ? [{ label: t("graph.menuOpenAllChanges"), icon: Files, onClick: () => context.onOpenAllChanges?.(commit) }]
      : []),
    ...(context.onExplain
      ? [{ label: t("graph.menuExplain"), icon: AiSparkles, onClick: () => context.onExplain?.(commit) }]
      : []),
    ...(context.compareWith && context.compareWith.id !== commit.id
      ? [
          {
            label: t("graph.menuCompare", { id: context.compareWith.short_id }),
            icon: GitCompareArrows,
            onClick: () => context.compareWith && context.onCompare(context.compareWith, commit),
          },
        ]
      : []),
    {
      label: t("graph.menuCheckout"),
      icon: Unlink,
      separated: true,
      disabled: isHead,
      onClick: () => context.onCheckout(commit),
    },
    {
      label: t("graph.menuBranchHere"),
      icon: GitBranchPlus,
      onClick: () => context.onBranchHere(commit),
    },
    {
      label: t("graph.menuTag"),
      icon: Tag,
      onClick: () => context.onTag(commit),
    },
  ];

  // Only on HEAD: anywhere else an edit is a rebase, which is the «Rebase interactivo» entry below.
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

  items.push(
    {
      label: t("graph.menuReset"),
      icon: RotateCcw,
      separated: true,
      disabled: isHead,
      onClick: () => {},
      children: [
        { label: t("graph.resetSoft"), onClick: () => context.onReset(commit, "soft") },
        { label: t("graph.resetMixed"), onClick: () => context.onReset(commit, "mixed") },
        { label: t("graph.resetHard"), danger: true, onClick: () => context.onReset(commit, "hard") },
      ],
    },
    {
      label: dirty ? t("graph.menuRebaseDirty") : t("graph.menuRebaseFrom"),
      icon: GitPullRequestArrow,
      disabled: dirty || isHead,
      onClick: () => context.onRebaseFrom(commit),
    },
  );

  // Bisect is started from the graph: say one commit is bad (or good), then the other end, and git
  // takes it from there. While one runs the same entries mark commits instead — see `git/bisect.rs`.
  items.push(
    {
      label: context.bisectActive ? t("bisect.menuMarkBad") : t("bisect.menuStartBad"),
      icon: Bug,
      separated: true,
      onClick: () => context.onBisect(commit, "bad"),
    },
    {
      label: context.bisectActive ? t("bisect.menuMarkGood") : t("bisect.menuStartGood"),
      icon: Check,
      onClick: () => context.onBisect(commit, "good"),
    },
  );
  if (context.bisectActive) {
    items.push({
      label: t("bisect.menuSkip"),
      icon: SkipForward,
      onClick: () => context.onBisect(commit, "skip"),
    });
  }

  return items;
}

export interface RefMenuContext {
  commitRef: CommitRef;
  /** The checked-out branch, null on a detached HEAD. */
  currentBranch: string | null;
  t: Translate;
  onCopyName: (name: string) => void;
  onCheckout: (ref: CommitRef) => void;
  onMerge: (ref: CommitRef) => void;
  onRebaseOnto: (ref: CommitRef) => void;
  onRename: (name: string) => void;
  onPush: (ref: CommitRef) => void;
  onDelete: (ref: CommitRef) => void;
}

/**
 * What right-clicking a branch, remote or tag chip on the graph offers — the verbs of the sidebar's
 * branch list, where the branch is drawn. Merge and rebase act on the *checked-out* branch, as git
 * does, and are absent on the chip of that branch itself.
 */
export function refMenuItems(context: RefMenuContext): MenuItem[] {
  const { commitRef, currentBranch, t } = context;
  const { name, kind } = commitRef;
  const isCurrent = kind === "branch" && name === currentBranch;
  const items: MenuItem[] = [{ label: t("graph.refCopyName"), icon: Copy, onClick: () => context.onCopyName(name) }];
  if (!isCurrent) {
    items.push({
      label: kind === "tag" ? t("graph.refCheckoutTag") : t("graph.refCheckout"),
      icon: LogIn,
      separated: true,
      onClick: () => context.onCheckout(commitRef),
    });
  }
  if (kind !== "tag" && !isCurrent && currentBranch) {
    items.push(
      {
        label: t("graph.refMerge", { name, current: currentBranch }),
        icon: GitMerge,
        onClick: () => context.onMerge(commitRef),
      },
      {
        label: t("graph.refRebaseOnto", { name, current: currentBranch }),
        icon: GitPullRequestArrow,
        onClick: () => context.onRebaseOnto(commitRef),
      },
    );
  }
  if (kind === "branch") {
    items.push({ label: t("graph.refRename"), icon: Pencil, separated: true, onClick: () => context.onRename(name) });
  }
  if (kind !== "remote") {
    items.push({
      label: kind === "tag" ? t("graph.refPushTag") : t("graph.refPush"),
      icon: Upload,
      separated: kind === "tag",
      onClick: () => context.onPush(commitRef),
    });
  }
  if (!isCurrent) {
    items.push({
      label: kind === "remote" ? t("graph.refDeleteRemote") : kind === "tag" ? t("graph.refDeleteTag") : t("graph.refDelete"),
      icon: Trash2,
      danger: true,
      separated: true,
      onClick: () => context.onDelete(commitRef),
    });
  }
  return items;
}
