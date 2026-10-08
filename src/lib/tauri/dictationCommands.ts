import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `dictation::WhisperModel` + whether it is on disk. */
export interface DictationModel {
  id: "base" | "small" | "turbo";
  file: string;
  sizeBytes: number;
  installed: boolean;
}

/** `dictation::Status`. */
export interface DictationStatus {
  /** Whether this platform has an engine to install at all. */
  supported: boolean;
  engineInstalled: boolean;
  engineBytes: number;
  models: DictationModel[];
}

/** `dictation:download` — `item` is `"engine"` or a model's id. */
export interface DictationProgress {
  item: string;
  phase: "downloading" | "unpacking" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error?: string;
}

export const dictationStatus = () => invoke<DictationStatus>("dictation_status");

/** Resolves once the engine (if missing) and the model are on disk and verified. */
export const dictationInstall = (modelId: string) => invoke<void>("dictation_install", { modelId });

export const dictationCancelInstall = () => invoke<void>("dictation_cancel_install");

export const dictationRemove = (modelId: string) => invoke<void>("dictation_remove", { modelId });

/** `audio`: 16-bit little-endian PCM, mono, 16 kHz, base64. `language`: a code, or `"auto"`. */
export const dictationTranscribe = (audio: string, modelId: string, language: string) =>
  invoke<string>("dictation_transcribe", { audio, modelId, language });

export const dictationCancel = () => invoke<void>("dictation_cancel");

export const onDictationProgress = (handler: (event: DictationProgress) => void): Promise<UnlistenFn> =>
  listen<DictationProgress>("dictation:download", (event) => handler(event.payload));
