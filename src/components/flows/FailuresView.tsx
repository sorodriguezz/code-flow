import { useEffect, useMemo, useState } from "react";
import { CircleX, LoaderCircle, RefreshCw } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { flowsFailedRuns, type FlowRunRow } from "../../lib/tauri/flowsCommands";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { formatWhen } from "./runFormat";

/**
 * «Fallos»: every failed execution of the workspace, newest first, whichever flow it belonged to —
 * what broke overnight, without opening each flow's history to find out. Grouped under the flow it
 * failed in when one keeps failing, so a single broken flow does not bury the rest. A row opens
 * that run in its flow's executions.
 */
export function FailuresView() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [runs, setRuns] = useState<FlowRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    setRuns(null);
    void flowsFailedRuns(workspaceId)
      .then((rows) => live && setRuns(rows))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId, nonce]);

  const byFlow = useMemo(() => {
    const groups = new Map<string, FlowRunRow[]>();
    for (const run of runs ?? []) groups.set(run.flowId, [...(groups.get(run.flowId) ?? []), run]);
    return [...groups.values()];
  }, [runs]);

  const open = (run: FlowRunRow) => {
    void useFlowsStore
      .getState()
      .openFlow(run.flowId)
      .then(() => {
        useFlowRunsStore.getState().setPane("executions");
        useFlowRunsStore.getState().selectRun(run.id, run.errorNode || null);
      });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4">
        <CircleX size={15} className="text-[var(--cf-danger)]" />
        <span className="text-[13px] font-semibold text-[var(--cf-text)]">{t("flows.failures.title")}</span>
        {runs && <span className="text-[12px] tabular-nums text-[var(--cf-text-muted)]">{runs.length}</span>}
        <span className="flex-1" />
        <Tooltip label={t("flows.failures.refresh")}>
          <button type="button" onClick={() => setNonce((n) => n + 1)} className={iconButtonClass({ size: "sm" })} aria-label={t("flows.failures.refresh")}>
            <RefreshCw size={13} />
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {error ? (
          <p className="text-[12.5px] text-[var(--cf-danger)]">{error}</p>
        ) : !runs ? (
          <LoaderCircle size={16} className="animate-spin text-[var(--cf-text-muted)]" />
        ) : runs.length === 0 ? (
          <p className="text-[12.5px] text-[var(--cf-text-muted)]">{t("flows.failures.none")}</p>
        ) : (
          byFlow.map((group) => (
            <section key={group[0].flowId} className="mb-4">
              <h4 className="mb-1 flex items-center gap-2 text-[12px] font-semibold text-[var(--cf-text)]">
                {group[0].flowName}
                <span className="font-normal tabular-nums text-[var(--cf-text-muted)]">{t("flows.failures.count", { n: group.length })}</span>
              </h4>
              <div className="divide-y divide-[var(--cf-border)] overflow-hidden rounded-md border border-[var(--cf-border)]">
                {group.map((run) => (
                  <button key={run.id} type="button" onClick={() => open(run)} className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--cf-hover)]">
                    <span className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
                      <span className="tabular-nums">{formatWhen(run.startedAt, language)}</span>
                      <span>·</span>
                      <span>{run.mode}</span>
                      {run.errorNode && (
                        <>
                          <span>·</span>
                          <span className="font-mono">{run.errorNode}</span>
                        </>
                      )}
                    </span>
                    <span className="line-clamp-2 text-[12.5px] text-[var(--cf-danger)]">{run.error || t("flows.failures.noMessage")}</span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
