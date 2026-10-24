/**
 * The batch update's confirmation and its run (user, 2026-10-23: «un PR por repo con las versiones
 * nuevas, que el revisor revisa solo»).
 *
 * Push and PR are outward-facing, so nothing happens until this dialog has listed, per repository,
 * the branch, the PR's target, every manifest change and the lockfile command — and the user said
 * yes. Then, one repository at a time: branch + edits + lockfile + commit + push (backend), the pull
 * request through the host the project is linked to, and CodeFlow's AI review queued on it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, ExternalLink, GitPullRequest, Loader2, XCircle } from "lucide-react";
import { useT } from "../../state/languageStore";
import { createPullRequest, openExternalUrl } from "../../lib/tauri/commands";
import { depsUpdateApply, depsUpdatePlan, onDepsUpdateLine, type DepsOutcome, type DepsPlan, type DepsUpdateItem } from "../../lib/tauri/depsCommands";
import type { Project, PullRequestSummary } from "../../types/domain";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";

export interface DepsBatch {
  project: Project;
  items: DepsUpdateItem[];
}

type RepoState =
  | { phase: "planning" }
  | { phase: "planned"; plan: DepsPlan }
  | { phase: "planError"; error: string }
  | { phase: "running"; plan: DepsPlan }
  | { phase: "done"; plan: DepsPlan; outcome: DepsOutcome; pr: PullRequestSummary | null; prError: string | null }
  | { phase: "failed"; plan: DepsPlan; error: string }
  | { phase: "skipped"; plan: DepsPlan; reason: string };

function linkedHost(p: Project): boolean {
  return !!(p.ado_org || p.github_owner || p.gitlab_project || p.bitbucket_workspace);
}

export function DepsUpdateDialog({ batches, onClose }: { batches: DepsBatch[]; onClose: () => void }) {
  const t = useT();
  const [states, setStates] = useState<Record<string, RepoState>>(() =>
    Object.fromEntries(batches.map((b) => [b.project.id, { phase: "planning" } as RepoState])),
  );
  const [stage, setStage] = useState<"confirm" | "running" | "finished">("confirm");
  const [log, setLog] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    for (const b of batches) {
      depsUpdatePlan(b.project.id, b.items).then(
        (plan) => setStates((s) => ({ ...s, [b.project.id]: { phase: "planned", plan } })),
        (e: unknown) => setStates((s) => ({ ...s, [b.project.id]: { phase: "planError", error: String(e) } })),
      );
    }
    // Planned once, for the batches the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const un = onDepsUpdateLine((p) => {
      const name = batches.find((b) => b.project.id === p.projectId)?.project.name ?? "";
      setLog((l) => [...l.slice(-400), `[${name}] ${p.line}`]);
    });
    return () => void un.then((f) => f());
  }, [batches]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const planned = Object.values(states).every((s) => s.phase !== "planning");
  const runnable = batches.filter((b) => {
    const s = states[b.project.id];
    return s?.phase === "planned" && s.plan.dirty.length === 0;
  });

  const run = async () => {
    setStage("running");
    for (const b of batches) {
      const s = states[b.project.id];
      if (s?.phase !== "planned") continue;
      const plan = s.plan;
      if (plan.dirty.length > 0) {
        setStates((all) => ({ ...all, [b.project.id]: { phase: "skipped", plan, reason: t("deps.dirtySkipped", { files: plan.dirty.slice(0, 5).join(", ") }) } }));
        continue;
      }
      setStates((all) => ({ ...all, [b.project.id]: { phase: "running", plan } }));
      try {
        const outcome = await depsUpdateApply(b.project.id, b.items, plan.branch);
        let pr: PullRequestSummary | null = null;
        let prError: string | null = null;
        if (linkedHost(b.project)) {
          try {
            pr = await createPullRequest(b.project.id, outcome.prTitle, outcome.prBody, outcome.branch, outcome.target, false);
            // «que el revisor revisa solo»: the review is queued like any other, in the jobs list.
            // Loaded here rather than at the top: the PR store pulls in the agents' stores, which
            // the Revisor tab (and its tests) have no other reason to load.
            const { usePrStore } = await import("../../state/prStore");
            usePrStore.getState().reviewPr({ kind: "project", projectId: b.project.id }, pr);
          } catch (e) {
            prError = String(e);
          }
        } else {
          prError = t("deps.noHost");
        }
        setStates((all) => ({ ...all, [b.project.id]: { phase: "done", plan, outcome, pr, prError } }));
      } catch (e) {
        const message = String(e);
        const error = message.startsWith("dirty:")
          ? t("deps.dirtySkipped", { files: message.slice(6) })
          : message.startsWith("pushfail:")
            ? t("deps.pushFailed", { error: message.slice(9) })
            : message;
        setStates((all) => ({ ...all, [b.project.id]: { phase: "failed", plan, error } }));
      }
    }
    setStage("finished");
  };

  const totalChanges = useMemo(() => batches.reduce((n, b) => n + b.items.length, 0), [batches]);

  // Portalled: the Revisor's scroller would otherwise be the containing block of `fixed`.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={stage === "running" ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("deps.updateTitle")}
        onClick={(e) => e.stopPropagation()}
        className="cf-fade-in flex max-h-[86vh] w-[680px] max-w-[94vw] flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex items-start gap-3 border-b border-[var(--cf-border)] p-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            <GitPullRequest size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-[var(--cf-text)]">{t("deps.updateTitle")}</p>
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("deps.updateSubtitle", { repos: batches.length, changes: totalChanges })}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {batches.map((b) => (
            <RepoBlock key={b.project.id} batch={b} state={states[b.project.id]} />
          ))}
          {stage !== "confirm" && log.length > 0 && (
            <pre ref={logRef} className="max-h-40 overflow-auto rounded-md bg-[var(--cf-surface)] p-2 font-mono text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {log.join("\n")}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] p-3">
          {stage === "confirm" && <p className="mr-auto text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("deps.confirmNote")}</p>}
          {stage === "running" && (
            <span className="mr-auto flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("deps.running")}
            </span>
          )}
          <button type="button" disabled={stage === "running"} onClick={onClose} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {stage === "finished" ? t("deps.close") : t("deps.cancel")}
          </button>
          {stage === "confirm" && (
            <button type="button" disabled={!planned || runnable.length === 0} onClick={() => void run()} className={buttonClass({ variant: "primary", size: "sm" })}>
              {t("deps.confirmRun", { count: runnable.length })}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function RepoBlock({ batch, state }: { batch: DepsBatch; state: RepoState | undefined }) {
  const t = useT();
  const plan = state && "plan" in state ? state.plan : null;
  return (
    <section className="rounded-lg border border-[var(--cf-border)] p-3">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-[var(--cf-text)]">{batch.project.name}</span>
        {plan && (
          <span className={chipClass("neutral", "font-mono")}>
            {plan.branch} → {plan.target}
          </span>
        )}
        <span className="flex-1" />
        <StateChip state={state} />
      </div>
      {state?.phase === "planError" && <p className="text-[12px] text-[var(--cf-danger)]">{state.error}</p>}
      {plan && plan.dirty.length > 0 && (
        <p className="mb-1.5 flex items-start gap-1.5 text-[12px] text-[var(--cf-warning)]">
          <AlertTriangle size={13} className="mt-[1px] shrink-0" />
          {t("deps.dirtySkipped", { files: plan.dirty.slice(0, 5).join(", ") })}
        </p>
      )}
      {!linkedHost(batch.project) && <p className="mb-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("deps.noHost")}</p>}
      {plan && (
        <ul className="space-y-0.5 text-[12px]">
          {Object.entries(plan.files).map(([file, bumps]) => (
            <li key={file}>
              <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">{file}</span>
              <ul className="pl-3">
                {bumps.map((b) => (
                  <li key={`${b.section}|${b.key}`} className="font-mono text-[11.5px] text-[var(--cf-text)]">
                    {b.name} <span className="text-[var(--cf-text-muted)]">{b.from}</span> → {b.to}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {plan && (plan.lockSteps.length > 0 || plan.manualLocks.length > 0) && (
        <div className="mt-1.5 space-y-0.5 text-[11.5px]">
          {plan.lockSteps.map((s) => (
            <p key={s.lockfile} className={s.available ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-warning)]"}>
              <span className="font-mono">
                {s.dir ? `${s.dir}$ ` : "$ "}
                {s.program} {s.args.join(" ")}
              </span>
              {!s.available && ` — ${t("deps.toolMissing", { tool: s.program, lockfile: s.lockfile })}`}
            </p>
          ))}
          {plan.manualLocks.map((m) => (
            <p key={m} className="text-[var(--cf-warning)]">
              {t("deps.manualLock", { lockfile: m })}
            </p>
          ))}
        </div>
      )}
      {state?.phase === "done" && <Done state={state} />}
      {state?.phase === "failed" && <p className="mt-1.5 text-[12px] text-[var(--cf-danger)]">{state.error}</p>}
      {state?.phase === "skipped" && <p className="mt-1.5 text-[12px] text-[var(--cf-warning)]">{state.reason}</p>}
    </section>
  );
}

function Done({ state }: { state: Extract<RepoState, { phase: "done" }> }) {
  const t = useT();
  const { outcome, pr, prError } = state;
  return (
    <div className="mt-2 space-y-1 text-[12px]">
      <p className="text-[var(--cf-text-muted)]">{t("deps.committed", { commit: outcome.commit, branch: outcome.branch })}</p>
      {outcome.skipped.length > 0 && <p className="text-[var(--cf-warning)]">{t("deps.skippedBumps", { list: outcome.skipped.join(", ") })}</p>}
      {outcome.manualLocks.length > 0 && <p className="text-[var(--cf-warning)]">{t("deps.manualLock", { lockfile: outcome.manualLocks.join(", ") })}</p>}
      {pr && (
        <button type="button" onClick={() => void openExternalUrl(pr.url).catch(() => {})} className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline">
          {t("deps.prOpened", { id: pr.id })}
          <ExternalLink size={11} />
        </button>
      )}
      {pr && <p className="text-[var(--cf-text-muted)]">{t("deps.reviewQueued")}</p>}
      {prError && <p className="text-[var(--cf-warning)]">{prError}</p>}
    </div>
  );
}

function StateChip({ state }: { state: RepoState | undefined }) {
  const t = useT();
  switch (state?.phase) {
    case "planning":
    case "running":
      return <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" />;
    case "done":
      return (
        <span className={chipClass("ok")}>
          <CheckCircle2 size={11} />
          {t("deps.stateDone")}
        </span>
      );
    case "failed":
    case "planError":
      return (
        <span className={chipClass("bad")}>
          <XCircle size={11} />
          {t("deps.stateFailed")}
        </span>
      );
    case "skipped":
      return <span className={chipClass("warn")}>{t("deps.stateSkipped")}</span>;
    default:
      return null;
  }
}
