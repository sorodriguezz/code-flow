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
  /** Kokoro's voices are one download for all of them (`speech::kokoro`); a cloned voice
   *  (`speech::clone`) reads any language — its `lang` is `multi`. */
  engine: "piper" | "kokoro" | "clone";
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
  /** Kokoro's single download. */
  kokoro: { sizeBytes: number; licence: string; installed: boolean; voices: number };
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
  /** This `speaking` continues the previous one: its envelope goes on the end of that one's (a
   *  downloaded voice speaks a sentence at a time). */
  append: boolean;
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
/** `lang` is the window's language: the voice for a text too short to tell its own. `voice` is a
 *  downloaded voice to say it with instead of the language's own — Settings › Codi testing Codi's;
 *  only sent when given, and read only by a backend whose `speech_say` takes it. */
export const speechSay = (text: string, origin: string, interrupt: boolean, lang: string, voice?: string) =>
  invoke<number>("speech_say", { text, origin, interrupt, lang, ...(voice ? { voice } : {}) });
export const speechStop = () => invoke<void>("speech_stop");
/** Says `text` with `voice` (a downloaded or cloned voice's id) — a voice's own «Probar». */
export const speechSayVoice = (text: string, voice: string, lang: string) => invoke<void>("speech_say_voice", { text, voice, lang });
export const audioOutputs = () => invoke<OutputDevice[]>("audio_outputs");
export const audioPlay = (samples: number[], rate: number, volume: number) => invoke<void>("audio_play", { samples, rate, volume });
export const speechSetKey = (service: "openai" | "elevenlabs", key: string) => invoke<void>("speech_set_key", { service, key });
/** A Piper voice's id, or `kokoro` (any Kokoro voice's id brings the same model). */
export const speechInstallVoice = (id: string) => invoke<void>("speech_install_voice", { id });
/** The id Kokoro's one download goes by. */
export const KOKORO_ITEM = "kokoro";
export const speechCancelInstall = () => invoke<void>("speech_cancel_install");
export const speechRemoveVoice = (id: string) => invoke<void>("speech_remove_voice", { id });
export const speechSummarize = (text: string, workspaceId: string | null) => invoke<string>("speech_summarize", { text, workspaceId });
export const defaultSpokenSummaryTemplate = () => invoke<string>("default_spoken_summary_template");

export const onSpeechState = (f: (e: SpeechStateEvent) => void): Promise<UnlistenFn> => listen<SpeechStateEvent>("speech:state", (e) => f(e.payload));
export const onSpeechDownload = (f: (e: SpeechDownloadEvent) => void): Promise<UnlistenFn> =>
  listen<SpeechDownloadEvent>("speech:download", (e) => f(e.payload));
