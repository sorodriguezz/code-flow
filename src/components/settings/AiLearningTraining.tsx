import { useCallback, useEffect, useState } from "react";
import { Check, FileText, FlaskConical, Loader2, Pencil, Play, Plus, RotateCcw, Square, Trash2, Undo2, Upload } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { chipClass, type ChipTone } from "../common/recipes";
import { Note } from "../api/settingsChrome";
import { useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { promptAction } from "../../state/promptStore";
import { pushErrorToast } from "../../state/toastStore";
import { onAiLearning } from "../../lib/tauri/events";
import {
  learningBuildDataset,
  learningCancelEvaluation,
  learningCancelRun,
  learningDeleteAdapter,
  learningDeleteDataset,
  learningDeleteRun,
  learningEvaluate,
  learningOverview,
  learningPrepareEnv,
  learningPublish,
  learningRenameAdapter,
  learningResumeRun,
  learningRollback,
  learningRunLog,
  learningSetMode,
  learningStartRun,
  type Adapter,
  type AdapterStatus,
  type GateSummary,
  type LearningBase,
  type LearningMode,
  type LearningOverview,
  type RunStatus,
  type TrainProgress,
  type TrainingRun,
} from "../../lib/tauri/learningCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

const RUN_TONE: Record<RunStatus, ChipTone> = { queued: "neutral", running: "info", done: "ok", failed: "bad", cancelled: "neutral" };
const RUN_KEY: Record<RunStatus, TranslationKey> = {
  queued: "learning.runQueued",
  running: "learning.runRunning",
  done: "learning.runDone",
  failed: "learning.runFailed",
  cancelled: "learning.runCancelled",
};
const ADAPTER_TONE: Record<AdapterStatus, ChipTone> = { candidate: "neutral", approved: "ok", rejected: "warn", published: "accent", retired: "neutral" };
const ADAPTER_KEY: Record<AdapterStatus, TranslationKey> = {
  candidate: "learning.adapterCandidate",
  approved: "learning.adapterApproved",
  rejected: "learning.adapterRejected",
  published: "learning.adapterPublished",
  retired: "learning.adapterRetired",
};
const MODE_HINT: Record<LearningMode, TranslationKey> = {
  manual: "learning.modeManualHint",
  assisted: "learning.modeAssistedHint",
  supervised: "learning.modeSupervisedHint",
};

const rowClass = "flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0";
const listClass = "overflow-hidden rounded-lg border border-[var(--cf-border)]";
const labelClass = "text-[12px] text-[var(--cf-text-muted)]";
const subClass = "text-[11px] leading-snug text-[var(--cf-text-muted)]";
const iconButton = buttonClass({ variant: "ghost", size: "sm" });

function loss(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(2);
}

/** One line of a run's numbers: the step, validation loss from where it started, speed, memory. */
function progressLine(progress: TrainProgress, t: ReturnType<typeof useT>): string {
  const parts = [t("learning.step", { n: String(progress.iter), total: String(progress.iters) })];
  if (progress.firstValLoss != null || progress.valLoss != null) {
    parts.push(t("learning.valLoss", { from: loss(progress.firstValLoss), to: loss(progress.valLoss) }));
  }
  if (progress.tokensPerSec) parts.push(`${Math.round(progress.tokensPerSec)} tok/s`);
  if (progress.peakMemGb) parts.push(`${progress.peakMemGb.toFixed(1)} GB`);
  return parts.join(" · ");
}

function BaseLine({ base, cuda, t }: { base: LearningBase; cuda: boolean; t: ReturnType<typeof useT> }) {
  const validation =
    base.validated === true
      ? { tone: "ok" as const, key: base.proven ? ("learning.baseProven" as const) : ("learning.baseValidated" as const) }
      : base.validated === false
        ? { tone: "bad" as const, key: "learning.baseFailedHere" as const }
        : { tone: "warn" as const, key: "learning.baseUnvalidated" as const };
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[12px] text-[var(--cf-text)]">{base.label}</span>
        <span className={chipClass(validation.tone)} title={validation.key === "learning.baseUnvalidated" ? t("learning.baseUnvalidatedHint") : undefined}>
          {t(validation.key)}
        </span>
        {!base.fits && <span className={chipClass("warn")}>{t("learning.baseTooBig", { gb: String(base.minRamGb) })}</span>}
        {cuda && !base.gguf && (
          <span className={chipClass("warn")} title={t("learning.evaluateNoGguf", { base: base.label })}>
            {t("learning.baseNoServe")}
          </span>
        )}
      </span>
      <span className={`${subClass} truncate`}>
        {base.downloaded ? t("learning.baseDownloaded") : t("learning.baseDownload", { gb: base.approxGb.toFixed(1) })} · {base.licence}
      </span>
    </span>
  );
}

/** Why the gate refused, in the reader's language. */
function gateReasons(gate: GateSummary, t: ReturnType<typeof useT>): string[] {
  const reasons: string[] = [];
  if (gate.aborted) reasons.push(t("learning.gateAborted"));
  if (gate.regressions.length > 0) reasons.push(t("learning.gateLoses", { tasks: gate.regressions.join(", ") }));
  if (gate.scoreAfter < gate.scoreBefore) reasons.push(t("learning.gateScoreDrop"));
  if (gate.toolsBefore != null && gate.toolsAfter != null && gate.toolsAfter < gate.toolsBefore) reasons.push(t("learning.gateToolsDrop"));
  return reasons;
}

/**
 * Settings › Aprendizaje, the training half (`crate::learning`): the environment, the base, datasets
 * built from approved experiences, LoRA runs, and the adapters they leave — evaluated against their
 * base before anything reaches a model picker.
 */
export function AiLearningTraining() {
  const t = useT();
  const ask = useConfirmStore((s) => s.ask);
  const [overview, setOverview] = useState<LearningOverview | null>(null);
  const [baseId, setBaseId] = useState<string | null>(null);
  const [envLine, setEnvLine] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, TrainProgress>>({});
  const [evalLine, setEvalLine] = useState<string | null>(null);
  const [log, setLog] = useState<{ id: string; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await learningOverview();
      setOverview(next);
      setBaseId((current) => current ?? next.base ?? next.bases.find((b) => b.proven && b.fits)?.id ?? next.bases[0]?.id ?? null);
    } catch (e) {
      pushErrorToast(String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    const unlisten = onAiLearning((event) => {
      if (event.kind === "env") {
        setEnvLine(event.state === "running" ? event.line : event.state === "failed" ? event.line : null);
        if (event.state !== "running") void reload();
        return;
      }
      if (event.kind === "train") {
        const progress = event.progress;
        if (progress && "iter" in progress) setLive((current) => ({ ...current, [event.id]: progress }));
        if (event.state !== "running") {
          if (event.state === "failed" && event.line) pushErrorToast(event.line);
          void reload();
        }
        return;
      }
      if (event.kind === "eval") {
        setEvalLine(event.state === "running" ? event.line : null);
        if (event.state === "failed" && event.line) pushErrorToast(event.line);
        if (event.state !== "running") void reload();
        return;
      }
      void reload();
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, [reload]);

  if (!overview) return null;

  const { env } = overview;
  const base = overview.bases.find((b) => b.id === baseId) ?? null;
  const busy = overview.running !== null;
  const canTrain = env.ready && !busy && !overview.memoryCritical && base !== null && base.fits;
  const baseLabel = (id: string) => overview.bases.find((b) => b.id === id)?.label ?? id;
  const datasetName = (id: string | null) => overview.datasets.find((d) => d.id === id)?.name ?? null;
  const act = (work: Promise<unknown>) => void work.then(reload).catch((e: unknown) => pushErrorToast(String(e)));

  const chooseBase = (id: string) => {
    setBaseId(id);
    void learningSetMode(overview.mode, id).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const buildDataset = async () => {
    const name = await promptAction(t("learning.datasetName"), { initial: new Date().toLocaleDateString(), confirmLabel: t("learning.datasetCreate") });
    if (name === null) return;
    act(learningBuildDataset(name));
  };

  const train = (datasetId: string) => {
    if (!base) return;
    act(learningStartRun(datasetId, base.id));
  };

  const showLog = async (run: TrainingRun) => {
    if (log?.id === run.id) return setLog(null);
    try {
      setLog({ id: run.id, text: (await learningRunLog(run.id)) || t("learning.logEmpty") });
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const publish = async (adapter: Adapter) => {
    if (adapter.status === "rejected") {
      const ok = await ask({ message: t("learning.publishRejectedConfirm", { reasons: adapter.metrics.gate ? gateReasons(adapter.metrics.gate, t).join("; ") : "" }), confirmLabel: t("learning.publish"), danger: false });
      if (!ok) return;
      return act(learningPublish(adapter.id, true));
    }
    act(learningPublish(adapter.id));
  };

  const rename = async (adapter: Adapter) => {
    const name = await promptAction(t("learning.adapterRename"), { initial: adapter.name, confirmLabel: t("learning.adapterRename") });
    if (name) act(learningRenameAdapter(adapter.id, name));
  };

  const remove = async (message: string, work: () => Promise<unknown>) => {
    if (await ask({ message, confirmLabel: t("learning.delete"), danger: true })) act(work());
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className={labelClass}>{t("learning.trainingTitle")}</span>
        <Segmented<LearningMode>
          options={[
            { value: "manual", label: t("learning.modeManual") },
            { value: "assisted", label: t("learning.modeAssisted") },
            { value: "supervised", label: t("learning.modeSupervised") },
          ]}
          value={overview.mode}
          onChange={(mode) => act(learningSetMode(mode, baseId))}
          layoutId="cf-learning-mode"
          size="sm"
          ariaLabel={t("learning.trainingTitle")}
          className="self-start"
        />
        <span className={subClass}>{t(MODE_HINT[overview.mode])}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={labelClass}>{t("learning.environment")}</span>
        {env.worker === null ? (
          <Note>{t("learning.noWorker")}</Note>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className={chipClass(env.ready ? "ok" : "neutral")}>{env.worker === "mlx" ? t("learning.workerMlx") : t("learning.workerCuda")}</span>
            <span className={subClass}>
              {env.ready
                ? env.trainerVersion
                : env.systemPython
                  ? t("learning.envMissing", { python: env.systemPython })
                  : env.pythonDownload
                    ? t("learning.envDownloadsPython", { mb: String(Math.round(env.pythonDownload / 1_048_576)) })
                    : t("learning.noPython")}
            </span>
            {!env.ready && (env.systemPython || env.pythonDownload) && (
              <button type="button" disabled={overview.envBusy} onClick={() => act(learningPrepareEnv())} className={buttonClass({ variant: "secondary", size: "sm" })}>
                {overview.envBusy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {t("learning.envPrepare")}
              </button>
            )}
          </div>
        )}
        {(overview.envBusy || envLine) && <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{envLine ?? t("learning.envPreparing")}</span>}
      </div>

      {env.worker !== null && (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("learning.baseModel")}</span>
          <div className={listClass}>
            {overview.bases.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === baseId}
                onClick={() => chooseBase(b.id)}
                className={`${rowClass} w-full text-left hover:bg-[var(--cf-hover)]`}
              >
                <Check size={13} className={b.id === baseId ? "shrink-0 text-[var(--cf-accent)]" : "shrink-0 opacity-0"} />
                <BaseLine base={b} cuda={env.worker === "cuda"} t={t} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className={labelClass}>{t("learning.datasets")}</span>
          <span className={subClass}>{t("learning.usableExamples", { n: String(overview.usableExamples), min: String(overview.meaningful) })}</span>
          <button type="button" disabled={overview.usableExamples < 3} onClick={() => void buildDataset()} className={iconButton}>
            <Plus size={13} /> {t("learning.datasetCreate")}
          </button>
        </div>
        {overview.datasets.length > 0 && (
          <div className={listClass}>
            {overview.datasets.map((dataset) => (
              <div key={dataset.id} className="border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]" title={dataset.path}>
                    {dataset.name}
                  </span>
                  {!dataset.manifest.meaningful && <span className={chipClass("warn")}>{t("learning.datasetSmall")}</span>}
                  <button
                    type="button"
                    disabled={!canTrain}
                    title={base ? t("learning.trainOn", { base: base.label }) : undefined}
                    onClick={() => train(dataset.id)}
                    className={iconButton}
                  >
                    <Play size={13} /> {t("learning.train")}
                  </button>
                  <button
                    type="button"
                    title={t("learning.delete")}
                    onClick={() => void remove(t("learning.datasetDeleteConfirm", { name: dataset.name }), () => learningDeleteDataset(dataset.id))}
                    className={iconButton}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                <span className={`${subClass} tabular-nums`}>
                  {t("learning.datasetCounts", { train: String(dataset.trainCount), valid: String(dataset.validCount), test: String(dataset.testCount) })}
                </span>
              </div>
            ))}
          </div>
        )}
        {overview.memoryCritical && <Note>{t("learning.memoryCritical")}</Note>}
        {!overview.memoryCritical && overview.onBattery != null && (
          <span className={subClass}>{t("learning.onBattery", { percent: String(Math.round(overview.onBattery)) })}</span>
        )}
      </div>

      {overview.runs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("learning.runs")}</span>
          <div className={listClass}>
            {overview.runs.map((run) => {
              const progress = (run.status === "running" && live[run.id]) || run.progress;
              const share = progress.iters > 0 ? Math.min(1, progress.iter / progress.iters) : 0;
              return (
                <div key={run.id} className="border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className={chipClass(RUN_TONE[run.status])}>{t(RUN_KEY[run.status])}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                      {baseLabel(run.baseModel)}
                      {datasetName(run.datasetId) && <span className="text-[var(--cf-text-muted)]"> · {datasetName(run.datasetId)}</span>}
                    </span>
                    {run.status === "running" && (
                      <button type="button" title={t("learning.stop")} onClick={() => act(learningCancelRun(run.id))} className={iconButton}>
                        <Square size={13} />
                      </button>
                    )}
                    {(run.status === "cancelled" || run.status === "failed") && (
                      <button type="button" disabled={busy || !env.ready} title={t("learning.resume")} onClick={() => act(learningResumeRun(run.id))} className={iconButton}>
                        <RotateCcw size={13} />
                      </button>
                    )}
                    <button type="button" title={t("learning.log")} aria-pressed={log?.id === run.id} onClick={() => void showLog(run)} className={iconButton}>
                      <FileText size={13} />
                    </button>
                    {run.status !== "running" && (
                      <button
                        type="button"
                        title={t("learning.delete")}
                        onClick={() => void remove(t("learning.runDeleteConfirm"), () => learningDeleteRun(run.id))}
                        className={iconButton}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  {run.status === "running" && (
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--cf-hover)]">
                      <div className="h-full bg-[var(--cf-accent)] transition-[width]" style={{ width: `${share * 100}%` }} />
                    </div>
                  )}
                  <span className={`${subClass} tabular-nums`}>{progressLine(progress, t)}</span>
                  {run.status === "failed" && run.error && <span className="block truncate text-[11px] text-[var(--cf-danger)]" title={run.error}>{run.error}</span>}
                  {log?.id === run.id && (
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--cf-hover)] p-2 font-mono text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                      {log.text}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {overview.adapters.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>{t("learning.adapters")}</span>
          <div className={listClass}>
            {overview.adapters.map((adapter) => {
              const gate = adapter.metrics.gate;
              const evaluating = overview.evaluating === adapter.id;
              // A PEFT adapter (NVIDIA) is served over its base's GGUF by llama-server.
              const adapterBase = overview.bases.find((b) => b.id === adapter.baseModel);
              const blocker: TranslationKey | null =
                adapter.format === "mlx-lora"
                  ? null
                  : !adapterBase?.gguf
                    ? "learning.evaluateNoGguf"
                    : !adapterBase.ggufInstalled
                      ? "learning.evaluateNeedsGguf"
                      : null;
              const servable = blocker === null;
              return (
                <div key={adapter.id} className="border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className={chipClass(ADAPTER_TONE[adapter.status])}>{t(ADAPTER_KEY[adapter.status])}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]" title={adapter.path}>
                      {adapter.name}
                    </span>
                    {evaluating ? (
                      <button type="button" title={t("learning.stop")} onClick={() => act(learningCancelEvaluation())} className={iconButton}>
                        <Loader2 size={13} className="animate-spin" />
                        <Square size={11} />
                      </button>
                    ) : (
                      adapter.status !== "published" && (
                        <button
                          type="button"
                          disabled={!servable || overview.evaluating !== null || busy}
                          title={blocker ? t(blocker, { base: adapterBase?.label ?? adapter.baseModel }) : t("learning.evaluateHint")}
                          onClick={() => act(learningEvaluate(adapter.id))}
                          className={iconButton}
                        >
                          <FlaskConical size={13} /> {t("learning.evaluate")}
                        </button>
                      )
                    )}
                    {(adapter.status === "approved" || adapter.status === "retired" || adapter.status === "rejected") && (
                      <button type="button" disabled={evaluating} onClick={() => void publish(adapter)} className={iconButton}>
                        <Upload size={13} /> {t("learning.publish")}
                      </button>
                    )}
                    {adapter.status === "published" && (
                      <button type="button" title={t("learning.rollbackHint")} onClick={() => act(learningRollback(adapter.id))} className={iconButton}>
                        <Undo2 size={13} /> {t("learning.rollback")}
                      </button>
                    )}
                    <button type="button" title={t("learning.adapterRename")} onClick={() => void rename(adapter)} className={iconButton}>
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      title={t("learning.delete")}
                      disabled={evaluating}
                      onClick={() => void remove(t("learning.adapterDeleteConfirm", { name: adapter.name }), () => learningDeleteAdapter(adapter.id))}
                      className={iconButton}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {evaluating && evalLine && <span className={`${subClass} block truncate font-mono`}>{evalLine}</span>}
                  {gate && !evaluating && (
                    <span className={`${subClass} block`}>
                      {t("learning.gateScores", {
                        before: String(Math.round(gate.scoreBefore * 100)),
                        after: String(Math.round(gate.scoreAfter * 100)),
                      })}
                      {gate.toolsBefore != null && gate.toolsAfter != null && ` · ${t("learning.gateTools", { before: String(gate.toolsBefore), after: String(gate.toolsAfter) })}`}
                      {!gate.approved && <span className="text-[var(--cf-warning)]"> · {gateReasons(gate, t).join("; ")}</span>}
                    </span>
                  )}
                  {adapter.status === "published" && <span className={`${subClass} block`}>{t("learning.publishedHint")}</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
