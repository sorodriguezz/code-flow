import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Voices made from a recording (`speech::clone`): Chatterbox Multilingual (MIT, the default) and
 * XTTS v2 (non-commercial licence, downloaded only after the user accepts it). Each engine is a
 * Python environment of the app's own; a voice is a reference recording made here with consent.
 */

export type CloneEngine = "chatterbox" | "xtts";

export interface CloneEngineRow {
  engine: CloneEngine;
  installed: boolean;
  licence: string;
  estimateBytes: number;
  bytesOnDisk: number;
  termsUrl: string | null;
}

export interface ClonedVoice {
  id: string;
  name: string;
  engine: CloneEngine;
  createdAt: string;
  consent: boolean;
  seconds: number;
  /** Its recording is there and its engine is installed. */
  ready: boolean;
}

export interface CloneStatus {
  engines: CloneEngineRow[];
  xttsAccepted: boolean;
  voices: ClonedVoice[];
  /** A graphics card, or Apple Silicon: speaks in about real time. A CPU alone is slow. */
  accelerated: boolean;
}

export interface ClonePrepareEvent {
  engine: CloneEngine;
  state: "running" | "done" | "failed";
  line: string | null;
}

/** The shortest and longest recording a voice is made from, in seconds (`speech::clone`). */
export const CLONE_MIN_SECONDS = 6;
export const CLONE_MAX_SECONDS = 20;

export const voiceCloneStatus = () => invoke<CloneStatus>("voice_clone_status");
export const voiceCloneAcceptTerms = (accept: boolean) => invoke<void>("voice_clone_accept_terms", { accept });
export const voiceClonePrepare = (engine: CloneEngine) => invoke<void>("voice_clone_prepare", { engine });
export const voiceCloneRemove = (engine: CloneEngine) => invoke<void>("voice_clone_remove", { engine });
export const voiceCloneRecordStart = (device: string) => invoke<void>("voice_clone_record_start", { device });
/** Seconds recorded. */
export const voiceCloneRecordFinish = () => invoke<number>("voice_clone_record_finish");
export const voiceCloneRecordCancel = () => invoke<void>("voice_clone_record_cancel");
export const voiceCloneSave = (name: string, engine: CloneEngine, consent: boolean) => invoke<ClonedVoice>("voice_clone_save", { name, engine, consent });
export const voiceCloneDelete = (id: string) => invoke<void>("voice_clone_delete", { id });

export const onClonePrepare = (f: (e: ClonePrepareEvent) => void): Promise<UnlistenFn> => listen<ClonePrepareEvent>("voice:clone", (e) => f(e.payload));
export const onCloneLevel = (f: (level: number) => void): Promise<UnlistenFn> => listen<number>("voice:clone-level", (e) => f(e.payload));
