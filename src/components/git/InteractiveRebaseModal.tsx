import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, GitPullRequestArrow, Loader2 } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Select } from "../common/Select";
import { buttonClass, iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { SkeletonRows } from "../common/Skeleton";
import { rebaseInteractive, rebasePlan, type RebaseStep } from "../../lib/tauri/commands";
import { describeGitError, stoppedOperation } from "../../lib/gitErrors";
import { rebasePlanProblem } from "../../lib/rebasePlan";
import { useRepoStore } from "../../state/repoStore";
import { useUiStore } from "../../state/uiStore";
import { pushSuccessToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { CommitInfo } from "../../types/domain";

type Action = RebaseStep["action"];

interface Line {
  commit: CommitInfo;
  action: Action;
  message: string;
  /** The commit's own message, as it came. */
  original: string;
}

const ACTIONS: Action[] = ["pick", "reword", "squash", "fixup", "drop"];

/**
 * «Rebase interactivo desde aquí»: every commit after `base` up to HEAD, newest on top as the graph
 * draws them, each with what to do to it — keep, reword, squash or fix up into the one below, drop —
 * and arrows to reorder. Git runs the plan (`rebase_interactive`); a step that conflicts stops the
 * rebase for the conflicts banner, which continues or aborts it.
 */
export function InteractiveRebaseModal({ base, onClose }: { base: CommitInfo; onClose: () => void }) {
  const t = useT();
  const repoPath = useRepoStore((s) => s.repoPath);
  const unpushed = useRepoStore((s) => s.unpushedCommits);
  const upstream = useRepoStore((s) => s.branches.find((b) => b.is_head)?.upstream ?? null);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  /** The order the plan arrived in, to tell an untouched plan from one worth running. */
  const [loaded, setLoaded] = useState<string[] | null>(null);

  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    void rebasePlan(repoPath, base.id).then(
      (plan) => {
        if (!live) return;
        const newestFirst = [...plan].reverse();
        setLoaded(newestFirst.map((commit) => commit.id));
        setLines(
          newestFirst.map((commit) => {
            const original = commit.message || commit.summary;
            return { commit, action: "pick", message: original, original };
          }),
        );
      },
      (e: unknown) => live && setError(describeGitError(e, t)),
    );
    return () => {
      live = false;
    };
  }, [repoPath, base.id, t]);

  /** Oldest first, as git reads it. */
  const steps = useMemo<RebaseStep[]>(
    () =>
      [...(lines ?? [])].reverse().map((line) => ({
        action: line.action,
        oid: line.commit.id,
        // A squash keeps git's combined message unless this one was edited.
        message:
          line.action === "reword" || (line.action === "squash" && line.message.trim() !== line.original.trim())
            ? line.message
            : null,
      })),
    [lines],
  );
  const problem = lines ? rebasePlanProblem(steps) : null;
  // Nothing to do while every line is still a pick in the order it came in.
  const unchanged =
    !!lines && !!loaded && lines.every((line, i) => line.action === "pick" && line.commit.id === loaded[i]);
  const rewritesPushed = !!upstream && !!lines && lines.some((line) => !unpushed.some((c) => c.id === line.commit.id));

  const update = (index: number, patch: Partial<Line>) =>
    setLines((all) => all && all.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const move = (index: number, by: number) =>
    setLines((all) => {
      if (!all) return all;
      const to = index + by;
      if (to < 0 || to >= all.length) return all;
      const next = [...all];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });

  const run = async () => {
    if (!repoPath || problem) return;
    setRunning(true);
    try {
      await rebaseInteractive(repoPath, base.id, steps);
      await useRepoStore.getState().refreshAll();
      pushSuccessToast(t("rebase.done"));
      onClose();
    } catch (e) {
      // Stopped on a conflict: the rebase is in progress, and the banner in Changes carries it on.
      if (stoppedOperation(e)) {
        await useRepoStore.getState().refreshAll().catch(() => {});
        useUiStore.getState().setActiveView("changes");
        useToastStore.getState().pushToast(describeGitError(e, t), "info");
        onClose();
        return;
      }
      await useRepoStore.getState().refreshAll().catch(() => {});
      setError(describeGitError(e, t));
    } finally {
      setRunning(false);
    }
  };

  const options = ACTIONS.map((action) => ({ value: action, label: t(`rebase.action.${action}` as Parameters<typeof t>[0]) }));

  return (
    <ApiModal
      icon={GitPullRequestArrow}
      title={t("rebase.title")}
      subtitle={t("rebase.subtitle", { id: base.short_id, summary: base.summary })}
      width="max-w-3xl"
      busy={running}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 text-[12px] text-[var(--cf-danger)]">{problem ? t(problem) : ""}</span>
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={!lines || !!problem || running || unchanged}
            onClick={() => void run()}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            {running && <Loader2 size={13} className="animate-spin" />}
            {t("rebase.start")}
          </button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {error && <p className="text-[12px] text-[var(--cf-danger)]">{error}</p>}
        {rewritesPushed && <p className="text-[12px] text-[var(--cf-warning)]">{t("rebase.pushedWarning", { upstream: upstream ?? "" })}</p>}
        {!lines && !error && <SkeletonRows count={5} />}
        {lines?.map((line, index) => (
          <div
            key={line.commit.id}
            className={`flex flex-col gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 ${
              line.action === "drop" ? "opacity-50" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              <div className="w-[130px] shrink-0">
                <Select
                  size="sm"
                  value={line.action}
                  onChange={(value) => update(index, { action: value as Action })}
                  options={options}
                  ariaLabel={t("rebase.actionLabel")}
                />
              </div>
              <span className="shrink-0 font-mono text-[12px] text-[var(--cf-text-faint)]">{line.commit.short_id}</span>
              <span className={`min-w-0 flex-1 truncate text-[13px] ${line.action === "drop" ? "line-through" : ""}`}>
                {line.commit.summary}
              </span>
              <button
                type="button"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t("rebase.moveUp")}
                title={t("rebase.moveUp")}
                className={iconButtonClass({ size: "xs" })}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                onClick={() => move(index, 1)}
                disabled={index === lines.length - 1}
                aria-label={t("rebase.moveDown")}
                title={t("rebase.moveDown")}
                className={iconButtonClass({ size: "xs" })}
              >
                <ArrowDown size={13} />
              </button>
            </div>
            {(line.action === "reword" || line.action === "squash") && (
              <textarea
                value={line.message}
                onChange={(e) => update(index, { message: e.target.value })}
                rows={Math.min(8, Math.max(2, line.message.split("\n").length))}
                placeholder={line.action === "squash" ? t("rebase.squashMessage") : t("rebase.rewordMessage")}
                aria-label={t("rebase.rewordMessage")}
                className={fieldClass({ size: "sm", className: "h-auto w-full resize-y py-1 font-mono" })}
              />
            )}
          </div>
        ))}
        {lines && <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("rebase.hint")}</p>}
      </div>
    </ApiModal>
  );
}
