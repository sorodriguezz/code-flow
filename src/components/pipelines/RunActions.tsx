/**
 * What you can *do* to the run you are looking at.
 *
 * Pipelines shipped read-only: it listed runs, drew the waterfall and showed the log, and every
 * verb — re-run, re-run the failed jobs, cancel — meant leaving for the browser. Which is to say
 * the screen answered "what happened" and then handed you back to the web UI for "do it again",
 * which is the moment you actually wanted to be in the app.
 *
 * **The three hosts do not agree on what "run it again" means**, and this says so rather than
 * offering one button that quietly does three different things:
 *
 * - **GitHub** has both: re-run everything, or re-run only the jobs that failed.
 * - **GitLab**'s `retry` *is* the failed-jobs one — it reuses every job that succeeded. There is no
 *   "run the whole thing again" verb, so only one button appears.
 * - **Azure** has neither. A build is queued from its *definition*, so re-running means queuing a
 *   new build on the same branch and commit — a new build number, which the label says.
 */

import { useState } from "react";
import { ExternalLink, RefreshCw, RotateCcw, Square } from "lucide-react";
import { cancelPipeline, openExternalUrl, rerunPipeline } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { useCiStore } from "../../state/ciStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { PipelineRun } from "../../types/domain";

/** Which re-run verbs a provider actually has. See the header. */
function rerunOptions(provider: string): { all: boolean; failed: boolean } {
  switch (provider) {
    case "github":
      return { all: true, failed: true };
    case "gitlab":
      // `retry` already means "the failed ones", so offering both would be the same button twice.
      return { all: false, failed: true };
    default:
      // Azure: a re-queue of the definition. Whole run only, and the label says it is a new build.
      return { all: true, failed: false };
  }
}

export function RunActions({ projectId, run }: { projectId: string; run: PipelineRun }) {
  const t = useT();
  const [busy, setBusy] = useState<"rerun" | "failed" | "cancel" | null>(null);
  const load = useCiStore((s) => s.load);
  const selectRun = useCiStore((s) => s.selectRun);

  const live = run.status === "running" || run.status === "queued";
  const options = rerunOptions(run.provider);
  const azure = run.provider === "azure";

  const act = async (
    kind: "rerun" | "failed" | "cancel",
    work: () => Promise<void>,
    done: string,
  ) => {
    setBusy(kind);
    try {
      await work();
      pushSuccessToast(done);
      // The host needs a beat to move the run out of its old status, and the list is what the user
      // is looking at. A quiet reload rather than a spinner over the whole screen — `watch` will
      // keep polling from here, because the run is live again.
      await load(projectId, { quiet: true });
      await selectRun(projectId, run).catch(() => {});
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };

  const button = (
    kind: "rerun" | "failed" | "cancel",
    label: string,
    Icon: typeof RefreshCw,
    onClick: () => void,
    danger = false,
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={busy !== null}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] transition-colors disabled:opacity-50 ${
        danger
          ? "border-[var(--cf-danger)]/40 text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)]"
          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={11} className={busy === kind ? "animate-spin" : ""} />
      {/* No truncation: these labels differ from each other by their last word — "re-run" versus
          "re-run failed jobs" — so a cut one is a button whose verb you cannot tell apart. */}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-1.5">
      {live
        ? button(
            "cancel",
            t("pipelines.cancel"),
            Square,
            () =>
              void (async () => {
                if (!(await confirmAction(t("pipelines.cancelConfirm"), true, t("pipelines.cancel")))) return;
                await act("cancel", () => cancelPipeline(projectId, run.id), t("pipelines.cancelDone"));
              })(),
            true,
          )
        : null}

      {options.all &&
        button(
          "rerun",
          azure ? t("pipelines.requeue") : t("pipelines.rerun"),
          RefreshCw,
          () =>
            void (async () => {
              const message = azure ? t("pipelines.requeueConfirm") : t("pipelines.rerunConfirm");
              if (!(await confirmAction(message, false, t("pipelines.rerun")))) return;
              await act("rerun", () => rerunPipeline(projectId, run.id, false), t("pipelines.rerunDone"));
            })(),
        )}

      {options.failed &&
        button(
          "failed",
          t("pipelines.rerunFailed"),
          RotateCcw,
          () =>
            void (async () => {
              if (!(await confirmAction(t("pipelines.rerunFailedConfirm"), false, t("pipelines.rerunFailed"))))
                return;
              await act("failed", () => rerunPipeline(projectId, run.id, true), t("pipelines.rerunDone"));
            })(),
        )}

      <span className="min-w-0 flex-1" />

      {run.web_url && (
        <button
          type="button"
          onClick={() => void openExternalUrl(run.web_url).catch((e: unknown) => pushErrorToast(String(e)))}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-accent)]"
        >
          {t("pipelines.openOnHost")}
          <ExternalLink size={10} />
        </button>
      )}
    </div>
  );
}
