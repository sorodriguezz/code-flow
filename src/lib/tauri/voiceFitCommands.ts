import { invoke } from "./invoke";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * «¿Cuál le va a este equipo?» (`voice_fit`): for every model that listens and every voice, how
 * heavy, how fast here, how accurate, and what each feature is recommended. Speeds are estimates
 * (measured elsewhere, read for this machine's class) until the model is downloaded and measured
 * here — `measured` says which.
 */

export type VoiceClass = "apple" | "pc" | "modest";
export type VoicePace = "fast" | "ok" | "slow" | "too-slow";

export interface VoiceMachine {
  class: VoiceClass;
  cpu: string;
  cores: number;
  ramGb: number;
  gpu: string | null;
}

export interface ListenFit {
  id: string;
  /** A three-second order, in milliseconds. */
  ms: number;
  measured: boolean;
  pace: VoicePace;
  ramMb: number;
  accuracy: "max" | "high" | "medium" | "basic";
  recommendedFor: ("codi" | "dictation" | "meetingsLive" | "meetingsFinal" | "translate")[];
}

export interface SpeakFit {
  /** `kokoro`, or a Piper voice's id. */
  id: string;
  engine: "kokoro" | "piper";
  /** The first sentence, in milliseconds. */
  firstMs: number;
  rtf: number | null;
  measured: boolean;
  pace: VoicePace;
  ramMb: number;
  recommended: boolean;
}

export interface VoicePicks {
  codi: string;
  dictation: string;
  meetingsLive: string;
  meetingsFinal: string;
  translate: string;
  voiceEngine: "kokoro" | "piper";
  voiceEs: string;
  voiceEn: string;
}

export interface VoiceFit {
  machine: VoiceMachine;
  listen: ListenFit[];
  speak: SpeakFit[];
  picks: VoicePicks;
}

export const voiceFit = () => invoke<VoiceFit>("voice_fit");
/** Runs `id` (a listener, `kokoro` or a Piper voice) here and stores what it took. */
export const voiceMeasure = (id: string) => invoke<{ ms: number; rtf?: number | null; measuredAt: string }>("voice_measure", { id });
/** A measurement finished (after a download, or «Medir»): the id. */
export const onVoiceFit = (handler: (id: string) => void): Promise<UnlistenFn> => listen<string>("voice:fit", (event) => handler(event.payload));
