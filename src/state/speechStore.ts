import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import {
  audioOutputs,
  onSpeechDownload,
  onSpeechState,
  SPEECH_NO_KEY,
  speechCancelInstall,
  speechInstallVoice,
  speechRemoveVoice,
  speechSay,
  speechSetKey,
  speechStatus,
  speechStop,
  speechSummarize,
  type OutputDevice,
  type SpeechDownloadEvent,
  type SpeechStatus,
} from "../lib/tauri/speechCommands";
import { speakable } from "../lib/speech/speakable";
import { setNotificationOutput } from "../lib/notificationSound";
import { endVoice, startVoice } from "../lib/thinking/voice";
import { watchSettings } from "../lib/settingsSync";
import { NOTIFICATION_SOURCE_LABEL, onNotificationPushed } from "./notificationStore";
import { usePreferencesStore } from "./preferencesStore";
import { useMeetingsStore } from "./meetingsStore";
import { useDictationStore } from "./dictationStore";
import { translate, useLanguageStore } from "./languageStore";
import type { Language } from "../lib/i18n/translations";
import { pushErrorToast } from "./toastStore";

/**
 * «Lectura en voz alta»: what the thinking mark says, with which voice, and when it keeps quiet.
 *
 * The voice itself is the backend's (`crate::speech`: synthesis, the speaker, the queue). This store
 * holds the choices the reading pane makes, decides *whether* something is said — the answers
 * setting, the per-source «Voz» column, the quiet rules — and follows what is being said, so the
 * status bar can show it and every thinking mark can move with it.
 */

const KEY = {
  engine: "speech_engine",
  // One voice per language and engine (`crate::speech::keys::voice`); empty is «Automática».
  systemVoiceEs: "speech_system_voice_es",
  systemVoiceEn: "speech_system_voice_en",
  localVoiceEs: "speech_local_voice_es",
  localVoiceEn: "speech_local_voice_en",
  cloudService: "speech_cloud_service",
  cloudVoice: "speech_cloud_voice",
  rate: "speech_rate",
  volume: "speech_volume",
  device: "audio_output_device",
  answers: "speech_answers",
  quietMeeting: "speech_quiet_meeting",
  quietDictation: "speech_quiet_dictation",
  readSelection: "speech_read_selection",
} as const;

export type SpeechEngine = "system" | "local" | "cloud";
export type CloudService = "openai" | "elevenlabs";
/** What an AI answer is read as: not at all, a summary, or whole. */
export type AnswersMode = "never" | "summary" | "full";

/** Who asked for something to be said — the backend echoes it on every state. */
export type SpeechOrigin = "test" | "answer" | "notification" | "selection" | "message";

/** Shorter than this, an answer is read as it is even in summary mode — summarising it costs more than it saves. */
const SUMMARY_THRESHOLD = 320;

interface Speaking {
  id: number;
  text: string;
  origin: string;
  phase: "preparing" | "speaking";
}

/** A choice per language of the app. */
export type ByLanguage = Record<Language, string>;

/** `es-MX` → `es`; anything not Spanish is English — the app's rule. */
export const voiceLanguage = (code: string): Language => (code.toLowerCase().startsWith("es") ? "es" : "en");

interface SpeechStoreState {
  loaded: boolean;
  engine: SpeechEngine;
  /** The system voice each language is read with — a text in English gets the English one. */
  systemVoices: ByLanguage;
  /** The downloaded voice each language is read with. */
  localVoices: ByLanguage;
  cloudService: CloudService;
  cloudVoice: string;
  rate: number;
  volume: number;
  device: string;
  answers: AnswersMode;
  quietMeeting: boolean;
  quietDictation: boolean;
  readSelection: boolean;

  status: SpeechStatus | null;
  outputs: OutputDevice[] | null;
  progress: Record<string, SpeechDownloadEvent | undefined>;
  installing: string | null;
  speaking: Speaking | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  loadOutputs: () => Promise<void>;
  setEngine: (engine: SpeechEngine) => Promise<void>;
  setSystemVoice: (lang: Language, id: string) => Promise<void>;
  setLocalVoice: (lang: Language, id: string) => Promise<void>;
  setCloudService: (service: CloudService) => Promise<void>;
  setCloudVoice: (voice: string) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  setDevice: (id: string) => Promise<void>;
  setAnswers: (mode: AnswersMode) => Promise<void>;
  setQuietMeeting: (on: boolean) => Promise<void>;
  setQuietDictation: (on: boolean) => Promise<void>;
  setReadSelection: (on: boolean) => Promise<void>;
  setKey: (service: CloudService, key: string) => Promise<void>;
  install: (id: string) => Promise<void>;
  cancelInstall: () => Promise<void>;
  remove: (id: string) => Promise<void>;

  /** Says `text` unless a quiet rule says not now. `interrupt` cuts what is playing first. Answers
   *  with the utterance's id — the one `speaking.id` carries while it plays, so the control that
   *  asked can tell its own reading from any other — or `null` when nothing was queued. */
  say: (text: string, origin: SpeechOrigin, options?: { interrupt?: boolean }) => Promise<number | null>;
  /** An AI answer, as the answers setting says to read it. */
  speakAnswer: (markdown: string, workspaceId: string | null) => void;
  stop: () => void;
}

const flag = (stored: string | undefined, fallback: boolean) => (stored === undefined || stored === "" ? fallback : stored === "true");

export const useSpeechStore = create<SpeechStoreState>((set, get) => ({
  loaded: false,
  engine: "system",
  systemVoices: { es: "", en: "" },
  localVoices: { es: "", en: "" },
  cloudService: "openai",
  cloudVoice: "",
  rate: 1,
  volume: 80,
  device: "",
  answers: "never",
  quietMeeting: true,
  quietDictation: true,
  readSelection: true,
  status: null,
  outputs: null,
  progress: {},
  installing: null,
  speaking: null,

  load: async () => {
    ensureSpeechEvents();
    try {
      const stored = await getSettings(Object.values(KEY));
      const engine = stored[KEY.engine];
      const answers = stored[KEY.answers];
      const rate = Number(stored[KEY.rate]);
      const volume = Number(stored[KEY.volume]);
      set({
        loaded: true,
        engine: engine === "local" || engine === "cloud" ? engine : "system",
        systemVoices: { es: stored[KEY.systemVoiceEs] ?? "", en: stored[KEY.systemVoiceEn] ?? "" },
        localVoices: { es: stored[KEY.localVoiceEs] ?? "", en: stored[KEY.localVoiceEn] ?? "" },
        cloudService: stored[KEY.cloudService] === "elevenlabs" ? "elevenlabs" : "openai",
        cloudVoice: stored[KEY.cloudVoice] ?? "",
        rate: Number.isFinite(rate) && rate > 0 ? Math.min(1.8, Math.max(0.6, rate)) : 1,
        volume: Number.isFinite(volume) && stored[KEY.volume] ? Math.min(100, Math.max(0, volume)) : 80,
        device: stored[KEY.device] ?? "",
        answers: answers === "summary" || answers === "full" ? answers : "never",
        quietMeeting: flag(stored[KEY.quietMeeting], true),
        quietDictation: flag(stored[KEY.quietDictation], true),
        readSelection: flag(stored[KEY.readSelection], true),
      });
      setNotificationOutput(stored[KEY.device] ?? "");
    } catch {
      set({ loaded: true });
    }
  },

  refresh: async () => {
    try {
      set({ status: await speechStatus() });
    } catch {
      // The pane keeps what it last knew.
    }
  },

  loadOutputs: async () => {
    try {
      set({ outputs: await audioOutputs() });
    } catch {
      set({ outputs: [] });
    }
  },

  setEngine: (engine) => write(set, KEY.engine, { engine }, engine),
  setSystemVoice: (lang, id) =>
    write(set, lang === "es" ? KEY.systemVoiceEs : KEY.systemVoiceEn, { systemVoices: { ...get().systemVoices, [lang]: id } }, id),
  setLocalVoice: (lang, id) =>
    write(set, lang === "es" ? KEY.localVoiceEs : KEY.localVoiceEn, { localVoices: { ...get().localVoices, [lang]: id } }, id),
  setCloudService: (service) => write(set, KEY.cloudService, { cloudService: service }, service),
  setCloudVoice: (voice) => write(set, KEY.cloudVoice, { cloudVoice: voice }, voice),
  setRate: (rate) => write(set, KEY.rate, { rate }, String(rate)),
  setVolume: (volume) => write(set, KEY.volume, { volume }, String(volume)),
  setDevice: async (id) => {
    setNotificationOutput(id);
    await write(set, KEY.device, { device: id }, id);
  },
  setAnswers: (mode) => write(set, KEY.answers, { answers: mode }, mode),
  setQuietMeeting: (on) => write(set, KEY.quietMeeting, { quietMeeting: on }, String(on)),
  setQuietDictation: (on) => write(set, KEY.quietDictation, { quietDictation: on }, String(on)),
  setReadSelection: (on) => write(set, KEY.readSelection, { readSelection: on }, String(on)),

  setKey: async (service, key) => {
    try {
      await speechSetKey(service, key);
      await get().refresh();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  install: async (id) => {
    ensureSpeechEvents();
    set((s) => ({ installing: id, progress: { ...s.progress, [id]: { item: id, phase: "downloading", done: 0, total: 0 } } }));
    try {
      // Nothing to choose afterwards: «Automática» reads a language with its first downloaded voice.
      await speechInstallVoice(id);
    } catch (error) {
      const message = String(error);
      if (message !== "cancelled") pushErrorToast(message);
    } finally {
      set({ installing: null });
      await get().refresh();
    }
  },

  cancelInstall: async () => {
    await speechCancelInstall().catch(() => {});
  },

  remove: async (id) => {
    try {
      await speechRemoveVoice(id);
      const lang = voiceLanguage(get().status?.voices.find((voice) => voice.id === id)?.lang ?? "");
      if (get().localVoices[lang] === id) await get().setLocalVoice(lang, "");
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  say: async (text, origin, options) => {
    const said = text.trim();
    if (!said) return null;
    // What the user just asked to hear is said even in a quiet moment; what arrives on its own is not.
    const asked = origin === "test" || origin === "message" || origin === "selection";
    if (!asked && quietNow()) return null;
    // The window's language only settles a text too short to tell its own (`speech::language_of`).
    try {
      return await speechSay(said, origin, options?.interrupt ?? false, useLanguageStore.getState().language);
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  speakAnswer: (markdown, workspaceId) => {
    const mode = get().answers;
    if (mode === "never" || quietNow()) return;
    const text = speakable(markdown);
    if (!text) return;
    if (mode === "full" || text.length <= SUMMARY_THRESHOLD) {
      get().say(text, "answer");
      return;
    }
    void speechSummarize(markdown, workspaceId)
      .then((summary) => get().say(speakable(summary), "answer"))
      // No summary (no engine, a quota): the answer's first sentences rather than silence.
      .catch(() => get().say(firstSentences(text), "answer"));
  },

  stop: () => {
    void speechStop().catch(() => {});
  },
}));

/** The settings row and the store field, optimistically. */
async function write(
  set: (partial: Partial<SpeechStoreState>) => void,
  key: string,
  partial: Partial<SpeechStoreState>,
  value: string,
): Promise<void> {
  set(partial);
  await setSetting(key, value).catch((error) => pushErrorToast(String(error)));
}

/** A meeting being recorded, or a dictation under way — the two moments a voice would be heard by the microphone. */
function quietNow(): boolean {
  const { quietMeeting, quietDictation } = useSpeechStore.getState();
  if (quietMeeting && useMeetingsStore.getState().status?.recording) return true;
  if (quietDictation && useDictationStore.getState().phase !== "idle") return true;
  return false;
}

/** About two sentences, for an answer that could not be summarised. */
function firstSentences(text: string): string {
  const parts = text.match(/[^.!?…]+[.!?…]+/g) ?? [text];
  let out = "";
  for (const part of parts) {
    if (out.length > 0 && out.length + part.length > SUMMARY_THRESHOLD) break;
    out += part;
  }
  return out.trim();
}

let lastError = { text: "", at: 0 };
let listening = false;

/** The backend's events, once per window. Also how notifications reach the voice. */
export function ensureSpeechEvents(): void {
  if (listening) return;
  listening = true;
  void onSpeechState((event) => {
    if (event.phase === "preparing") {
      useSpeechStore.setState({ speaking: { id: event.id, text: event.text, origin: event.origin, phase: "preparing" } });
      return;
    }
    if (event.phase === "speaking") {
      startVoice(event.envelope, event.stepMs);
      useSpeechStore.setState({ speaking: { id: event.id, text: event.text, origin: event.origin, phase: "speaking" } });
      return;
    }
    if (useSpeechStore.getState().speaking?.id === event.id) {
      endVoice();
      useSpeechStore.setState({ speaking: null });
    }
    if (event.phase === "failed" && event.error) {
      const text = event.error === SPEECH_NO_KEY ? translate("speech.noKey") : translate("speech.failed", { error: event.error });
      // One toast for a burst: five notifications failing for the same reason are one problem.
      if (text !== lastError.text || Date.now() - lastError.at > 30_000) pushErrorToast(text);
      lastError = { text, at: Date.now() };
    }
  });
  void onSpeechDownload((event) => {
    useSpeechStore.setState((s) => ({ progress: { ...s.progress, [event.item]: event } }));
    if (event.phase === "done" || event.phase === "failed" || event.phase === "cancelled") {
      window.setTimeout(() => useSpeechStore.setState((s) => ({ progress: { ...s.progress, [event.item]: undefined } })), 1500);
    }
  });
  onNotificationPushed((item) => {
    if (!usePreferencesStore.getState().spokenNotificationSources.includes(item.source)) return;
    const source = translate(NOTIFICATION_SOURCE_LABEL[item.source]);
    const title = translate(item.titleKey, item.params);
    useSpeechStore.getState().say(`${source}: ${title}${item.detail ? `. ${item.detail}` : ""}`, "notification");
  });
}

watchSettings(Object.values(KEY), () => {
  if (useSpeechStore.getState().loaded) void useSpeechStore.getState().load();
});
