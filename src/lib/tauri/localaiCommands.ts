import { invoke } from "@tauri-apps/api/core";

/**
 * The editor's local completion engine, from the frontend's side.
 *
 * Mirrors `src-tauri/src/commands/localai_cmd.rs`. Kept in its own file rather than added to
 * `commands.ts` for the same reason `apiCommands.ts` and `dbCommands.ts` are separate: that file is
 * 2,246 lines and every feature that grows into it makes the next one harder to find.
 */

/** Which machine a catalogue entry is meant for. Matches `localai::catalogue::Tier`. */
export type LocalAiTier = "light" | "balanced" | "large";

/**
 * Where the engine process is. Matches `localai::engine::Status`, which serializes with
 * `#[serde(tag = "kind")]`.
 */
export type LocalAiEngineStatus =
  | { kind: "off" }
  | { kind: "starting"; model_id: string }
  | { kind: "ready"; model_id: string }
  | { kind: "failed"; message: string };

export interface LocalAiModelRow {
  id: string;
  label: string;
  tier: LocalAiTier;
  /** e.g. "1.5B · Q8_0". Shown verbatim; it is the model's own description, not a sentence of ours. */
  params: string;
  licence: string;
  size_bytes: number;
  min_ram_gb: number;
  installed: boolean;
  /** Bytes already fetched by an interrupted download, so the row can offer "resume" honestly. */
  partial_bytes: number | null;
}

export interface LocalAiState {
  enabled: boolean;
  model_id: string;
  /** `false` after a downgrade, when the saved id is from a newer build's catalogue. */
  model_known: boolean;
  model_installed: boolean;
  models: LocalAiModelRow[];
  /** Absolute path to the weights folder, for the "show in Finder/Explorer" button. */
  models_dir: string;
  engine: LocalAiEngineStatus;
  /** `false` means this install is missing `llama-server` — broken, not a user choice. */
  engine_available: boolean;
  disk_used: number;
}

/** Everything the settings pane needs, in one round trip. */
export const localAiState = () => invoke<LocalAiState>("localai_state");

export const localAiSetEnabled = (enabled: boolean) =>
  invoke<void>("localai_set_enabled", { enabled });

export const localAiSetModel = (modelId: string) =>
  invoke<void>("localai_set_model", { modelId });

/**
 * Resolves when the download has finished *and* been verified, which for the 7B is several
 * minutes. Progress arrives meanwhile on the `localai:download` event — see `onLocalAiDownload`.
 */
export const localAiDownloadModel = (modelId: string) =>
  invoke<void>("localai_download_model", { modelId });

export const localAiCancelDownload = (modelId: string) =>
  invoke<void>("localai_cancel_download", { modelId });

export const localAiDeleteModel = (modelId: string) =>
  invoke<void>("localai_delete_model", { modelId });

/** Stops the engine now and gives its memory back. The next keystroke starts a new one. */
export const localAiStopEngine = () => invoke<void>("localai_stop_engine");

/**
 * Asks for the text between `prefix` and `suffix`.
 *
 * `null` for every ordinary reason there is nothing to show — the feature is off, no model is
 * downloaded, the engine is still warming up, a newer keystroke superseded this one. Only a real
 * fault rejects, and even then the provider swallows it: a keystroke must never raise a toast.
 */
export const localAiComplete = (request: { request_id: string; prefix: string; suffix: string }) =>
  invoke<string | null>("localai_complete", { request });

export const localAiCancelCompletion = (requestId: string) =>
  invoke<void>("localai_cancel_completion", { requestId });
