import { useMemo, useState } from "react";
import { Globe, Pencil, Search, Trash2, X } from "lucide-react";
import { useJobsStore, EMPTY_JOBS } from "../../state/jobsStore";
import { useChatHistoryStore, EMPTY_CONVERSATIONS } from "../../state/activityStore";
import { usePrStore } from "../../state/prStore";
import { useChatStore } from "../../state/chatStore";
import { useAnalyzeUiStore } from "../../state/analyzeUiStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { workspaceActivityKey, workspaceIdFromBucket } from "../../lib/prTarget";
import {
  mergeActivityEntries,
  entryKey,
  entryTitle,
  entryVisual,
  entryRunCount,
  entryIsGlobal,
  findActiveEntryKey,
  type ActivityEntry,
} from "../../lib/activityEntries";

/** The full Activity list: this project's history plus the workspace's own — the reviews of pull
 * requests that belong to no repository here, marked with a globe and named after the repository
 * they came from so they can be searched for by it. */
export function ActivityModal({
  projectId,
  workspaceId,
  onClose,
}: {
  projectId: string | null;
  workspaceId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const workspaceBucket = workspaceId ? workspaceActivityKey(workspaceId) : null;
  const projectJobs = useJobsStore((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY_JOBS);
  const workspaceJobs = useJobsStore((s) => (workspaceBucket ? s.byProject[workspaceBucket] : undefined) ?? EMPTY_JOBS);
  const renameJob = useJobsStore((s) => s.rename);
  const removeJob = useJobsStore((s) => s.remove);
  const conversations = useChatHistoryStore((s) => (projectId ? s.byProject[projectId] : undefined) ?? EMPTY_CONVERSATIONS);
  const removeConversation = useChatHistoryStore((s) => s.remove);
  const renameConversation = useChatHistoryStore((s) => s.rename);
  const prsByProject = usePrStore((s) => s.prsByProject);
  const selectedPr = usePrStore((s) => s.selectedPr);
  const linkPr = usePrStore((s) => s.linkPr);
  const selectPr = usePrStore((s) => s.selectPr);
  const analyzeOpen = useAnalyzeUiStore((s) => s.open);
  const analyzeJobId = useAnalyzeUiStore((s) => s.selectedJobId);
  const activeSessionId = useChatStore((s) => (projectId ? s.byProject[projectId]?.conversationId : null) ?? null);
  const switchTo = useChatStore((s) => s.switchTo);
  const [query, setQuery] = useState("");
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const jobs = useMemo(
    () => (workspaceJobs.length === 0 ? projectJobs : [...projectJobs, ...workspaceJobs]),
    [projectJobs, workspaceJobs],
  );
  const entries = useMemo(() => mergeActivityEntries(jobs, conversations), [jobs, conversations]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => entryTitle(e).toLowerCase().includes(q));
  }, [entries, query]);

  const activeEntryKey = findActiveEntryKey(entries, {
    selectedPrId: selectedPr?.id ?? null,
    linkPrUrl: linkPr?.workspaceId === workspaceId ? linkPr.url : null,
    analyzeOpen,
    analyzeJobId,
    activeSessionId,
  });

  /** Which store the row lives in — a job carries its own bucket, a chat is always the project's. */
  const bucketOf = (entry: ActivityEntry) => (entry.type === "job" ? entry.job.projectId : projectId);

  const open = (entry: ActivityEntry) => {
    if (entry.type === "chat") {
      if (!projectId) return;
      // Clear whatever else the panel might currently be showing — otherwise the chat
      // switches underneath a still-visible PR review or analysis section.
      selectPr(null);
      useAnalyzeUiStore.getState().hide();
      void switchTo(projectId, entry.conv.session_id);
      onClose();
      return;
    }
    // A workspace row rebuilds its link session from the row itself: after a restart nothing is
    // parked in memory, and there's no project list the PR could be looked up in.
    const rowWorkspaceId = workspaceIdFromBucket(entry.job.projectId);
    if (rowWorkspaceId) {
      useAnalyzeUiStore.getState().hide();
      usePrStore.getState().openLinkPrFromMeta(entry.job.meta, rowWorkspaceId);
      // A row whose newest entry is a decision still opens the PR it was taken on.
    } else if (entry.job.kind === "pr-review" || entry.job.kind === "pr-action") {
      const pr = projectId ? prsByProject[projectId]?.find((p) => p.id === entry.job.meta.prId) : undefined;
      if (!pr) return;
      useAnalyzeUiStore.getState().hide();
      selectPr(pr);
    } else if (entry.job.kind === "analyze-changes") {
      selectPr(null);
      useAnalyzeUiStore.getState().showJob(entry.job.id);
    }
    onClose();
  };

  const handleDelete = async (entry: ActivityEntry) => {
    const bucket = bucketOf(entry);
    if (!bucket) return;
    const runs = entry.type === "job" ? entry.runs.length : 1;
    // When the activity bundles history (a PR / pre-commit with several runs) spell that out, so a
    // single click deleting the whole thing isn't a surprise.
    const message = runs > 1 ? t("ai.confirmDeleteWithHistory", { n: runs }) : t("chatHistory.confirmDelete");
    if (!(await confirmAction(message))) return;
    // Deleting a chat updates the persisted conversation list; the chat panel reconciles against
    // that list and resets itself if the open conversation no longer exists (see AiPanel
    // ChatSection) — which also covers a chat that spans several session ids.
    if (entry.type === "chat") await removeConversation(bucket, entry.conv.session_id);
    // A job row owns every run of that activity — remove them all so the whole history goes, not
    // just the latest run (which would leave the row behind with one fewer run each click).
    else await Promise.all(entry.runs.map((j) => removeJob(j.projectId, j.id)));
  };

  const startRename = (entry: ActivityEntry) => {
    setRenamingKey(entryKey(entry));
    setRenameValue(entryTitle(entry));
  };

  const commitRename = async (entry: ActivityEntry) => {
    const bucket = bucketOf(entry);
    const title = renameValue.trim();
    setRenamingKey(null);
    if (!bucket || !title || title === entryTitle(entry)) return;
    if (entry.type === "chat") await renameConversation(bucket, entry.conv.session_id, title);
    else await renameJob(bucket, entry.job.id, title);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-16" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[75vh] w-[540px] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center justify-between border-b border-[var(--cf-border)] px-3 py-2">
          <p className="text-[13px] font-semibold">{t("ai.activityModalTitle")}</p>
          <button onClick={onClose} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <Search size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && onClose()}
            placeholder={t("ai.activitySearch")}
            className="flex-1 bg-transparent text-[13px] outline-none"
          />
        </div>

        <div className="flex-1 overflow-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-[12px] text-[var(--cf-text-muted)]">{t("ai.noMatches")}</p>
          ) : (
            <div className="space-y-1">
              {filtered.map((entry) => {
                const { icon: Icon, color, spinning } = entryVisual(entry);
                const isActive = entryKey(entry) === activeEntryKey;
                const isRenaming = renamingKey === entryKey(entry);
                return (
                  <div
                    key={entryKey(entry)}
                    className={`group flex items-center gap-2 rounded-lg border p-2.5 ${
                      isActive
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                        : "border-[var(--cf-border)] hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                    }`}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void commitRename(entry)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(entry);
                          else if (e.key === "Escape") setRenamingKey(null);
                        }}
                        className="min-w-0 flex-1 rounded-md border border-[var(--cf-accent)] bg-transparent px-1.5 py-0.5 text-[12px] font-medium text-[var(--cf-text)] outline-none"
                      />
                    ) : (
                      <button onClick={() => open(entry)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                        <Icon size={13} className={spinning ? "shrink-0 animate-spin" : "shrink-0"} style={{ color }} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {entryIsGlobal(entry) && (
                              <Globe
                                size={12}
                                className="shrink-0 text-[var(--cf-text-muted)]"
                                aria-label={t("activity.workspaceWide")}
                              />
                            )}
                            <p className="truncate text-[12px] font-medium text-[var(--cf-text)]">{entryTitle(entry)}</p>
                            {entryRunCount(entry) > 1 && (
                              <span
                                title={t("ai.runCount", { n: entryRunCount(entry) })}
                                className="shrink-0 rounded-full bg-black/[0.06] px-1.5 text-[10px] font-semibold text-[var(--cf-text-muted)] dark:bg-white/[0.1]"
                              >
                                ×{entryRunCount(entry)}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-[10px] text-[var(--cf-text-muted)]">
                            {new Date(
                              entry.type === "job" ? entry.job.createdAt : entry.conv.updated_at,
                            ).toLocaleString()}
                          </p>
                        </div>
                      </button>
                    )}
                    {!isRenaming && (
                      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
                        <button
                          onClick={() => startRename(entry)}
                          title={t("ai.rename")}
                          className="text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          onClick={() => void handleDelete(entry)}
                          title={t("chatHistory.delete")}
                          className="text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
