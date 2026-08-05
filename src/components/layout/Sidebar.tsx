import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Code2,
  Eye,
  Folder,
  FolderInput,
  GitBranch,
  GitBranchPlus,
  GitFork,
  GitMerge,
  GitPullRequest,
  Glasses,
  Globe,
  RefreshCw,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Trash2,
  Undo2,
  Unlink,
} from "lucide-react";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { useLayoutStore } from "../../state/layoutStore";
import { usePrStore } from "../../state/prStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import {
  pickFolder,
  scanFolder,
  type FoundRepo,
  revealInFileManager,
  openInVsCode,
  autoLinkProject,
  openRepoInBrowser,
} from "../../lib/tauri/commands";
import { loadGithubConnections } from "../../lib/githubConnections";
import { loadGitlabConnections } from "../../lib/gitlabConnections";
import { loadAdoConnections } from "../../lib/adoConnections";
import type {
  BranchInfo,
  GithubConnection,
  GitlabConnection,
  Project,
  PullRequestSummary,
  StashInfo,
  VcsProvider,
} from "../../types/domain";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { SkeletonRows } from "../common/Skeleton";
import { CloneRepoModal } from "./CloneRepoModal";
import { ImportReposModal } from "./ImportReposModal";
import { CreateBranchModal } from "./CreateBranchModal";
import { MoveProjectModal } from "./MoveProjectModal";
import { ConnectAdoModal } from "./ConnectAdoModal";
import { ConnectGithubModal } from "./ConnectGithubModal";
import { ConnectGitlabModal } from "./ConnectGitlabModal";
import { CreatePrModal } from "./CreatePrModal";
import { StashDiffModal } from "./StashDiffModal";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import type { TranslationKey } from "../../lib/i18n/translations";

// The hover-revealed actions on a project row: the same square chip the "clone"/"add repository"
// buttons above the list wear, so every icon-only control in the sidebar answers the pointer the
// same way. Reveal stays tied to the row's own `group` hover.
const ROW_ACTION_CLASS =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] opacity-0 hover:bg-black/[0.05] hover:text-[var(--cf-text)] group-hover:opacity-100 dark:hover:bg-white/[0.08]";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;

/** `defaultOpen` is the open one and only the open one: it's the group with work still in it, and
 * the reason the others fold is that merged and closed grow without bound (see `openGroups`). */
const PR_SECTIONS: { key: string; labelKey: TranslationKey; defaultOpen?: boolean }[] = [
  { key: "open", labelKey: "sidebar.openPRs", defaultOpen: true },
  { key: "draft", labelKey: "sidebar.draftPRs" },
  { key: "merged", labelKey: "sidebar.merged" },
  { key: "closed", labelKey: "sidebar.closed" },
];

function WorkspaceSwitcher() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const t = useT();

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  /**
   * Clicking anywhere else puts it away — it was staying open over whatever you clicked next.
   *
   * The half-typed name of a new workspace goes with it. Reopening to find a name you had already
   * abandoned, in a field you had already left, is worse than starting it again.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName("");
  }, []);
  useDismissOnOutside(open, dismiss, [rootRef]);

  return (
    <div ref={rootRef} className="relative mb-4 px-1">
      <button
        onClick={() => (open ? dismiss() : setOpen(true))}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
          style={{ background: active?.color ?? "#6366f1" }}
        >
          <Briefcase size={13} />
        </span>
        <span className="flex-1 truncate text-left text-sm font-semibold">{active?.name ?? "CodeFlow"}</span>
        <ChevronDown size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      {open && (
        <div className="absolute left-1 right-1 top-full z-20 mt-1 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => {
                setActiveWorkspace(ws.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
                ws.id === activeWorkspaceId
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ws.color }} />
              <span className="truncate">{ws.name}</span>
            </button>
          ))}

          {creating ? (
            <div className="flex items-center gap-1 px-1 py-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === "Enter" && newName.trim()) {
                    await addWorkspace(newName.trim(), "briefcase", "#6366f1");
                    setNewName("");
                    setCreating(false);
                  } else if (e.key === "Escape") {
                    setCreating(false);
                  }
                }}
                placeholder={t("sidebar.workspaceName")}
                className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
              <button
                onClick={async () => {
                  if (!newName.trim()) return;
                  await addWorkspace(newName.trim(), "briefcase", "#6366f1");
                  setNewName("");
                  setCreating(false);
                }}
                className="text-[var(--cf-accent)]"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Plus size={14} />
              {t("sidebar.newWorkspace")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StashesSection() {
  const stashes = useRepoStore((s) => s.stashes);
  const stashSave = useRepoStore((s) => s.stashSave);
  const stashApply = useRepoStore((s) => s.stashApply);
  const stashPop = useRepoStore((s) => s.stashPop);
  const stashDrop = useRepoStore((s) => s.stashDrop);
  const renameStash = useRepoStore((s) => s.renameStash);
  const [showInput, setShowInput] = useState(false);
  const [message, setMessage] = useState("");
  const [viewingStash, setViewingStash] = useState<StashInfo | null>(null);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const t = useT();

  const commitRename = async () => {
    if (renamingIndex === null) return;
    const value = renameValue.trim();
    setRenamingIndex(null);
    if (value) await renameStash(renamingIndex, value);
  };

  return (
    <CollapsibleSection
      icon={Archive}
      title={t("sidebar.stashes")}
      action={({ open, expand }) => (
        <button
          // Same as the branch form: collapsed, the input isn't mounted, so "+" has to unfold
          // the section before it can mean anything.
          onClick={() => {
            expand();
            setShowInput(open ? !showInput : true);
          }}
          className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          title={t("sidebar.stashCurrentChanges")}
        >
          <Plus size={12} />
        </button>
      )}
    >
      {showInput && (
        <div className="mb-1.5 flex items-center gap-1">
          <input
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                await stashSave(message || undefined, true);
                setMessage("");
                setShowInput(false);
              } else if (e.key === "Escape") {
                setShowInput(false);
              }
            }}
            placeholder={t("sidebar.stashMessage")}
            className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
          <button
            onClick={async () => {
              await stashSave(message || undefined, true);
              setMessage("");
              setShowInput(false);
            }}
            className="text-[var(--cf-accent)]"
          >
            <Check size={13} />
          </button>
        </div>
      )}

      <div className="space-y-0.5">
        {stashes.map((s) =>
          renamingIndex === s.index ? (
            <div key={s.index} className="flex items-center gap-1 px-1.5 py-0.5">
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={async (e) => {
                  if (e.key === "Enter") await commitRename();
                  else if (e.key === "Escape") setRenamingIndex(null);
                }}
                onBlur={commitRename}
                className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
              />
            </div>
          ) : (
            <div
              key={s.index}
              onClick={() => setViewingStash(s)}
              className="group flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <span className="flex-1 truncate text-[var(--cf-text-muted)]">{s.message}</span>
              <button
                title={t("sidebar.viewStash")}
                onClick={(e) => {
                  e.stopPropagation();
                  setViewingStash(s);
                }}
                className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <Eye size={12} />
              </button>
              <button
                title={t("sidebar.renameStash")}
                onClick={(e) => {
                  e.stopPropagation();
                  setRenameValue(s.message);
                  setRenamingIndex(s.index);
                }}
                className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <Pencil size={12} />
              </button>
              <button
                title={t("sidebar.apply")}
                onClick={(e) => {
                  e.stopPropagation();
                  stashApply(s.index);
                }}
                className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <Check size={12} />
              </button>
              <button
                title={t("sidebar.pop")}
                onClick={(e) => {
                  e.stopPropagation();
                  stashPop(s.index);
                }}
                className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <Undo2 size={12} />
              </button>
              <button
                title={t("sidebar.drop")}
                // The confirmation for this (and for apply/pop) lives in the store, so it can't be
                // skipped by a caller that doesn't know to ask.
                onClick={(e) => {
                  e.stopPropagation();
                  stashDrop(s.index);
                }}
                className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] group-hover:block"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ),
        )}
        {stashes.length === 0 && !showInput && (
          <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("sidebar.noStashes")}</p>
        )}
      </div>
      {viewingStash && <StashDiffModal stash={viewingStash} onClose={() => setViewingStash(null)} />}
    </CollapsibleSection>
  );
}

function RemoteBranchesSection({ branches }: { branches: BranchInfo[] }) {
  const checkoutRemoteBranch = useRepoStore((s) => s.checkoutRemoteBranch);
  const checkoutDetached = useRepoStore((s) => s.checkoutDetached);
  const checkingOutBranch = useRepoStore((s) => s.checkingOutBranch);
  const remoteBranches = branches.filter((b) => b.is_remote);
  const t = useT();
  if (remoteBranches.length === 0) return null;

  return (
    <CollapsibleSection icon={Cloud} title={t("sidebar.remoteBranches")}>
      <div className="space-y-0.5">
        {remoteBranches.map((b) => {
          const isCheckingOut = checkingOutBranch === b.name;
          return (
            <div
              key={b.name}
              className="group flex items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-[13px] text-[var(--cf-text-muted)]"
            >
              {isCheckingOut ? (
                <Loader2 size={10} className="shrink-0 animate-spin" />
              ) : (
                <CircleDot size={10} className="shrink-0 opacity-20" />
              )}
              <span className="flex-1 min-w-0 truncate">{b.name}</span>
              <button
                title={t("sidebar.checkoutLocally")}
                disabled={checkingOutBranch !== null}
                onClick={() => checkoutRemoteBranch(b.name)}
                className="hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <GitBranchPlus size={12} />
              </button>
              <button
                title={t("sidebar.checkoutDetached")}
                disabled={checkingOutBranch !== null}
                onClick={() => checkoutDetached(b.name)}
                className="hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
              >
                <Unlink size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}

function RemoteUrlEditModal({
  name,
  currentUrl,
  onClose,
}: {
  name: string;
  currentUrl: string;
  onClose: () => void;
}) {
  const setRemoteUrl = useRepoStore((s) => s.setRemoteUrl);
  const [draft, setDraft] = useState(currentUrl);
  const [saving, setSaving] = useState(false);
  const t = useT();

  const confirm = async () => {
    if (!draft.trim() || draft.trim() === currentUrl) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await setRemoteUrl(name, draft.trim());
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]"
      >
        <h3 className="mb-3 text-[13px] font-semibold">
          {t("sidebar.changeRemoteUrl")} — {name}
        </h3>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{t("sidebar.current")}</label>
        <div className="mb-3 overflow-x-auto rounded-md bg-black/[0.04] px-2 py-1.5 dark:bg-white/[0.06]">
          <p className="whitespace-nowrap font-mono text-[12px] text-[var(--cf-text-muted)]">{currentUrl}</p>
        </div>

        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{t("sidebar.newUrl")}</label>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void confirm();
            if (e.key === "Escape") onClose();
          }}
          className="mb-4 w-full overflow-x-auto rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={confirm}
            disabled={saving || !draft.trim()}
            className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoteUrlSection() {
  const remotes = useRepoStore((s) => s.remotes);
  const [editing, setEditing] = useState<string | null>(null);
  const t = useT();

  if (remotes.length === 0) return null;

  const editingRemote = remotes.find((r) => r.name === editing);

  return (
    <CollapsibleSection icon={Cloud} title={t("sidebar.remoteUrl")}>
      <div className="space-y-0.5">
        {remotes.map((r) => (
          <div
            key={r.name}
            className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 leading-none text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span className="shrink-0 font-medium leading-none text-[var(--cf-text-muted)]">{r.name}</span>
            <span className="flex-1 truncate font-mono text-[12px] leading-none text-[var(--cf-text-muted)]">
              {r.url}
            </span>
            <button
              title={t("sidebar.changeRemoteUrl")}
              onClick={() => setEditing(r.name)}
              className="hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
            >
              <Pencil size={12} />
            </button>
          </div>
        ))}
      </div>

      {editingRemote && (
        <RemoteUrlEditModal name={editingRemote.name} currentUrl={editingRemote.url} onClose={() => setEditing(null)} />
      )}
    </CollapsibleSection>
  );
}

const PR_STATUS_ICON: Record<string, typeof CircleDot> = {
  open: GitPullRequest,
  draft: GitPullRequest,
  merged: GitMerge,
  closed: Archive,
};

// A stable reference so the "no PRs loaded yet" fallback doesn't allocate a new array on
// every selector read — Zustand's snapshot check treats a fresh `[]` as "changed" forever,
// which spins the component into an infinite re-render loop.
const EMPTY_PRS: PullRequestSummary[] = [];

type LinkState =
  | { status: "checking" }
  | { status: "linked" }
  | { status: "needsToken"; provider: VcsProvider; identifier: string }
  | { status: "notDetected" };

// Which PR hosts have a saved token — decides whether a repo whose host couldn't be
// auto-detected can still be linked manually, and to which provider(s)/host(s).
interface HostingState {
  /** Connected Azure DevOps organizations (empty if none have a saved PAT). */
  ado: string[];
  /** Configured GitHub connections (github.com and/or Enterprise hosts). */
  github: GithubConnection[];
  /** Configured GitLab connections (gitlab.com and/or self-managed instances). */
  gitlab: GitlabConnection[];
}

function PullRequestsSection({ project }: { project: Project }) {
  const t = useT();
  const prs = usePrStore((s) => s.prsByProject[project.id] ?? EMPTY_PRS);
  const loading = usePrStore((s) => s.loadingProjectId === project.id);
  const loadError = usePrStore((s) => s.loadErrorByProject[project.id]);
  const loadPullRequests = usePrStore((s) => s.loadPullRequests);
  const selectPr = usePrStore((s) => s.selectPr);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const openAiPanel = useUiStore((s) => s.openAiPanel);
  const openSettings = useUiStore((s) => s.openSettings);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const [hosting, setHosting] = useState<HostingState | undefined>(undefined);
  const [showConnect, setShowConnect] = useState<false | VcsProvider>(false);
  const [showCreatePr, setShowCreatePr] = useState(false);
  /** Which status groups the user has folded or unfolded. Only the ones they've touched are in
   * here; the rest fall back to `PR_SECTIONS`, where merged and closed start folded on purpose —
   * a repository with a long history has dozens of them, and listing them all pushed the sections
   * below Pull Requests off the sidebar entirely. The count stays in each header, so a folded
   * group still answers "how many", which is the question most of the time. */
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  /** Takes what the group is *showing* rather than reading the record: a group that is open by
   * default has no entry to negate, so `!openGroups[key]` would re-open it on the first click. */
  const toggleGroup = (key: string, open: boolean) => setOpenGroups((g) => ({ ...g, [key]: !open }));
  /**
   * Whether this section has been unfolded yet — and therefore whether it is allowed to run.
   *
   * The thing being avoided is one call, not four. Of what this section starts on mount, the two
   * connection reads and `autoLinkProject` are local — `getSetting` against SQLite and a libgit2
   * read of the repo's own remote URLs (see `auto_link_project`, which isn't even async). The one
   * that leaves the machine is `listPullRequests`: a round trip to GitHub / Azure DevOps / GitLab,
   * on every repository you click, whether or not anyone was going to look at the answer. That is
   * what made this the slow part of opening a repo — and on a rate-limited host, the expensive one.
   *
   * Folding the section isn't enough on its own: `CollapsibleSection` only stops rendering its
   * children, and every one of those calls is started by an effect *here*, in a component that
   * stays mounted regardless. So the fold is now the gate — nothing runs until the user unfolds
   * the section, and unfolding it is what starts the work.
   *
   * What that costs, stated plainly because nothing else in the app covers it: a pull request
   * opened on the host while you weren't looking is now announced by nothing until you unfold
   * this. The notification bell only fires on runs *this app* started (see `jobsStore.run`), and
   * the "waiting on you" list in the AI panel is built from the PRs you have already opened here —
   * neither goes and asks the host what is new. That is the trade this section was folded to make.
   */
  const [activated, setActivated] = useState(false);
  /** One-way: folding it again doesn't un-fetch what has already been fetched, and re-opening it
   * should show that rather than start over. */
  const onOpenChange = (open: boolean) => {
    if (open) setActivated(true);
  };

  const initiallyLinked = Boolean(
    (project.ado_org && project.ado_project && project.ado_repo_id) ||
      (project.github_owner && project.github_repo) ||
      project.gitlab_project,
  );
  const [linkState, setLinkState] = useState<LinkState>(
    initiallyLinked ? { status: "linked" } : { status: "checking" },
  );

  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    (async () => {
      const ado = await loadAdoConnections().catch(() => []);
      const github = await loadGithubConnections().catch(() => []);
      const gitlab = await loadGitlabConnections().catch(() => []);
      if (!cancelled) setHosting({ ado: ado.map((c) => c.org), github, gitlab });
    })();
    return () => {
      cancelled = true;
    };
  }, [activated]);

  // Tries to derive the PR host — Azure DevOps org/project/repo, GitHub owner/repo, or a GitLab
  // project path — straight from this repo's own remote URL. Git already knows where the repo
  // lives, so there's no reason to make the user pick it again.
  const runAutoDetect = async (cancelledRef: { current: boolean }) => {
    try {
      const result = await autoLinkProject(project.id);
      if (cancelledRef.current) return;
      if (result.status === "Linked") setLinkState({ status: "linked" });
      else if (result.status === "NeedsToken")
        setLinkState({ status: "needsToken", provider: result.provider, identifier: result.identifier });
      else setLinkState({ status: "notDetected" });
    } catch {
      if (!cancelledRef.current) setLinkState({ status: "notDetected" });
    }
  };

  useEffect(() => {
    if (!activated) return;
    if (initiallyLinked) {
      setLinkState({ status: "linked" });
      return;
    }
    const cancelledRef = { current: false };
    void runAutoDetect(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, activated]);

  useEffect(() => {
    if (!activated) return;
    if (linkState.status === "linked") void loadPullRequests(project.id);
  }, [linkState.status, project.id, activated]);

  // Re-detect when Settings closes: a token/connection may have just been added there, so the
  // repo should bind to its host on its own — no manual "connect" click and no switching away
  // and back to trigger it.
  const wasSettingsOpen = useRef(settingsOpen);
  useEffect(() => {
    const justClosed = wasSettingsOpen.current && !settingsOpen;
    // Tracked whether or not the section is awake, so the *next* close is still read as an edge
    // rather than as "settings were never open".
    wasSettingsOpen.current = settingsOpen;
    // A folded section has nothing to re-detect for: it hasn't detected anything yet, and the
    // moment it is unfolded the effect above runs auto-detect against whatever Settings just left
    // behind. Nothing is lost by sitting this one out.
    if (!activated) return;
    if (!justClosed || linkState.status === "linked") return;
    const ref = { current: false };
    (async () => {
      const ado = await loadAdoConnections().catch(() => []);
      const github = await loadGithubConnections().catch(() => []);
      const gitlab = await loadGitlabConnections().catch(() => []);
      if (ref.current) return;
      setHosting({ ado: ado.map((c) => c.org), github, gitlab });
      await runAutoDetect(ref);
    })();
    return () => {
      ref.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen]);

  const onConnected = () => {
    setLinkState({ status: "linked" });
    void loadPullRequests(project.id);
  };

  // The "planet" shortcut — open this repo's home page on its host (GitHub / Azure DevOps) in
  // the browser. The backend derives the URL from the repo's actual remote.
  const openRepo = async () => {
    try {
      await openRepoInBrowser(project.id);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  /**
   * The header's own buttons, which live in the *collapsed* header too and so must not wait on
   * anything the fold is gating.
   *
   * Folding the section took these away with it, which was never the point: "open this repo on its
   * host" reads the remote in the backend and "create a pull request" only needs the repository —
   * neither is the round trip this section was folded to avoid, and both used to be one click from
   * a repo you had just opened. Refresh is the exception and is only offered once there is a list
   * to refresh.
   */
  const headerAction = ({ expand }: { expand: () => void }) => (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => {
          // Unfolds as part of the same click — the modal it opens is rendered among the
          // children, which a folded section doesn't mount. See `CollapsibleSection.action`.
          expand();
          setShowCreatePr(true);
        }}
        title={t("createPr.title")}
        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={12} />
      </button>
      <button
        onClick={openRepo}
        title={t("sidebar.openRepoInBrowser")}
        className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      >
        <Globe size={11} />
      </button>
      {activated && (
        <button
          onClick={() => void loadPullRequests(project.id)}
          disabled={loading}
          title={t("sidebar.refreshPrs")}
          className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : undefined} />
        </button>
      )}
    </div>
  );

  if (hosting === undefined || linkState.status === "checking") {
    return (
      // `initiallyLinked` is the whole reason the header can be decided here: it reads fields
      // already on the `project` row, so a repository that is *known* to have a host keeps its
      // buttons without this section having asked anyone anything. One that isn't gets the bare
      // header it would have got anyway — offering "create a pull request" on a repo with no host
      // is how you find out it has no host, via an error.
      <CollapsibleSection
        icon={GitPullRequest}
        title={t("sidebar.pullRequests")}
        onOpenChange={onOpenChange}
        action={initiallyLinked ? headerAction : undefined}
      >
        <SkeletonRows count={2} className="p-0" />
        {/* Mounted here as well as in the linked branch: the "+" above is reachable before this
            section has finished waking up, and the modal it opens has to survive the branch
            flipping under it once the list lands. */}
        {showCreatePr && (
          <CreatePrModal
            project={project}
            onClose={() => setShowCreatePr(false)}
            onCreated={() => {
              useAnalyzeUiStore.getState().hide();
              openAiPanel();
            }}
          />
        )}
      </CollapsibleSection>
    );
  }

  if (linkState.status === "needsToken") {
    const provider = linkState.provider;
    return (
      <CollapsibleSection icon={GitPullRequest} title={t("sidebar.pullRequests")} onOpenChange={onOpenChange}>
        <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">
          {provider === "github"
            ? t("sidebar.needsGithubToken")
            : provider === "gitlab"
              ? t("sidebar.needsGitlabToken", { host: linkState.identifier })
              : t("sidebar.needsTokenFor", { org: linkState.identifier })}{" "}
          <button onClick={() => openSettings("azure", provider)} className="text-[var(--cf-accent)] hover:underline">
            {t("statusbar.settings")}
          </button>
        </p>
      </CollapsibleSection>
    );
  }

  if (
    linkState.status === "notDetected" &&
    hosting.ado.length === 0 &&
    hosting.github.length === 0 &&
    hosting.gitlab.length === 0
  ) {
    return (
      <CollapsibleSection icon={GitPullRequest} title={t("sidebar.pullRequests")} onOpenChange={onOpenChange}>
        <div className="space-y-0.5">
          {PR_SECTIONS.map((section) => (
            <div
              key={section.key}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] text-[var(--cf-text-muted)]/60"
              title={t("sidebar.connectRequired")}
            >
              <Lock size={10} />
              <span>{t(section.labelKey)}</span>
            </div>
          ))}
        </div>
      </CollapsibleSection>
    );
  }

  if (linkState.status === "notDetected") {
    return (
      <CollapsibleSection icon={GitPullRequest} title={t("sidebar.pullRequests")} onOpenChange={onOpenChange}>
        {hosting.github.length > 0 && (
          <button
            onClick={() => setShowConnect("github")}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <GitFork size={12} />
            {t("sidebar.linkGithubRepo")}
          </button>
        )}
        {hosting.gitlab.length > 0 && (
          <button
            onClick={() => setShowConnect("gitlab")}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <GitMerge size={12} />
            {t("sidebar.linkGitlabRepo")}
          </button>
        )}
        {hosting.ado.length > 0 && (
          <button
            onClick={() => setShowConnect("azure")}
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <Cloud size={12} />
            {t("sidebar.linkAdoRepo")}
          </button>
        )}
        {showConnect === "azure" && hosting.ado.length > 0 && (
          <ConnectAdoModal
            projectId={project.id}
            orgs={hosting.ado}
            onConnected={onConnected}
            onClose={() => setShowConnect(false)}
          />
        )}
        {showConnect === "github" && (
          <ConnectGithubModal
            projectId={project.id}
            hosts={hosting.github.map((c) => c.host)}
            onConnected={onConnected}
            onClose={() => setShowConnect(false)}
          />
        )}
        {showConnect === "gitlab" && (
          <ConnectGitlabModal
            projectId={project.id}
            hosts={hosting.gitlab.map((c) => c.host)}
            onConnected={onConnected}
            onClose={() => setShowConnect(false)}
          />
        )}
      </CollapsibleSection>
    );
  }

  return (
    <CollapsibleSection
      icon={GitPullRequest}
      title={t("sidebar.pullRequests")}
      // Folded on arrival — see `activated`. Unfolding it is what fetches the list, so the "open"
      // group inside starts unfolded in turn: the click that asks for pull requests should land on
      // the ones waiting on you, not on another chevron. The other status groups stay folded, which
      // is what keeps this from filling the panel.
      onOpenChange={onOpenChange}
      action={headerAction}
    >
      {loadError ? (
        <div className="space-y-1 px-1.5">
          <p className="text-[12px] text-[var(--cf-danger)]">{t("sidebar.prLoadError")}</p>
          <p className="text-[11px] text-[var(--cf-text-muted)]">{loadError}</p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void loadPullRequests(project.id)}
              className="text-[11px] text-[var(--cf-accent)] hover:underline"
            >
              {t("sidebar.retry")}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {PR_SECTIONS.map((section) => {
            const items = prs.filter((pr) => pr.status === section.key);
            const Icon = PR_STATUS_ICON[section.key] ?? GitPullRequest;
            const open = openGroups[section.key] ?? section.defaultOpen ?? false;
            return (
              <div key={section.key}>
                {/* The chevron sits on the trailing edge rather than beside the label: these are
                    groups *within* an already-collapsible section, and a second column of chevrons
                    down the left would read as one nesting level deeper than it is. */}
                <button
                  onClick={() => toggleGroup(section.key, open)}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {t(section.labelKey)} ({items.length})
                  </span>
                  {open ? (
                    <ChevronDown size={11} className="shrink-0" />
                  ) : (
                    <ChevronRight size={11} className="shrink-0" />
                  )}
                </button>
                {/* Unmounted rather than hidden while folded — a repo with hundreds of closed PRs
                    would otherwise still build every row just to keep it off screen. */}
                {open && (
                  <div className="space-y-0.5">
                    {items.map((pr) => (
                      <button
                        key={pr.id}
                        onClick={() => {
                          useAnalyzeUiStore.getState().hide();
                          selectPr(pr);
                          openAiPanel();
                        }}
                        className={`flex w-full items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-left text-[12px] ${
                          selectedPr?.id === pr.id
                            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                        }`}
                      >
                        <Icon size={11} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                      </button>
                    ))}
                    {items.length === 0 && !loading && (
                      <p className="px-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("sidebar.noPRsInSection")}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {showCreatePr && (
        <CreatePrModal
          project={project}
          onClose={() => setShowCreatePr(false)}
          onCreated={() => {
            useAnalyzeUiStore.getState().hide();
            openAiPanel();
          }}
        />
      )}
    </CollapsibleSection>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const branches = useRepoStore((s) => s.branches);
  const status = useRepoStore((s) => s.status);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutDetached = useRepoStore((s) => s.checkoutDetached);
  const deleteBranch = useRepoStore((s) => s.deleteBranch);
  const setBranchLocked = useRepoStore((s) => s.setBranchLocked);
  const mergeBranch = useRepoStore((s) => s.mergeBranch);
  const checkingOutBranch = useRepoStore((s) => s.checkingOutBranch);
  const projectLoading = useRepoStore((s) => s.projectLoading);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();

  // Being the project in use *is* being unfolded: the branches, stashes and pull requests under a
  // row are the one unambiguous "this is the repo everything else on screen is about", and the tint
  // on the row alone was easy to lose track of with several projects listed. So there is no
  // expanded state to get out of step with the selection — and no fold control on the active row,
  // which could only ever have been used to hide the very thing that marks it.
  //
  // It replaces a `useState(isActive)` that read the selection once, on mount, and so opened
  // collapsed for the project restored at launch: `activeProjectId` arrives from the database after
  // the rows have already rendered, and nothing afterwards was telling the row to unfold.
  const isActive = project.id === activeProjectId;
  // A merge lands on the *current* branch, so it's that branch's lock that stops one — not the
  // lock of whichever row the merge button happens to sit on.
  const currentBranch = branches.find((b) => b.is_head) ?? null;
  const mergeBlockedBy = currentBranch?.is_locked ? currentBranch.name : null;
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [openingVsCode, setOpeningVsCode] = useState(false);

  const select = () => setActiveProject(project.id);

  const otherWorkspaces = workspaces.filter((w) => w.id !== project.workspace_id);

  return (
    <div>
      {/* The click target is the whole row, not just its label. The row is a strip of controls, so
          selecting the project lives on the container rather than on the name alone — which left
          the padding around the text, and the gaps between the chips, hovering as if clickable and
          doing nothing. Every control inside stops propagation, so each still means only itself. */}
      <div
        onClick={select}
        className={`group relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
          isActive
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        }`}
      >
        <button
          title={t("sidebar.revealInFileManager")}
          onClick={async (e) => {
            e.stopPropagation();
            setRevealing(true);
            try {
              await revealInFileManager(project.local_path);
            } finally {
              setRevealing(false);
            }
          }}
          // `cf-chip-button` rings the square on hover (see index.css) — without it the chip was
          // the one control in the row that gave no sign of being one.
          className="cf-chip-button flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-white"
          style={{ background: project.color }}
        >
          {revealing ? <Loader2 size={12} className="animate-spin" /> : <Folder size={12} />}
        </button>
        {/* Kept as a button so the row is still reachable and activatable from the keyboard — the
            container's handler covers the pointer, this covers focus. `stopPropagation` so a click
            landing on the name selects once rather than twice. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            select();
          }}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
        >
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
        </button>
        {/* Both row actions wear the same square as the "clone" and "add repository" chips above
            the list — `h-5 w-5`, rounded, with a hover fill — so a control that only appears on
            row hover still says it is one once it's there. They were bare icons, which lit up
            nothing at all under the pointer. */}
        <button
          title={t("sidebar.openInVsCode")}
          onClick={async (e) => {
            e.stopPropagation();
            setOpeningVsCode(true);
            try {
              await openInVsCode(project.local_path);
            } catch (err) {
              pushErrorToast(String(err));
            } finally {
              setOpeningVsCode(false);
            }
          }}
          className={ROW_ACTION_CLASS}
        >
          {openingVsCode ? <Loader2 size={13} className="animate-spin" /> : <Code2 size={13} />}
        </button>
        {otherWorkspaces.length > 0 && (
          <button
            title={t("sidebar.moveToWorkspace")}
            onClick={(e) => {
              e.stopPropagation();
              setShowMoveModal(true);
            }}
            className={ROW_ACTION_CLASS}
          >
            <FolderInput size={13} />
          </button>
        )}
      </div>

      {showMoveModal && <MoveProjectModal project={project} onClose={() => setShowMoveModal(false)} />}

      {isActive && projectLoading && (
        <div className="ml-6 mt-1 border-l border-[var(--cf-border)] pl-3">
          <SkeletonRows count={5} className="p-0" />
        </div>
      )}

      {isActive && !projectLoading && (
        <div className="ml-6 mt-1 space-y-3 border-l border-[var(--cf-border)] pl-3">
          <CollapsibleSection
            icon={GitBranch}
            title={t("sidebar.localBranches")}
            action={({ expand }) => (
              <button
                // The form is a modal now, so "+" always means the same thing. The section is
                // still unfolded, so the branch that gets created is visible when it lands.
                onClick={() => {
                  expand();
                  setShowCreateBranch(true);
                }}
                className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                title={t("sidebar.newBranch")}
              >
                <Plus size={12} />
              </button>
            )}
          >
            <div className="space-y-0.5">
              {/* Detaching leaves every row unhighlighted, which on its own is indistinguishable
                  from "the checkout did nothing". This row is what says otherwise. */}
              {status?.is_detached && (
                <div className="mb-1 flex items-center gap-1.5 rounded-md border border-dashed border-[var(--cf-border)] px-1.5 py-1 text-[12px] text-[var(--cf-warning)]">
                  <Unlink size={11} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate" title={t("sidebar.detachedHint")}>
                    {t("sidebar.detachedAt", { sha: status.head_oid?.slice(0, 7) ?? "?" })}
                  </span>
                </div>
              )}
              {branches
                .filter((b) => !b.is_remote)
                .map((b) => {
                  const isCheckingOut = checkingOutBranch === b.name;
                  return (
                    <div key={b.name} className="group flex items-center">
                      <button
                        onClick={() => checkoutBranch(b.name)}
                        disabled={checkingOutBranch !== null}
                        className={`flex flex-1 min-w-0 items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-left text-[13px] disabled:cursor-wait ${
                          b.is_head
                            ? "font-semibold text-[var(--cf-accent)]"
                            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                        }`}
                      >
                        {isCheckingOut ? (
                          <Loader2 size={10} className="shrink-0 animate-spin" />
                        ) : (
                          <CircleDot size={10} className={`shrink-0 ${b.is_head ? "opacity-100" : "opacity-30"}`} />
                        )}
                        <span className="flex-1 min-w-0 truncate">{b.name}</span>
                        {(b.ahead > 0 || b.behind > 0) && (
                          <span className="shrink-0 text-[10px] text-[var(--cf-text-muted)]">
                            {b.ahead > 0 && `↑${b.ahead}`}
                            {b.behind > 0 && `↓${b.behind}`}
                          </span>
                        )}
                      </button>
                      {/* One padlock, drawn as the state it is in — shut when locked, open when
                          not — and clicking it flips that state. A separate always-on badge next
                          to it meant a shut padlock and an open one sat side by side, which read
                          as a contradiction rather than as "locked, click to unlock". */}
                      <button
                        title={b.is_locked ? t("branch.lockedToggle") : t("branch.lock")}
                        onClick={() => setBranchLocked(b.name, !b.is_locked)}
                        className={`ml-1 shrink-0 hover:text-[var(--cf-warning)] ${
                          b.is_locked
                            ? "block text-[var(--cf-warning)]"
                            : "hidden text-[var(--cf-text-muted)] group-hover:block"
                        }`}
                      >
                        {b.is_locked ? <Lock size={12} /> : <LockOpen size={12} />}
                      </button>
                      <button
                        title={t("sidebar.checkoutDetached")}
                        disabled={checkingOutBranch !== null}
                        onClick={() => checkoutDetached(b.name)}
                        className="ml-1 hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
                      >
                        <Unlink size={12} />
                      </button>
                      {!b.is_head && (
                        <button
                          title={
                            mergeBlockedBy
                              ? t("branch.lockedCannotMerge", { name: mergeBlockedBy })
                              : t("sidebar.mergeIntoCurrent")
                          }
                          disabled={checkingOutBranch !== null || mergeBlockedBy !== null}
                          onClick={async () => {
                            const outcome = await mergeBranch(b.name);
                            if (outcome?.status === "conflicts") setActiveView("changes");
                          }}
                          className="ml-1 hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--cf-text-muted)] group-hover:block"
                        >
                          <GitMerge size={12} />
                        </button>
                      )}
                      {!b.is_head && (
                        <button
                          title={t("sidebar.deleteBranch")}
                          // Confirmed in the store, like the merge and stash actions, so the
                          // diagram is the same one everywhere and no caller can skip it.
                          onClick={() => deleteBranch(b.name, false)}
                          className="ml-1 hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] group-hover:block"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              {branches.filter((b) => !b.is_remote).length === 0 && (
                <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("sidebar.noBranches")}</p>
              )}
            </div>
          </CollapsibleSection>

          <RemoteBranchesSection branches={branches} />

          <RemoteUrlSection />

          <StashesSection />

          <PullRequestsSection project={project} />
        </div>
      )}

      {showCreateBranch && (
        <CreateBranchModal branches={branches} onClose={() => setShowCreateBranch(false)} />
      )}
    </div>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const loadWorkspaces = useWorkspaceStore((s) => s.loadWorkspaces);
  const addProject = useWorkspaceStore((s) => s.addProject);
  const sidebarWidth = useLayoutStore((s) => s.sizes.sidebarWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const openPrLinkModal = useUiStore((s) => s.openPrLinkModal);
  const t = useT();
  const [showCloneModal, setShowCloneModal] = useState(false);
  /** A picked folder that turned out to hold repositories, waiting for the user to choose which. */
  const [folderScan, setFolderScan] = useState<{
    folder: string;
    repos: FoundRepo[];
    truncated: boolean;
  } | null>(null);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  if (collapsed) return null;

  const projects = activeWorkspaceId ? projectsByWorkspace[activeWorkspaceId] ?? [] : [];

  /** Registers one repository. The path is always a verified repository root by the time it gets
   *  here — see `handleAddProject`. */
  const importRepo = (path: string) =>
    addProject({
      workspace_id: activeWorkspaceId!,
      name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
      local_path: path,
      remote_url: null,
      color: "#6366f1",
      icon: "git-branch",
      ado_org: null,
      ado_project: null,
      ado_repo_id: null,
      github_owner: null,
      github_repo: null,
      github_host: null,
      gitlab_project: null,
      gitlab_host: null,
    });

  /**
   * Adds a repository, after asking what the picked folder actually is.
   *
   * Everything about an open project assumes its path is a repository *root*: `git status` and
   * every diff run there, and the file watcher watches it **recursively**. Handed a folder full of
   * repositories, that became a walk of every working tree in it at once — the report this
   * replaces, where the app stopped responding entirely rather than saying no.
   *
   * So the folder is classified first, and each answer gets its own outcome: a repository is
   * added; a folder *containing* repositories opens the picker, because "I keep my repos here" is
   * a real thing to point at and importing several at once is the whole point; anything else is
   * refused out loud, which is the case that previously had no handling at all.
   */
  const handleAddProject = async () => {
    if (!activeWorkspaceId) return;
    const folder = await pickFolder();
    if (!folder) return;

    let scan;
    try {
      scan = await scanFolder(folder);
    } catch (e) {
      pushErrorToast(String(e));
      return;
    }

    if (scan.is_repo) {
      if (projects.some((project) => project.local_path === folder)) {
        pushErrorToast(t("import.alreadyInWorkspace"));
        return;
      }
      await importRepo(folder);
      return;
    }

    if (scan.repos.length > 0) {
      setFolderScan({ folder, repos: scan.repos, truncated: scan.truncated });
      return;
    }

    // Told apart deliberately: "there is nothing here" and "there are things here, none of them a
    // repository" are different mistakes, and the second is the one where the user picked a level
    // too high and needs to know that going one deeper would work. A folder so large the scan
    // stopped early gets its own answer rather than being reported as having no repositories —
    // which would be a cap presented as a finding.
    if (scan.truncated) {
      pushErrorToast(t("import.tooManyEntries"));
      return;
    }
    pushErrorToast(scan.empty ? t("import.emptyFolder") : t("import.noRepos"));
  };

  return (
    <div className="flex shrink-0">
      <aside
        style={{ width: sidebarWidth }}
        // No `border-r`. The `ResizeHandle` after this draws the seam already, and the border put a
        // second line hard against the sidebar's edge — so the pair read as one thick divider whose
        // live half sat off to the right, against the panel it isn't part of. Dropping it leaves one
        // line, centred in the handle's own six pixels, with equal space to each panel.
        className="flex shrink-0 flex-col overflow-hidden bg-[var(--cf-surface)]"
      >
        <div className="shrink-0 px-3 pt-3">
          <WorkspaceSwitcher />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("sidebar.projects")}
            </span>
            <div className="flex items-center gap-0.5">
              {/* Deliberately here, above the project list, rather than inside one project's
                  Pull Requests section: the whole point is that the link decides which repo
                  it belongs to. */}
              <button
                onClick={openPrLinkModal}
                className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                title={t("prLink.menuItem")}
              >
                <Glasses size={13} />
              </button>
              <button
                onClick={() => setShowCloneModal(true)}
                className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                title={t("sidebar.cloneRepo")}
              >
                <GitBranchPlus size={13} />
              </button>
              <button
                onClick={handleAddProject}
                className="flex h-5 w-5 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                title={t("sidebar.addProject")}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>

          <div className="space-y-0.5">
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
            {projects.length === 0 && (
              <p className="px-1.5 py-1 text-[12px] text-[var(--cf-text-muted)]">{t("sidebar.noProjects")}</p>
            )}
          </div>
        </div>

        {folderScan && (
          <ImportReposModal
            folder={folderScan.folder}
            repos={folderScan.repos}
            existingPaths={projects.map((project) => project.local_path)}
            truncated={folderScan.truncated}
            onImport={async (picked) => {
              // Sequential rather than `Promise.all`: each add writes the project list and the
              // last one wins as the active project, and a race decides which. In order, "the
              // last one you picked is the one you land on" is at least a rule.
              for (const repo of picked) await importRepo(repo.path);
            }}
            onClose={() => setFolderScan(null)}
          />
        )}
        {showCloneModal && activeWorkspaceId && (
          <CloneRepoModal workspaceId={activeWorkspaceId} onClose={() => setShowCloneModal(false)} />
        )}
      </aside>
      <ResizeHandle
        axis="x"
        value={sidebarWidth}
        min={SIDEBAR_MIN}
        max={SIDEBAR_MAX}
        onChange={(w) => setSize("sidebarWidth", w)}
        onCommit={(w) => commitSize("sidebarWidth", w)}
      />
    </div>
  );
}
