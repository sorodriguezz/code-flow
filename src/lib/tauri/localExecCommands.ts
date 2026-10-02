import { invoke } from "@tauri-apps/api/core";
import type { LocalAiEngineStatus, LocalAiTier } from "./localaiCommands";

/**
 * The hybrid task's local model, from the frontend's side. Mirrors
 * `src-tauri/src/commands/localexec_cmd.rs`; the settings themselves are plain `app_settings` rows
 * written through `setSetting` — see {@link LOCAL_EXEC_KEYS}.
 */

/** Which server runs the local model. Matches `hybrid::local_llm::BackendKind`. */
export type LocalBackend = "bundled" | "ollama" | "openai";

/** How a model of a given footprint sits on this machine. Matches `hybrid::budget::Fit`. */
export type LocalFit = "comfortable" | "tight" | "spills-to-cpu" | "does-not-fit" | "unknown";

/** Which tasks the planner may hand to the local model. Matches `hybrid::budget::Delegate`. */
export type LocalDelegate = "easy" | "medium" | "all";

export type LocalOnFail = "review" | "skip";

/** `local`: the review hands its corrections back to the local model. Matches `config::ReviewMode`. */
export type HybridReviewMode = "local" | "fix" | "report";

export type LocalGpuKind = "unified" | "discrete" | "unknown";

/** What a local-model `error` is. The sentence is English; the UI says the kind in the reader's
 *  language. Matches `LocalError::code` and `runtime::Resolved::error_code`. */
export type LocalExecErrorCode =
  | "unreachable"
  | "refused"
  | "cancelled"
  | "stalled"
  | "malformed"
  | "engine-missing"
  | "not-downloaded"
  | "no-models"
  | "truncated";

export interface LocalExecModelRow {
  id: string;
  label: string;
  size_bytes: number | null;
  params: string | null;
  quant: string | null;
  /** Bundled catalogue only — `null` for a server's listing. */
  installed: boolean | null;
  partial_bytes: number | null;
  licence: string | null;
  min_ram_gb: number | null;
  tier: LocalAiTier | null;
  /** How it sits on this machine at 16k. Bundled catalogue only. */
  fit: LocalFit | null;
}

export interface LocalExecDetails {
  max_ctx: number | null;
  /** The server fixed its own window; nothing above it can be offered. */
  ctx_fixed_by_server: boolean;
  kv_bytes_per_token: number | null;
  params_b: number | null;
  size_bytes: number | null;
  thinking: boolean;
}

/** A model Ollama's library has that this server has not pulled. Mirrors `PullableRow`. */
export interface LocalExecPullable {
  /** `ollama:<tag>` — what its progress arrives under on `localai:download`. */
  id: string;
  tag: string;
  label: string;
  params: string;
  size_bytes: number;
  fit: LocalFit;
}

export interface LocalExecBudget {
  ctx: number;
  output: number;
  input: number;
}

export interface LocalExecMachine {
  ram_bytes: number;
  gpu: LocalGpuKind;
  gpu_bytes: number | null;
  gpu_name: string | null;
}

export interface LocalExecProbe {
  ok: boolean;
  backend: LocalBackend;
  model: string;
  ctx: number;
  sent_tokens: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  prompt_tps: number | null;
  gen_tps: number | null;
  /** 0–1, Ollama only. */
  gpu_share: number | null;
  truncated: boolean;
  error: string | null;
  error_code: LocalExecErrorCode | null;
  at: number;
}

export interface LocalExecState {
  backend: LocalBackend;
  backend_chosen: boolean;
  url: string;
  /** The URL is not this machine: code leaves it. */
  remote: boolean;
  detected: { ollama: boolean; ollama_version: string | null; lmstudio: boolean };
  reachable: boolean;
  server_version: string | null;
  /** English, for a tooltip — {@link LocalExecState.error_code} is what is shown. */
  error: string | null;
  error_code: LocalExecErrorCode | null;
  models: LocalExecModelRow[];
  model: string | null;
  model_chosen: boolean;
  details: LocalExecDetails;
  ctx: number;
  ctx_chosen: boolean;
  ctx_options: number[];
  budget: LocalExecBudget;
  machine: LocalExecMachine;
  need_bytes: number | null;
  also_resident_bytes: number;
  fit: LocalFit;
  delegate: LocalDelegate;
  delegate_suggested: LocalDelegate;
  delegate_chosen: boolean;
  on_fail: LocalOnFail;
  unload: boolean;
  review_mode: HybridReviewMode;
  /** The bundled executor's process. */
  engine: LocalAiEngineStatus;
  engine_available: boolean;
  models_dir: string;
  disk_used: number;
  has_key: boolean;
  probe: LocalExecProbe | null;
  /** Ollama only: what can be pulled from here. */
  pullable: LocalExecPullable[];
}

/** The `app_settings` rows behind the pane. Mirrors `hybrid::config`. */
export const LOCAL_EXEC_KEYS = {
  backend: "local_exec_backend",
  urlOllama: "local_exec_url_ollama",
  urlOpenai: "local_exec_url_openai",
  modelBundled: "local_exec_model_bundled",
  modelOllama: "local_exec_model_ollama",
  modelOpenai: "local_exec_model_openai",
  ctx: "local_exec_ctx",
  delegate: "local_exec_delegate",
  onFail: "local_exec_on_fail",
  unload: "local_exec_unload",
  reviewMode: "hybrid_review_mode",
} as const;

export const isLocalExecKey = (key: string) =>
  key.startsWith("local_exec_") || key === LOCAL_EXEC_KEYS.reviewMode;

/** The model key for a backend — each server kind remembers its own model. */
export const modelKeyFor = (backend: LocalBackend) =>
  backend === "bundled"
    ? LOCAL_EXEC_KEYS.modelBundled
    : backend === "ollama"
      ? LOCAL_EXEC_KEYS.modelOllama
      : LOCAL_EXEC_KEYS.modelOpenai;

/** Resolves the stored choices against what is running. A few short network checks. */
export const localExecState = () => invoke<LocalExecState>("local_exec_state");

/** One short real request: read and write speed, GPU share, and whether the server cuts prompts. */
export const localExecProbe = () => invoke<LocalExecProbe>("local_exec_probe");

/** Resolves once downloaded *and* verified. Progress arrives on `localai:download`. */
export const localExecDownloadModel = (modelId: string) =>
  invoke<void>("local_exec_download_model", { modelId });

export const localExecCancelDownload = (modelId: string) =>
  invoke<void>("local_exec_cancel_download", { modelId });

export const localExecDeleteModel = (modelId: string) => invoke<void>("local_exec_delete_model", { modelId });

/** Gives the local model's memory back now. */
export const localExecStopEngine = () => invoke<void>("local_exec_stop_engine");

/** Pulls a model into Ollama. Resolves when the pull ends; progress arrives on `localai:download`
 *  under `ollama:<tag>`. */
export const localExecOllamaPull = (tag: string) => invoke<void>("local_exec_ollama_pull", { tag });

export const localExecOllamaCancelPull = (tag: string) => invoke<void>("local_exec_ollama_cancel_pull", { tag });

export const localExecOllamaDelete = (tag: string) => invoke<void>("local_exec_ollama_delete", { tag });

/** Stores the Bearer key for an OpenAI-compatible server in the keychain; `null` removes it. */
export const localExecSetKey = (key: string | null) => invoke<void>("local_exec_set_key", { key });
