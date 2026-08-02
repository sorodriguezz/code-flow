import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Ban,
  ChevronDown,
  CircleCheckBig,
  CircleDot,
  Database,
  Download,
  Eye,
  EyeOff,
  MessageSquare,
  ShieldOff,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";
import {
  deleteReviewRun,
  deleteReviewRunsForPr,
  exportReviewRuns,
  getReviewRun,
  importReviewRuns,
  listFpSuppressions,
  listReviewRuns,
  markReviewFinding,
  purgeWorkspaceReviewRuns,
  removeFpSuppression,
} from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { renderMarkdown } from "../../lib/markdown";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { FpSuppression, ReviewRunDetail, ReviewRunSummary, SavedFinding } from "../../types/domain";
import { Skeleton } from "../common/Skeleton";
import { EmptyState } from "../common/EmptyState";

/** Lifecycle state of a saved finding, as an icon rather than an emoji so it matches the icon
 * language of the rest of the app (and renders at a predictable size across platforms). */
const ESTADOS: Record<string, { icon: LucideIcon; color: string; labelKey: TranslationKey }> = {
  abierto: { icon: CircleDot, color: "text-[var(--cf-warning)]", labelKey: "settings.memoryEstadoOpen" },
  posteado: { icon: MessageSquare, color: "text-[var(--cf-accent)]", labelKey: "settings.memoryEstadoPosted" },
  resuelto: { icon: CircleCheckBig, color: "text-[var(--cf-success)]", labelKey: "settings.memoryEstadoResolved" },
  falso_positivo: { icon: Ban, color: "text-[var(--cf-text-muted)]", labelKey: "settings.memoryEstadoFalse" },
  ignorado: { icon: EyeOff, color: "text-[var(--cf-text-muted)]", labelKey: "settings.memoryEstadoIgnored" },
};

/** A `repo_key` (`github:host/owner/repo`, `azure:org/project/repoId`) as something a human reads.
 * The provider prefix is dropped and, for GitHub, the host too — what identifies the repository in
 * a list of a workspace's own repositories is the last part of the path. */
function repoLabel(repoKey: string): string {
  const withoutProvider = repoKey.replace(/^(github|gitlab|azure):/, "");
  const parts = withoutProvider.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || withoutProvider;
}

/**
 * The workspace's standing false positives — the rules that keep a finding a human already
 * rejected from being re-derived on every new pull request.
 *
 * They live here rather than with a PR's runs because that is their scope: a run's marks belong to
 * one pull request and die with it, while these are read into every review of the repository they
 * name. Which also makes this the only place they can be taken back, so the section renders even
 * when the memory is empty.
 */
function FpSuppressionsSection({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const [rules, setRules] = useState<FpSuppression[] | null>(null);

  useEffect(() => {
    let live = true;
    void listFpSuppressions(workspaceId)
      .then((r) => live && setRules(r))
      .catch(() => live && setRules([]));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const remove = async (rule: FpSuppression) => {
    if (!(await confirmAction(t("settings.fpRuleRemoveConfirm", { category: rule.categoria })))) return;
    await removeFpSuppression(workspaceId, rule.id);
    setRules(await listFpSuppressions(workspaceId));
  };

  // Nothing configured yet: the empty state would be a paragraph explaining a feature that is
  // reached from the review panel, not from here.
  if (!rules || rules.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
      <div className="border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
          <ShieldOff size={12} className="text-[var(--cf-text-muted)]" />
          {t("settings.fpRulesTitle", { n: rules.length })}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("settings.fpRulesHint")}</p>
      </div>
      <div className="divide-y divide-[var(--cf-border)]">
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12px]">
                <span className="font-mono">{rule.categoria}</span>
                <span className="text-[var(--cf-text-muted)]">
                  {" · "}
                  {rule.archivo ?? t("settings.fpRuleWholeRepo")}
                </span>
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{rule.motivo}</p>
              <p className="mt-0.5 truncate text-[10px] text-[var(--cf-text-muted)]">
                {repoLabel(rule.repo_key)}
                {rule.pr_id > 0 ? ` · PR #${rule.pr_id}` : ""}
              </p>
            </div>
            <button
              onClick={() => void remove(rule)}
              title={t("settings.fpRuleRemove")}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Shared styling for the two header actions (export / purge) and the per-PR delete. */
const HEADER_BUTTON =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]";

/** One PR's group of saved runs (newest first). */
interface PrGroup {
  projectId: string;
  projectName: string;
  prId: number;
  prTitle: string;
  runs: ReviewRunSummary[];
}

/**
 * Manager for the workspace's saved review memory (the `review_runs` table). Lists runs grouped by
 * PR, lets you open one to read its saved review, delete a run or a whole PR's history, purge the
 * whole workspace, or export runs to disk as .md/.json.
 */
export function ReviewMemoriesSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const pushToast = useToastStore((s) => s.pushToast);

  const [runs, setRuns] = useState<ReviewRunSummary[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReviewRunDetail | null>(null);
  /**
   * Which repository's memory is on screen. `null` is all of them.
   *
   * The list is the workspace's, but memory never is: a run is only ever read back for the
   * repository it was recorded against — so "which of these will actually be used on the PR I'm
   * about to review?" is a question the manager has to be able to answer, and a workspace with
   * four repositories in one flat list cannot.
   */
  const [repoFilter, setRepoFilter] = useState<string | null>(null);

  const reload = async (id: string) => setRuns(await listReviewRuns(id));

  useEffect(() => {
    setRuns(null);
    setExpandedId(null);
    setDetail(null);
    setRepoFilter(null);
    if (workspaceId) void reload(workspaceId);
  }, [workspaceId]);

  const groups = useMemo<PrGroup[]>(() => {
    if (!runs) return [];
    const byPr = new Map<string, PrGroup>();
    for (const run of runs) {
      const key = `${run.project_id}:${run.pr_id}`;
      const existing = byPr.get(key);
      if (existing) existing.runs.push(run);
      else
        byPr.set(key, {
          projectId: run.project_id,
          projectName: run.project_name,
          prId: run.pr_id,
          prTitle: run.pr_title,
          runs: [run],
        });
    }
    return [...byPr.values()];
  }, [runs]);

  /** One entry per repository with saved memory, for the filter row. */
  const repos = useMemo(() => {
    const byProject = new Map<string, { projectId: string; projectName: string; runs: number }>();
    for (const group of groups) {
      const entry = byProject.get(group.projectId);
      if (entry) entry.runs += group.runs.length;
      else
        byProject.set(group.projectId, {
          projectId: group.projectId,
          projectName: group.projectName,
          runs: group.runs.length,
        });
    }
    return [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
  }, [groups]);

  const shown = repoFilter ? groups.filter((g) => g.projectId === repoFilter) : groups;

  if (!workspaceId) {
    return <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.reviewSelectWorkspace")}</p>;
  }
  if (runs === null) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const toggle = async (run: ReviewRunSummary) => {
    if (expandedId === run.id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(run.id);
    setDetail(null);
    setDetail(await getReviewRun(run.id));
  };

  const refreshDetail = async (id: string) => setDetail(await getReviewRun(id));

  const removeRun = async (run: ReviewRunSummary) => {
    if (!(await confirmAction(t("settings.memoryDeleteRunConfirm", { pr: run.pr_id })))) return;
    await deleteReviewRun(run.id);
    if (expandedId === run.id) setExpandedId(null);
    await reload(workspaceId);
  };

  const removePr = async (group: PrGroup) => {
    if (!(await confirmAction(t("settings.memoryDeletePrConfirm", { pr: group.prId, n: group.runs.length }), true))) return;
    await deleteReviewRunsForPr(group.projectId, group.prId);
    await reload(workspaceId);
  };

  const purge = async () => {
    if (!(await confirmAction(t("settings.memoryPurgeConfirm", { n: runs.length }), true))) return;
    await purgeWorkspaceReviewRuns(workspaceId);
    await reload(workspaceId);
  };

  /**
   * Export, at whichever of the three scopes was asked for: one run, one repository, or everything
   * on screen.
   *
   * The header's button follows the repository filter rather than always meaning "everything" —
   * a filtered list with a button that quietly exports the repositories it is hiding would be the
   * more surprising of the two. Its label names the repository outright so the scope is never a
   * guess.
   */
  const exportRuns = async (scope: { runId?: string; projectId?: string }) => {
    const dir = await openDialog({ directory: true, multiple: false, title: t("settings.memoryExportTitle") });
    if (typeof dir !== "string") return;
    try {
      const { runs, rules } = await exportReviewRuns(workspaceId, scope, dir);
      pushToast(
        rules > 0
          ? t("settings.memoryExportedWithRules", { n: runs, rules })
          : t("settings.memoryExported", { n: runs }),
        "success",
      );
    } catch (e) {
      pushToast(String(e), "error");
    }
  };

  /**
   * Import, from a folder an export wrote.
   *
   * The outcome is reported in full rather than as one number, because the three ways it can fall
   * short are all actionable and none of them is an error: runs already here (nothing to do), runs
   * for a repository this workspace hasn't linked (link it and import again), and folders that
   * couldn't be read (an incomplete copy).
   */
  const importRuns = async () => {
    const dir = await openDialog({ directory: true, multiple: false, title: t("settings.memoryImportTitle") });
    if (typeof dir !== "string") return;
    try {
      const outcome = await importReviewRuns(workspaceId, dir);
      await reload(workspaceId);
      pushToast(
        t("settings.memoryImported", {
          n: outcome.imported,
          skipped: outcome.alreadyPresent,
          rules: outcome.rules,
        }),
        "success",
      );
      if (outcome.unmatchedRepos.length > 0) {
        pushToast(
          t("settings.memoryImportUnmatched", {
            repos: outcome.unmatchedRepos.map(repoLabel).join(", "),
          }),
          "info",
        );
      }
      if (outcome.unreadable > 0) {
        pushToast(t("settings.memoryImportUnreadable", { n: outcome.unreadable }), "info");
      }
    } catch (e) {
      pushToast(String(e), "error");
    }
  };

  // The rules are shown even with no saved runs: purging the memory doesn't (and shouldn't) drop
  // them, and a rule you can't see is a rule you can't take back.
  //
  // Import belongs here too, and this is the state that needs it most: a machine with no memory of
  // its own is exactly the one someone is carrying an export to.
  if (runs.length === 0) {
    return (
      <div className="space-y-3">
        <FpSuppressionsSection workspaceId={workspaceId} />
        <EmptyState icon={Database} title={t("settings.memoryEmpty")} subtitle={t("settings.memoryEmptyHint")} />
        <div className="flex justify-center">
          <button onClick={() => void importRuns()} className={`${HEADER_BUTTON} hover:text-[var(--cf-text)]`}>
            <Upload size={12} /> {t("settings.memoryImport")}
          </button>
        </div>
      </div>
    );
  }

  /** The repository the export button will actually write, when the list is filtered to one. */
  const filtered = repoFilter ? repos.find((r) => r.projectId === repoFilter) : undefined;

  return (
    <div className="space-y-3">
      <FpSuppressionsSection workspaceId={workspaceId} />
      {/* Actions are real bordered buttons pinned to the top of the row: as bare icon+label pairs
          centred against a two-line paragraph they wrapped ("Exportar / todo") and read as loose
          floating icons rather than controls. */}
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("settings.memoryHint", { n: runs.length })}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => void exportRuns({ projectId: filtered?.projectId })}
            className={`${HEADER_BUTTON} hover:text-[var(--cf-text)]`}
          >
            <Download size={12} />
            {filtered
              ? t("settings.memoryExportRepo", { repo: filtered.projectName })
              : t("settings.memoryExportAll")}
          </button>
          <button onClick={() => void importRuns()} className={`${HEADER_BUTTON} hover:text-[var(--cf-text)]`}>
            <Upload size={12} /> {t("settings.memoryImport")}
          </button>
          <button onClick={() => void purge()} className={`${HEADER_BUTTON} hover:text-[var(--cf-danger)]`}>
            <Trash2 size={12} /> {t("settings.memoryPurge")}
          </button>
        </div>
      </div>

      {/* Which repository each set of memories belongs to — and a way to see one repository at a
          time. Only shown when there is more than one, since with a single repo the row would be
          one button saying what the whole screen already says. */}
      {repos.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <FilterChip
            label={t("settings.memoryAllRepos")}
            count={runs.length}
            active={repoFilter === null}
            onClick={() => setRepoFilter(null)}
          />
          {repos.map((repo) => (
            <FilterChip
              key={repo.projectId}
              label={repo.projectName}
              count={repo.runs}
              active={repoFilter === repo.projectId}
              onClick={() => setRepoFilter(repo.projectId)}
            />
          ))}
        </div>
      )}

      {shown.map((group) => (
        <div key={`${group.projectId}:${group.prId}`} className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {/* Project name moved onto its own muted line: inline after the title it collided with the
              PR subject, and both got clipped by the same truncate. */}
          {/* A literal tint rather than --cf-surface-raised: that var equals --cf-surface in the light
              theme, so the header band would only be visible in dark mode. */}
          <div className="flex items-start justify-between gap-2 border-b border-[var(--cf-border)] bg-black/[0.02] px-3 py-2 dark:bg-white/[0.03]">
            <div className="min-w-0">
              <p className="truncate text-[12.5px] font-medium">
                <span className="text-[var(--cf-text-muted)]">#{group.prId}</span> {group.prTitle || group.projectName}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-[var(--cf-text-muted)]">
                {group.projectName} · {t("settings.memoryRunsCount", { n: group.runs.length })}
              </p>
            </div>
            <button
              onClick={() => void removePr(group)}
              title={t("settings.memoryDeletePr")}
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.06]"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="divide-y divide-[var(--cf-border)]">
            {group.runs.map((run) => (
              <div key={run.id}>
                <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
                  {/* Minutes, not seconds — the exact second is noise next to the level and counts. */}
                  <span className="shrink-0 tabular-nums text-[var(--cf-text-muted)]">
                    {run.created_at.slice(0, 16).replace("T", " ")}
                  </span>
                  <span className="shrink-0 rounded bg-black/[0.05] px-1.5 py-0.5 text-[10px] capitalize text-[var(--cf-text-muted)] dark:bg-white/[0.08]">
                    {run.level}
                  </span>
                  <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]">
                    {t("settings.memoryRunMeta", { iter: run.iter, n: run.findings_count })}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <RunAction
                      icon={expandedId === run.id ? ChevronDown : Eye}
                      label={t("settings.memoryView")}
                      onClick={() => void toggle(run)}
                    />
                    <RunAction
                      icon={Download}
                      label={t("settings.memoryExportOne")}
                      onClick={() => void exportRuns({ runId: run.id })}
                    />
                    <RunAction
                      icon={Trash2}
                      label={t("settings.memoryDeleteRun")}
                      danger
                      onClick={() => void removeRun(run)}
                    />
                  </div>
                </div>
                {expandedId === run.id && (
                  <div className="space-y-3 border-t border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3">
                    {detail === null ? (
                      <Skeleton className="h-24 w-full" />
                    ) : (
                      <>
                        <RunFindings detail={detail} onMarked={() => void refreshDetail(detail.id)} />
                        <div
                          className="cf-markdown-preview max-h-80 overflow-auto border-t border-[var(--cf-border)] pt-3 text-[12px]"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.review_md) }}
                        />
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Text action on a saved finding (ignore / false positive / clear). Padded into a pill on hover so
 * it reads as a control instead of stray 10px text. */
function MarkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
    >
      {label}
    </button>
  );
}

/** Square icon button for a run row. Sized to a 24px hit target with a hover surface — the bare
 * 12px icons had no hover feedback and were awkward to click. */
function RunAction({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
        danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-accent)]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/** The saved findings of one run, each with its lifecycle state and mark actions (false-positive /
 * ignored / clear). Marking updates the run's stored findings and carries forward on re-review. */
function RunFindings({ detail, onMarked }: { detail: ReviewRunDetail; onMarked: () => void }) {
  const t = useT();
  const findings = useMemo<SavedFinding[]>(() => {
    try {
      return JSON.parse(detail.findings) as SavedFinding[];
    } catch {
      return [];
    }
  }, [detail.findings]);

  if (findings.length === 0) {
    return <p className="text-[11px] text-[var(--cf-text-muted)]">{t("settings.memoryNoFindings")}</p>;
  }

  const mark = async (f: SavedFinding, estado: string) => {
    await markReviewFinding(detail.id, f.id, estado);
    onMarked();
  };

  return (
    <div className="space-y-0.5">
      {findings.map((f) => {
        const discarded = f.estado === "falso_positivo" || f.estado === "ignorado";
        const estado = ESTADOS[f.estado];
        const EstadoIcon = estado?.icon;
        return (
          // Discarded findings are dimmed so the state icon isn't the only cue that they're out.
          <div key={f.id} className={`flex items-center gap-2 text-[11.5px] ${discarded ? "opacity-55" : ""}`}>
            <span title={estado ? t(estado.labelKey) : f.estado} className={`shrink-0 ${estado?.color ?? ""}`}>
              {EstadoIcon ? <EstadoIcon size={12} /> : "•"}
            </span>
            <span className="shrink-0 font-mono text-[var(--cf-text-muted)]">{f.id}</span>
            <span className="min-w-0 truncate">
              {f.categoria}
              {f.archivo ? <span className="text-[var(--cf-text-muted)]"> · {f.archivo}</span> : null}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {discarded ? (
                <MarkButton label={t("settings.memoryUnmark")} onClick={() => void mark(f, "abierto")} />
              ) : (
                f.estado !== "resuelto" && (
                  <>
                    <MarkButton label={t("settings.memoryMarkIgnored")} onClick={() => void mark(f, "ignorado")} />
                    <MarkButton label={t("settings.memoryMarkFalse")} onClick={() => void mark(f, "falso_positivo")} />
                  </>
                )
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** One repository in the filter row, with how much memory it holds. */
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] ${
        active
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <span className="max-w-[180px] truncate">{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
