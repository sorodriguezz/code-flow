import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `dictation::WhisperModel` + whether it is on disk. */
export interface DictationModel {
  id: "tiny" | "base" | "small" | "turbo";
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

/** `dictation::capture::InputDevice`: one microphone. `id` is what `dictation_device` stores. */
export interface MicInput {
  id: string;
  name: string;
  isDefault: boolean;
}

/** `dictation::permission::Permission`. `unknown` where the system has nothing to read (Windows):
 *  the input itself refuses, with [`MIC_DENIED`]. */
export type MicPermission = "granted" | "denied" | "undetermined" | "unknown";

/** What a recording that the system refused fails with — and one with no input at all. */
export const MIC_DENIED = "MIC_DENIED";
export const MIC_NONE = "MIC_NONE";

export const dictationInputs = () => invoke<MicInput[]>("dictation_inputs");

export const dictationMicPermission = () => invoke<MicPermission>("dictation_mic_permission");

/** Asks the system's own question when it has not been asked yet (macOS); the state either way. */
export const dictationMicRequest = () => invoke<MicPermission>("dictation_mic_request");

/** Opens the system's microphone privacy page. */
export const dictationMicSettings = () => invoke<void>("dictation_mic_settings");

/** Opens the microphone (`device`: an input's id, `""` for the system's default) under `session`,
 *  the caller's own id for this recording. Resolves once it is actually recording. */
export const dictationRecordStart = (session: string, device: string) =>
  invoke<void>("dictation_record_start", { session, device });

/** Stops `session`'s recording and transcribes it. `language`: a code, or `"auto"`. */
export const dictationRecordFinish = (session: string, modelId: string, language: string) =>
  invoke<string>("dictation_record_finish", { session, modelId, language });

export const dictationRecordCancel = (session: string) => invoke<void>("dictation_record_cancel", { session });

/** Stops the transcription under way. */
export const dictationCancel = () => invoke<void>("dictation_cancel");

export const onDictationLevel = (handler: (event: { session: string; level: number }) => void): Promise<UnlistenFn> =>
  listen<{ session: string; level: number }>("dictation:level", (event) => handler(event.payload));

export const onDictationLimit = (handler: (session: string) => void): Promise<UnlistenFn> =>
  listen<string>("dictation:limit", (event) => handler(event.payload));

export const onDictationProgress = (handler: (event: DictationProgress) => void): Promise<UnlistenFn> =>
  listen<DictationProgress>("dictation:download", (event) => handler(event.payload));
