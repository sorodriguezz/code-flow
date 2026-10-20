import { useEffect, useMemo, useState } from "react";
import { ChevronRight, CircleStop, FlaskConical, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Select } from "../common/Select";
import { chipClass } from "../common/recipes";
import { Note, Status } from "../api/settingsChrome";
import { formatBytes } from "./localModelRow";
import { useT } from "../../state/languageStore";
import { useEvalStore } from "../../state/evalStore";
import { useLocalExecStore } from "../../state/localExecStore";
import {
  aiEvalCompare,
  aiRuntimeStatus,
  aiToolAuditList,
  currentVerdict,
  type AuditRow,
  type EvalComparison,
  type EvaluationRow,
  type RuntimeStatus,
} from "../../lib/tauri/evalsCommands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";

/**
 * Settings › Diagnóstico: the bench (`crate::evals`) and the model registry, side by side.
 *
 * A run measures the model the «Local model» pane has chosen, on this machine: speed, tool-call
 * conformance, and real tasks run through the «CodeFlow» provider. Runs are kept, so a model can be
 * compared with another, with itself on another machine, or with its fine-tuned adapter — the
 * comparison names the tasks that got worse, which is what decides whether a change is kept.
 */
export function AiDiagnosticsSettings() {
  const t = useT();
  const { running, progress, history, registry, lastError, load, run, cancel, remove } = useEvalStore();
  const local = useLocalExecStore((s) => s.state);
  const loadLocal = useLocalExecStore((s) => s.load);
  const [runs, setRuns] = useState("1");
  const [open, setOpen] = useState<string | null>(null);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [comparison, setComparison] = useState<EvalComparison | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // What is loaded right now, and what agents did — read when the pane opens and after a run, never
  // on a timer.
  useEffect(() => {
    void aiRuntimeStatus().then(setRuntime).catch(() => setRuntime(null));
    void aiToolAuditList(workspaceId, 30).then(setAudit).catch(() => setAudit([]));
  }, [workspaceId, running]);

  useEffect(() => {
    void load();
    if (!local) void loadLocal();
  }, [load, loadLocal, local]);

  useEffect(() => {
    setComparison(null);
    if (!before || !after || before === after) return;
    void aiEvalCompare(before, after)
      .then(setComparison)
      .catch((e: unknown) => pushErrorToast(String(e)));
  }, [before, after]);

  const model = local?.model ?? null;
  const record = registry.find((r) => r.id === `${local?.backend ?? ""}|${model ?? ""}`);
  const verdict = currentVerdict(record);
  const modelLabel = local?.models.find((m) => m.id === model)?.label ?? model;
  const canRun = !running && !!local?.reachable && model !== null;
  const options = useMemo(
    () =>
      history.map((row) => ({
        value: row.id,
        label: `${row.model} · ${Math.round(row.score * 100)}% · ${new Date(row.created_at).toLocaleDateString()}`,
      })),
    [history],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--cf-text)]">
          <span className="font-medium">{modelLabel ?? t("evals.noModel")}</span>
          {local && <span className="text-[11px] text-[var(--cf-text-muted)]">{local.backend}</span>}
          {model && (
            <span className={chipClass(verdict === true ? "ok" : verdict === false ? "warn" : "neutral")}>
              {verdict === true ? t("evals.toolsVerified") : verdict === false ? t("evals.toolsFailed") : t("evals.toolsUntested")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run({ suites: ["tools"] })}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <ShieldCheck size={13} />
            {t("evals.verifyTools")}
          </button>
          <button
            type="button"
            disabled={!canRun}
            onClick={() => void run({ runs: Number(runs) })}
            className={buttonClass({ variant: "secondary", size: "sm" })}
          >
            <FlaskConical size={13} />
            {t("evals.runBench")}
          </button>
          <div className="w-[96px]">
            <Select
              size="sm"
              value={runs}
              ariaLabel={t("evals.runs")}
              disabled={running}
              onChange={setRuns}
              options={["1", "3", "5"].map((n) => ({ value: n, label: t("evals.runsN", { n }) }))}
            />
          </div>
          {running && (
            <>
              <span role="status" className="flex items-center gap-1.5 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                <Loader2 size={12} className="animate-spin" />
                {progress
                  ? t("evals.step", { done: String(progress.done + 1), total: String(progress.total), step: progress.step })
                  : t("evals.starting")}
              </span>
              <button type="button" onClick={() => void cancel()} className={buttonClass({ variant: "ghost", size: "sm" })}>
                <CircleStop size={13} /> {t("evals.stop")}
              </button>
            </>
          )}
        </div>
        {lastError && <Note tone="warning">{lastError === "busy" ? t("evals.busy") : lastError}</Note>}
      </div>

      {runtime && (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.now")}</span>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {[
              runtime.executor && t("evals.loadedExecutor", { model: runtime.executor }),
              runtime.completion && t("evals.loadedCompletion", { model: runtime.completion }),
              runtime.embedder && t("evals.loadedEmbedder", { model: runtime.embedder }),
              ...runtime.ollama.map(([model, bytes, vram]) =>
                t("evals.loadedOllama", { model, size: formatBytes(bytes), gpu: String(bytes > 0 ? Math.round((vram / bytes) * 100) : 0) }),
              ),
            ]
              .filter(Boolean)
              .map((label) => (
                <span key={String(label)} className={chipClass("neutral")}>
                  {label}
                </span>
              ))}
            {!runtime.executor && !runtime.completion && !runtime.embedder && runtime.ollama.length === 0 && (
              <span className="text-[var(--cf-text-muted)]">{t("evals.nothingLoaded")}</span>
            )}
            <span className={chipClass(runtime.pressure === "critical" ? "bad" : runtime.pressure === "warning" ? "warn" : "ok")}>
              {t(runtime.pressure === "critical" ? "evals.pressureCritical" : runtime.pressure === "warning" ? "evals.pressureWarning" : "evals.pressureNormal")}
            </span>
            <span className={chipClass(runtime.sandbox ? "ok" : "warn")}>{t(runtime.sandbox ? "evals.sandboxOn" : "evals.sandboxOff")}</span>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.history")}</span>
        {history.length === 0 ? (
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.noHistory")}</span>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
            {history.map((row) => (
              <HistoryRow key={row.id} row={row} open={open === row.id} onToggle={() => setOpen(open === row.id ? null : row.id)} onDelete={() => void remove(row.id)} />
            ))}
          </div>
        )}
      </div>

      {history.length >= 2 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.compare")}</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-[260px]">
              <Select size="sm" value={before} placeholder={t("evals.before")} ariaLabel={t("evals.before")} onChange={setBefore} options={options} />
            </div>
            <div className="w-[260px]">
              <Select size="sm" value={after} placeholder={t("evals.after")} ariaLabel={t("evals.after")} onChange={setAfter} options={options} />
            </div>
          </div>
          {comparison && (
            <div className="flex flex-col gap-1">
              <span className="text-[12px] tabular-nums text-[var(--cf-text)]">
                {Math.round(comparison.score_before * 100)}% → {Math.round(comparison.score_after * 100)}%
                {comparison.tools_before !== null && comparison.tools_after !== null &&
                  ` · ${t("evals.toolsShort")} ${comparison.tools_before} → ${comparison.tools_after}`}
              </span>
              {comparison.tasks.map((task) => (
                <span key={task.id} className="font-mono text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                  {task.id} {task.before[0]}/{task.before[1]} → {task.after[0]}/{task.after[1]}
                  {task.seconds_before !== null && task.seconds_after !== null &&
                    ` · ${Math.round(task.seconds_before)} s → ${Math.round(task.seconds_after)} s`}
                </span>
              ))}
              <Status tone={comparison.regressions.length > 0 ? "warning" : "success"}>
                {comparison.regressions.length > 0
                  ? t("evals.regressions", { tasks: comparison.regressions.join(", ") })
                  : t("evals.noRegressions")}
              </Status>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.audit")}</span>
        {audit.length === 0 ? (
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.noAudit")}</span>
        ) : (
          <div className="max-h-[220px] overflow-y-auto rounded-lg border border-[var(--cf-border)]">
            {audit.map((row, index) => (
              <div key={`${row.at}-${index}`} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1 last:border-b-0">
                <span className={chipClass(row.outcome === "ok" ? "ok" : "warn")}>{row.tool}</span>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{row.level}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text)]" title={row.args}>
                  {row.detail || row.args}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">{new Date(row.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.models")}</span>
        {registry.length === 0 ? (
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("evals.noModels")}</span>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
            {registry.map((rec) => {
              const v = currentVerdict(rec);
              return (
                <div key={rec.id} className="flex flex-wrap items-center gap-1.5 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
                  <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{rec.model}</span>
                  <span className="text-[11px] text-[var(--cf-text-muted)]">{rec.backend}</span>
                  {rec.family && <span className="text-[11px] text-[var(--cf-text-muted)]">{rec.family}</span>}
                  {rec.declared.tools && <span className={chipClass("neutral")}>{t("evals.capTools")}</span>}
                  {rec.declared.thinking && <span className={chipClass("neutral")}>{t("evals.capThinking")}</span>}
                  {rec.declared.vision && <span className={chipClass("neutral")}>{t("evals.capVision")}</span>}
                  <span className={chipClass(v === true ? "ok" : v === false ? "warn" : "neutral", "ml-auto")}>
                    {v === true ? t("evals.toolsVerified") : v === false ? t("evals.toolsFailed") : t("evals.toolsUntested")}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ row, open, onToggle, onDelete }: { row: EvaluationRow; open: boolean; onToggle: () => void; onDelete: () => void }) {
  const t = useT();
  const { report } = row;
  const speed = report.speed?.gen_tps;
  return (
    <div className="border-b border-[var(--cf-border)] last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-start gap-1.5 text-left" aria-expanded={open}>
          <ChevronRight size={13} className={`mt-[3px] shrink-0 text-[var(--cf-text-muted)] ${open ? "rotate-90" : ""}`} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{row.model}</span>
              {row.adapter_id && <span className={chipClass("accent")}>{t("evals.adapter")}</span>}
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-[var(--cf-text)]">{Math.round(row.score * 100)}%</span>
              <span className="ml-auto shrink-0 text-[11px] text-[var(--cf-text-muted)]">{new Date(row.created_at).toLocaleString()}</span>
            </span>
            <span className="truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">
              {[
                row.tools_passed !== null && row.tools_total !== null
                  ? t("evals.toolsScore", { passed: String(row.tools_passed), total: String(row.tools_total) })
                  : null,
                speed != null ? t("evals.writeSpeed", { tps: speed.toFixed(1) }) : null,
                `${report.machine.gpu_name ?? report.machine.arch} · ${report.machine.ram_gb} GB`,
                report.backend,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        </button>
        <button type="button" onClick={onDelete} title={t("evals.delete")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          <Trash2 size={13} />
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 px-8 pb-2">
          {report.aborted && <Note tone="warning">{report.aborted}</Note>}
          {report.peak_rss_bytes !== null && (
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("evals.peak", { size: formatBytes(report.peak_rss_bytes) })}</span>
          )}
          {report.conformance?.cases
            .filter((c) => !c.passed)
            .map((c) => (
              <span key={c.id} className="font-mono text-[11px] text-[var(--cf-warning)]">
                ✗ {c.id}: {c.detail}
              </span>
            ))}
          {report.tasks.map((task) => (
            <div key={task.id} className="flex flex-col">
              <span className="font-mono text-[11px] tabular-nums text-[var(--cf-text)]">
                {task.id}{" "}
                {task.skipped
                  ? t("evals.skipped", { why: task.skipped })
                  : `${task.passed}/${task.runs}${task.seconds.length ? ` · ${Math.round(task.seconds.reduce((a, b) => a + b, 0) / task.seconds.length)} s` : ""}`}
              </span>
              {task.failures.map((failure, i) => (
                <span key={i} className="pl-3 text-[11px] text-[var(--cf-warning)]">
                  {failure}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
