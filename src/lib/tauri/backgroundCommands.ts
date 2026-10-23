import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { KnowledgeVectorizing } from "./knowledgeCommands";

/** One of CodeFlow's model servers (`background::Process`). */
export interface BackgroundProcess {
  pid: number;
  /** `completion` · `executor` · `embeddings` · `adapter` · `training` · `other`. */
  role: string;
  model: string;
  /** Unix seconds. */
  since: number;
  /** With `detail` only. */
  cpu: number | null;
  memory: number | null;
}

/** A model held in the app's own memory (`background::Loaded`). */
export interface BackgroundLoaded {
  kind: "whisper" | "recognizer" | "piper" | "kokoro";
  by: "dictation" | "meetings" | "flows" | "codi" | "voice";
  model: string;
}

export interface BackgroundStatus {
  processes: BackgroundProcess[];
  loaded: BackgroundLoaded[];
  vectorizing: KnowledgeVectorizing | null;
  codiListening: boolean;
}

/** What runs in the background; `detail` adds each server's CPU and memory and walks the process table. */
export const backgroundStatus = (detail: boolean) => invoke<BackgroundStatus>("background_status", { detail });
/** Stops one model server. */
export const backgroundStop = (pid: number) => invoke<void>("background_stop", { pid });
/** Fired whenever something starts or stops (`background::EVENT`). */
export const onBackgroundChanged = (handler: () => void): Promise<UnlistenFn> => listen("background:changed", handler);
