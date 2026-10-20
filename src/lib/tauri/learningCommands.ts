import { invoke } from "@tauri-apps/api/core";

/**
 * Fine-tuning: datasets, the training environment, runs, adapters. Mirrors
 * `src-tauri/src/commands/learning_cmd.rs` and `src-tauri/src/learning/*`.
 */

export type LearningMode = "manual" | "assisted" | "supervised";
export type LearningWorker = "mlx" | "cuda";

export interface LearningEnv {
  worker: LearningWorker | null;
  systemPython: string | null;
  /** Bytes Prepare would download for a self-contained Python, when the machine has none. */
  pythonDownload: number | null;
  venv: boolean;
  trainerVersion: string | null;
  ready: boolean;
}

export interface LearningBase {
  id: string;
  label: string;
  family: string;
  mlxRepo: string;
  hfRepo: string;
  proven: boolean;
  licence: string;
  approxGb: number;
  minRamGb: number;
  cudaVramGb: number;
  /** The Local model catalogue row holding this base as GGUF — what a PEFT adapter is served over. */
  gguf: string | null;
  moe: boolean;
  downloaded: boolean;
  /** `null`: never tried here. */
  validated: boolean | null;
  fits: boolean;
  ggufInstalled: boolean;
}

export interface LearningDataset {
  id: string;
  name: string;
  family: string;
  path: string;
  trainCount: number;
  validCount: number;
  testCount: number;
  manifest: { meaningful?: boolean; negativesSeen?: number; examples?: number } & Record<string, unknown>;
  createdAt: number;
}

export interface TrainProgress {
  iter: number;
  iters: number;
  trainLoss: number | null;
  valLoss: number | null;
  firstValLoss: number | null;
  tokensPerSec: number | null;
  peakMemGb: number | null;
  savedIter: number | null;
}

export interface TrainParams {
  iters: number;
  batchSize: number;
  numLayers: number;
  learningRate: number;
  maxSeqLength: number;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TrainingRun {
  id: string;
  datasetId: string | null;
  baseModel: string;
  family: string;
  worker: LearningWorker;
  method: string;
  params: TrainParams;
  status: RunStatus;
  progress: TrainProgress;
  logPath: string;
  outDir: string;
  adapterId: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GateSummary {
  approved: boolean;
  /** The gate's own sentences (English) — the pane words them from the fields below. */
  reasons: string[];
  regressions: string[];
  aborted: boolean;
  scoreBefore: number;
  scoreAfter: number;
  toolsBefore: number | null;
  toolsAfter: number | null;
}

export type AdapterStatus = "candidate" | "approved" | "rejected" | "published" | "retired";

export interface Adapter {
  id: string;
  name: string;
  baseModel: string;
  family: string;
  datasetId: string | null;
  runId: string | null;
  path: string;
  format: "mlx-lora" | "peft-lora";
  frameworkVersion: string;
  metrics: Partial<TrainProgress> & { gate?: GateSummary };
  status: AdapterStatus;
  evaluationId: string | null;
  createdAt: number;
  publishedAt: number | null;
}

export interface LearningOverview {
  mode: LearningMode;
  base: string | null;
  env: LearningEnv;
  envBusy: boolean;
  bases: LearningBase[];
  usableExamples: number;
  meaningful: number;
  datasets: LearningDataset[];
  runs: TrainingRun[];
  adapters: Adapter[];
  running: string | null;
  evaluating: string | null;
  memoryCritical: boolean;
  /** The battery's charge when unplugged. */
  onBattery: number | null;
}

/** What arrives on `ai:learning`. */
export interface LearningEvent {
  kind: "env" | "train" | "eval" | "dataset";
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  line: string | null;
  progress: (TrainProgress & { phase?: never }) | { phase: "base" | "candidate"; done: number; total: number } | null;
}

/** The prefix that names an adapter among the «CodeFlow» provider's models. */
export const ADAPTER_PREFIX = "adapter:";

export const learningOverview = () => invoke<LearningOverview>("learning_overview");
export const learningAdapterNames = () => invoke<[string, string][]>("learning_adapter_names");
export const learningSetMode = (mode: LearningMode, base?: string | null) => invoke<void>("learning_set_mode", { mode, base: base ?? null });
export const learningPrepareEnv = () => invoke<void>("learning_prepare_env");
export const learningBuildDataset = (name: string, workspaceId?: string | null) =>
  invoke<LearningDataset>("learning_build_dataset", { name, workspaceId: workspaceId ?? null });
export const learningDeleteDataset = (id: string) => invoke<void>("learning_delete_dataset", { id });
export const learningStartRun = (datasetId: string, baseId: string, params?: TrainParams | null) =>
  invoke<TrainingRun>("learning_start_run", { datasetId, baseId, params: params ?? null });
export const learningResumeRun = (id: string) => invoke<void>("learning_resume_run", { id });
export const learningCancelRun = (id: string) => invoke<boolean>("learning_cancel_run", { id });
export const learningDeleteRun = (id: string) => invoke<void>("learning_delete_run", { id });
export const learningRunLog = (id: string) => invoke<string>("learning_run_log", { id });
export const learningEvaluate = (id: string) => invoke<void>("learning_evaluate", { id });
export const learningCancelEvaluation = () => invoke<boolean>("learning_cancel_evaluation");
export const learningPublish = (id: string, force?: boolean) => invoke<void>("learning_publish", { id, force: force ?? null });
export const learningRollback = (id: string) => invoke<string | null>("learning_rollback", { id });
export const learningRenameAdapter = (id: string, name: string) => invoke<void>("learning_rename_adapter", { id, name });
export const learningDeleteAdapter = (id: string) => invoke<void>("learning_delete_adapter", { id });
export const learningStopServing = () => invoke<void>("learning_stop_serving");
