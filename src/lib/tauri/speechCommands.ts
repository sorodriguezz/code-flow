import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** `speech::system::SystemVoice`. */
export interface SystemVoice {
  id: string;
  name: string;
  /** `es-MX`, `en-US`… — empty when the engine does not say. */
  lang: string;
}

export type VoiceGender = "female" | "male" | "nonbinary";

/** `speech::piper::VoiceRow`: a natural voice that can be downloaded. */
export interface DownloadableVoice {
  id: string;
  label: string;
  /** `es-MX`, `en-GB`… */
  lang: string;
  sizeBytes: number;
  licence: string;
  gender: VoiceGender;
  installed: boolean;
}

/** `speech_cmd::SpeechStatus`. */
export interface SpeechStatus {
  systemVoices: SystemVoice[];
  /** The system voice «Automática» reads each language with here; `null` = the system's default. */
  systemDefaults: { es: string | null; en: string | null };
  localSupported: boolean;
  libraryInstalled: boolean;
  libraryBytes: number;
  voices: DownloadableVoice[];
  keys: { openai: boolean; elevenlabs: boolean };
}

/** `speech::player::OutputDevice`. */
export interface OutputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

/** `speech::SpeechState`: one step of one utterance. */
export interface SpeechStateEvent {
  id: number;
  phase: "preparing" | "speaking" | "done" | "stopped" | "failed";
  text: string;
  origin: string;
  /** Loudness every `stepMs`, 0–1, from the moment `speaking` arrives. */
  envelope: number[];
  stepMs: number;
  durationMs: number;
  error?: string | null;
}

export interface SpeechDownloadEvent {
  item: string;
  phase: "downloading" | "unpacking" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error?: string | null;
}

/** The voice service has no key stored. */
export const SPEECH_NO_KEY = "SPEECH_NO_KEY";

export const speechStatus = () => invoke<SpeechStatus>("speech_status");
/** `lang` is the window's language: the voice for a text too short to tell its own. */
export const speechSay = (text: string, origin: string, interrupt: boolean, lang: string) =>
  invoke<number>("speech_say", { text, origin, interrupt, lang });
export const speechStop = () => invoke<void>("speech_stop");
export const audioOutputs = () => invoke<OutputDevice[]>("audio_outputs");
export const audioPlay = (samples: number[], rate: number, volume: number) => invoke<void>("audio_play", { samples, rate, volume });
export const speechSetKey = (service: "openai" | "elevenlabs", key: string) => invoke<void>("speech_set_key", { service, key });
export const speechInstallVoice = (id: string) => invoke<void>("speech_install_voice", { id });
export const speechCancelInstall = () => invoke<void>("speech_cancel_install");
export const speechRemoveVoice = (id: string) => invoke<void>("speech_remove_voice", { id });
export const speechSummarize = (text: string, workspaceId: string | null) => invoke<string>("speech_summarize", { text, workspaceId });
export const defaultSpokenSummaryTemplate = () => invoke<string>("default_spoken_summary_template");

export const onSpeechState = (f: (e: SpeechStateEvent) => void): Promise<UnlistenFn> => listen<SpeechStateEvent>("speech:state", (e) => f(e.payload));
export const onSpeechDownload = (f: (e: SpeechDownloadEvent) => void): Promise<UnlistenFn> =>
  listen<SpeechDownloadEvent>("speech:download", (e) => f(e.payload));
