import { useEffect, useState } from "react";
import {
  Archive,
  Briefcase,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cloud,
  Folder,
  FolderInput,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequest,
  Loader2,
  Lock,
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
import { pickFolder, revealInFileManager, getSetting, getAdoPat } from "../../lib/tauri/commands";
import type { BranchInfo, Project, PullRequestSummary } from "../../types/domain";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { SkeletonRows } from "../common/Skeleton";
import { CloneRepoModal } from "./CloneRepoModal";
import { ConnectAdoModal } from "./ConnectAdoModal";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;

const PR_SECTIONS: { key: string; labelKey: TranslationKey }[] = [
  { key: "open", labelKey: "sidebar.openPRs" },
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

  return (
    <div className="relative mb-4 px-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
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
  const [showInput, setShowInput] = useState(false);
  const [message, setMessage] = useState("");
  const t = useT();

  return (
    <CollapsibleSection
      icon={Archive}
      title={t("sidebar.stashes")}
      action={
        <button
          onClick={() => setShowInput((v) => !v)}
          className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          title={t("sidebar.stashCurrentChanges")}
        >
          <Plus size={12} />
        </button>
      }
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
        {stashes.map((s) => (
          <div
            key={s.index}
            className="group flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span className="flex-1 truncate text-[var(--cf-text-muted)]">{s.message}</span>
            <button
              title={t("sidebar.apply")}
              onClick={() => stashApply(s.index)}
              className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
            >
              <Check size={12} />
            </button>
            <button
              title={t("sidebar.pop")}
              onClick={() => stashPop(s.index)}
              className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
            >
              <Undo2 size={12} />
            </button>
            <button
              title={t("sidebar.drop")}
              onClick={() => stashDrop(s.index)}
              className="hidden text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] group-hover:block"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {stashes.length === 0 && !showInput && (
          <p className="px-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("sidebar.noStashes")}</p>
        )}
      </div>
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

function CreateBranchForm({ branches, onDone }: { branches: BranchInfo[]; onDone: () => void }) {
  const createBranch = useRepoStore((s) => s.createBranch);
  const [name, setName] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const t = useT();

  return (
    <div className="mb-1.5 space-y-1 rounded-md border border-[var(--cf-border)] p-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        placeholder={t("sidebar.newBranchName")}
        className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-1.5 py-0.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
      />
      <select
        value={startPoint}
        onChange={(e) => setStartPoint(e.target.value)}
        className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-0.5 text-[12px]"
      >
        <option value="">{t("sidebar.fromCurrentHead")}</option>
        <optgroup label={t("sidebar.local")}>
          {branches
            .filter((b) => !b.is_remote)
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
        </optgroup>
        <optgroup label={t("sidebar.remote")}>
          {branches
            .filter((b) => b.is_remote)
            .map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
        </optgroup>
      </select>
      <div className="flex justify-end gap-2 pt-0.5">
        <button onClick={onDone} className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          {t("common.cancel")}
        </button>
        <button
          disabled={!name.trim()}
          onClick={async () => {
            await createBranch(name.trim(), startPoint || undefined);
            onDone();
          }}
          className="rounded-md bg-[var(--cf-accent)] px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
        >
          {t("sidebar.create")}
        </button>
      </div>
    </div>
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

function PullRequestsSection({ project }: { project: Project }) {
  const t = useT();
  const prs = usePrStore((s) => s.prsByProject[project.id] ?? EMPTY_PRS);
  const loading = usePrStore((s) => s.loadingProjectId === project.id);
  const loadError = usePrStore((s) => s.loadErrorByProject[project.id]);
  const loadPullRequests = usePrStore((s) => s.loadPullRequests);
  const selectPr = usePrStore((s) => s.selectPr);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const [connectedOrg, setConnectedOrg] = useState<string | null | undefined>(undefined);
  const [showConnect, setShowConnect] = useState(false);

  const linked = Boolean(project.ado_org && project.ado_project && project.ado_repo_id);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const org = await getSetting("ado_default_org");
      if (!org) {
        if (!cancelled) setConnectedOrg(null);
        return;
      }
      const pat = await getAdoPat(org).catch(() => null);
      if (!cancelled) setConnectedOrg(pat ? org : null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (linked) void loadPullRequests(project.id);
  }, [linked, project.id]);

  if (connectedOrg === undefined) return null;

  if (connectedOrg === null) {
    return (
      <CollapsibleSection icon={GitPullRequest} title={t("sidebar.pullRequests")}>
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

  if (!linked) {
    return (
      <CollapsibleSection icon={GitPullRequest} title={t("sidebar.pullRequests")}>
        <button
          onClick={() => setShowConnect(true)}
          className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <Cloud size={12} />
          {t("sidebar.linkAdoRepo")}
        </button>
        {showConnect && (
          <ConnectAdoModal
            projectId={project.id}
            org={connectedOrg}
            onConnected={() => void loadPullRequests(project.id)}
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
      action={
        loading ? (
          <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />
        ) : undefined
      }
    >
      {loadError ? (
        <div className="space-y-1 px-1.5">
          <p className="text-[12px] text-[var(--cf-danger)]">{t("sidebar.prLoadError")}</p>
          <button
            onClick={() => void loadPullRequests(project.id)}
            className="text-[11px] text-[var(--cf-accent)] hover:underline"
          >
            {t("sidebar.retry")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {PR_SECTIONS.map((section) => {
            const items = prs.filter((pr) => pr.status === section.key);
            const Icon = PR_STATUS_ICON[section.key] ?? GitPullRequest;
            return (
              <div key={section.key}>
                <p className="px-1.5 text-[11px] font-medium text-[var(--cf-text-muted)]">
                  {t(section.labelKey)} ({items.length})
                </p>
                <div className="space-y-0.5">
                  {items.map((pr) => (
                    <button
                      key={pr.id}
                      onClick={() => {
                        selectPr(pr);
                        setActiveView("chat");
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
              </div>
            );
          })}
        </div>
      )}
    </CollapsibleSection>
  );
}

function ProjectRow({ project }: { project: Project }) {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const setActiveProject = useWorkspaceStore((s) => s.setActiveProject);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const moveProject = useWorkspaceStore((s) => s.moveProject);
  const branches = useRepoStore((s) => s.branches);
  const checkoutBranch = useRepoStore((s) => s.checkoutBranch);
  const checkoutDetached = useRepoStore((s) => s.checkoutDetached);
  const deleteBranch = useRepoStore((s) => s.deleteBranch);
  const mergeBranch = useRepoStore((s) => s.mergeBranch);
  const checkingOutBranch = useRepoStore((s) => s.checkingOutBranch);
  const projectLoading = useRepoStore((s) => s.projectLoading);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();

  const isActive = project.id === activeProjectId;
  const [expanded, setExpanded] = useState(isActive);
  const [showCreateBranch, setShowCreateBranch] = useState(false);
  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const select = () => {
    setActiveProject(project.id);
    setExpanded(true);
  };

  const otherWorkspaces = workspaces.filter((w) => w.id !== project.workspace_id);

  return (
    <div>
      <div
        className={`group relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
          isActive
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
            : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        }`}
      >
        <button
          title={t("sidebar.revealInFileManager")}
          onClick={(e) => {
            e.stopPropagation();
            void revealInFileManager(project.local_path);
          }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-white"
          style={{ background: project.color }}
        >
          <Folder size={12} />
        </button>
        <button onClick={select} className="flex flex-1 min-w-0 items-center gap-2 text-left">
          <span className="flex-1 min-w-0 truncate font-medium">{project.name}</span>
        </button>
        {otherWorkspaces.length > 0 && (
          <button
            title={t("sidebar.moveToWorkspace")}
            onClick={(e) => {
              e.stopPropagation();
              setShowMoveMenu((v) => !v);
            }}
            className="opacity-0 group-hover:opacity-100"
          >
            <FolderInput size={13} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="opacity-0 group-hover:opacity-100"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {showMoveMenu && (
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
            <p className="px-2 py-1 text-[11px] font-semibold uppercase text-[var(--cf-text-muted)]">
              {t("sidebar.moveToWorkspace")}
            </p>
            {otherWorkspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={async () => {
                  await moveProject(project.id, project.workspace_id, ws.id);
                  setShowMoveMenu(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: ws.color }} />
                <span className="truncate">{ws.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isActive && expanded && projectLoading && (
        <div className="ml-6 mt-1 border-l border-[var(--cf-border)] pl-3">
          <SkeletonRows count={5} className="p-0" />
        </div>
      )}

      {isActive && expanded && !projectLoading && (
        <div className="ml-6 mt-1 space-y-3 border-l border-[var(--cf-border)] pl-3">
          <CollapsibleSection
            icon={GitBranch}
            title={t("sidebar.localBranches")}
            action={
              <button
                onClick={() => setShowCreateBranch((v) => !v)}
                className="flex h-4 w-4 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                title={t("sidebar.newBranch")}
              >
                <Plus size={12} />
              </button>
            }
          >
            {showCreateBranch && (
              <CreateBranchForm branches={branches} onDone={() => setShowCreateBranch(false)} />
            )}
            <div className="space-y-0.5">
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
                          title={t("sidebar.mergeIntoCurrent")}
                          disabled={checkingOutBranch !== null}
                          onClick={async () => {
                            const outcome = await mergeBranch(b.name);
                            if (outcome?.status === "conflicts") setActiveView("changes");
                          }}
                          className="ml-1 hidden shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)] group-hover:block"
                        >
                          <GitMerge size={12} />
                        </button>
                      )}
                      {!b.is_head && (
                        <button
                          title={t("sidebar.deleteBranch")}
                          onClick={() => {
                            if (window.confirm(t("sidebar.deleteBranchConfirm", { name: b.name }))) {
                              deleteBranch(b.name, false);
                            }
                          }}
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
  const t = useT();
  const [showCloneModal, setShowCloneModal] = useState(false);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  if (collapsed) return null;

  const projects = activeWorkspaceId ? projectsByWorkspace[activeWorkspaceId] ?? [] : [];

  const handleAddProject = async () => {
    if (!activeWorkspaceId) return;
    const folder = await pickFolder();
    if (!folder) return;
    const name = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
    await addProject({
      workspace_id: activeWorkspaceId,
      name,
      local_path: folder,
      remote_url: null,
      color: "#6366f1",
      icon: "git-branch",
      ado_org: null,
      ado_project: null,
      ado_repo_id: null,
    });
  };

  return (
    <div className="flex shrink-0">
      <aside
        style={{ width: sidebarWidth }}
        className="flex shrink-0 flex-col overflow-hidden border-r border-[var(--cf-border)] bg-[var(--cf-surface)]"
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
