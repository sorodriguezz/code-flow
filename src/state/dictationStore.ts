import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import {
  dictationCancel,
  dictationCancelInstall,
  dictationInstall,
  dictationRemove,
  dictationStatus,
  dictationTranscribe,
  onDictationProgress,
  type DictationProgress,
  type DictationStatus,
} from "../lib/tauri/dictationCommands";
import { pcmToBase64, startRecording, type Recording } from "../lib/dictation/recorder";
import { aiFieldOf, insertDictation, type DictationField } from "../lib/dictation/insert";
import { watchSettings } from "../lib/settingsSync";
import { useLanguageStore, translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";

/**
 * «Dictar»: what is installed (Settings), and the one recording that may be under way (the fields).
 *
 * **Ready means chosen and on disk.** Nothing is installed by default; until the engine and the
 * model the `dictation_model` setting names are both there, `dictationReady` is false and no
 * microphone is drawn anywhere.
 *
 * **One recording at a time, in one field.** A session belongs to the field it started in: the
 * transcript goes where its caret was then, even if focus wandered to the dictation bar's own
 * buttons meanwhile. `inline` says the field draws the bar itself (a composer with a send button);
 * otherwise `DictationOverlay` floats one beside it.
 */

const KEY_MODEL = "dictation_model";
const KEY_LANGUAGE = "dictation_language";
/** How many levels the waveform keeps — more than any bar is wide. */
const LEVELS = 240;

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

interface DictationStore {
  status: DictationStatus | null;
  /** `dictation_model`: the chosen model's id, `""` for none. */
  model: string;
  /** `dictation_language`: `""` follows the app's language, `"auto"` lets the model tell. */
  language: string;
  /** Install progress by item (`"engine"` or a model id) — dropped when it settles. */
  progress: Record<string, DictationProgress>;
  /** The model whose install is under way: the engine's progress is drawn on its row. */
  installing: string | null;

  phase: DictationPhase;
  target: DictationField | null;
  inline: boolean;
  /** The microphone's level per buffer, newest last — the waveform. */
  levels: number[];

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  install: (modelId: string) => Promise<void>;
  cancelInstall: () => Promise<void>;
  remove: (modelId: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setLanguage: (language: string) => Promise<void>;

  /** Starts recording for `field`. `inline` when the field's own surface draws the bar. */
  start: (field: DictationField, inline: boolean) => Promise<void>;
  /** Stops, transcribes and writes the text into the field — and sends it, with `send`. */
  finish: (send: boolean) => Promise<void>;
  /** Drops the recording (or the transcription under way). */
  cancel: () => void;
  /** The global shortcut: start in the focused AI field, or finish the recording under way. */
  toggle: () => void;
}

export function dictationReady(state: Pick<DictationStore, "status" | "model">): boolean {
  const status = state.status;
  return !!status?.engineInstalled && status.models.some((model) => model.id === state.model && model.installed);
}

/** What a field does to send — registered by the composers that have a send button. */
const senders = new WeakMap<DictationField, () => void>();

/** Registers how `field` sends what is written in it; returns the undo. */
export function registerDictationSend(field: DictationField | null, send: () => void): () => void {
  if (!field) return () => {};
  senders.set(field, send);
  return () => senders.delete(field);
}

export function canSend(field: DictationField | null): boolean {
  return !!field && (senders.has(field) || field.closest("[data-ai-input]")?.getAttribute("data-ai-input") === "enter");
}

let recording: Recording | null = null;
let selection: { start: number; end: number } | null = null;
/** Bumped by every start and cancel, so a transcription that returns after its session ended
 *  writes nothing. */
let session = 0;
let subscribed = false;

function onEscape(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    useDictationStore.getState().cancel();
  }
}

function language(written: string): string {
  if (written === "auto") return "auto";
  if (written) return written;
  return useLanguageStore.getState().language === "es" ? "es" : "en";
}

function micMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return translate("dictation.micBlocked");
  if (name === "NotFoundError") return translate("dictation.noMic");
  return translate("dictation.micFailed", { error: String(error) });
}

export const useDictationStore = create<DictationStore>((set, get) => ({
  status: null,
  model: "",
  language: "",
  progress: {},
  installing: null,
  phase: "idle",
  target: null,
  inline: false,
  levels: [],

  load: async () => {
    if (!subscribed) {
      subscribed = true;
      void onDictationProgress((event) => {
        set((current) => {
          if (event.phase === "done" || event.phase === "cancelled") {
            const { [event.item]: _settled, ...rest } = current.progress;
            return { progress: rest };
          }
          return { progress: { ...current.progress, [event.item]: event } };
        });
        if (event.phase === "done" || event.phase === "failed" || event.phase === "cancelled") void get().refresh();
      });
    }
    if (get().status) return;
    await get().refresh();
  },

  refresh: async () => {
    try {
      const [status, settings] = await Promise.all([dictationStatus(), getSettings([KEY_MODEL, KEY_LANGUAGE])]);
      set({ status, model: settings[KEY_MODEL] ?? "", language: settings[KEY_LANGUAGE] ?? "" });
    } catch {
      // Silent: the pane shows what it last knew, and the microphone stays hidden.
    }
  },

  install: async (modelId) => {
    set((current) => ({
      installing: modelId,
      progress: { ...current.progress, [modelId]: { item: modelId, phase: "downloading", done: 0, total: 0 } },
    }));
    try {
      await dictationInstall(modelId);
      // The first model installed is the one used; a later one waits for "Usar".
      const { status, model } = get();
      const current = status?.models.find((entry) => entry.id === model);
      if (!model || !current?.installed) await get().setModel(modelId);
    } catch (error) {
      const message = String(error);
      if (!message.includes("cancelled")) {
        set((current) => ({ progress: { ...current.progress, [modelId]: { item: modelId, phase: "failed", done: 0, total: 0, error: message } } }));
      }
    } finally {
      set({ installing: null });
      await get().refresh();
    }
  },

  cancelInstall: async () => {
    await dictationCancelInstall().catch((error) => pushErrorToast(String(error)));
  },

  remove: async (modelId) => {
    try {
      await dictationRemove(modelId);
      if (get().model === modelId) await setSetting(KEY_MODEL, "");
    } catch (error) {
      pushErrorToast(String(error));
    }
    await get().refresh();
  },

  setModel: async (modelId) => {
    set({ model: modelId });
    await setSetting(KEY_MODEL, modelId).catch((error) => pushErrorToast(String(error)));
  },

  setLanguage: async (next) => {
    set({ language: next });
    await setSetting(KEY_LANGUAGE, next).catch((error) => pushErrorToast(String(error)));
  },

  start: async (field, inline) => {
    if (get().phase !== "idle" || !dictationReady(get())) return;
    const mine = ++session;
    selection = { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length };
    set({ phase: "starting", target: field, inline, levels: [] });
    try {
      const started = await startRecording(
        (level) => {
          if (session !== mine) return;
          set((current) => {
            const levels = current.levels.length >= LEVELS ? current.levels.slice(1) : current.levels.slice();
            levels.push(level);
            return { levels };
          });
        },
        () => {
          if (session !== mine) return;
          useToastStore.getState().pushToast(translate("dictation.limit"), "info");
          void get().finish(false);
        },
      );
      if (session !== mine) {
        started.cancel();
        return;
      }
      recording = started;
      set({ phase: "recording" });
      window.addEventListener("keydown", onEscape, true);
    } catch (error) {
      if (session === mine) set({ phase: "idle", target: null });
      pushErrorToast(micMessage(error));
    }
  },

  finish: async (send) => {
    const { phase, target, model } = get();
    if (phase !== "recording" || !recording || !target) return;
    const mine = session;
    window.removeEventListener("keydown", onEscape, true);
    const pcm = recording.stop();
    recording = null;
    set({ phase: "transcribing" });
    window.addEventListener("keydown", onEscape, true);
    try {
      const text = await dictationTranscribe(pcmToBase64(pcm), model, language(get().language));
      if (session !== mine) return;
      if (!text.trim()) {
        useToastStore.getState().pushToast(translate("dictation.noSpeech"), "info");
        target.focus();
        return;
      }
      insertDictation(target, text.trim(), selection);
      if (send) {
        const sender = senders.get(target);
        // After React has rendered the new text: the composers send what is in their state.
        setTimeout(() => {
          if (sender) sender();
          else target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
        }, 0);
      }
    } catch (error) {
      if (session === mine && !String(error).includes("cancelled")) pushErrorToast(String(error));
    } finally {
      if (session === mine) {
        window.removeEventListener("keydown", onEscape, true);
        set({ phase: "idle", target: null, levels: [] });
      }
    }
  },

  cancel: () => {
    const { phase, target } = get();
    if (phase === "idle") return;
    session += 1;
    window.removeEventListener("keydown", onEscape, true);
    recording?.cancel();
    recording = null;
    if (phase === "transcribing") void dictationCancel().catch(() => {});
    set({ phase: "idle", target: null, levels: [] });
    target?.focus();
  },

  toggle: () => {
    const state = get();
    if (state.phase === "recording") {
      void state.finish(false);
      return;
    }
    if (state.phase !== "idle" || !dictationReady(state)) return;
    const field = aiFieldOf(document.activeElement);
    if (!field) return;
    void state.start(field, field.closest("[data-ai-input]")?.getAttribute("data-ai-input") === "inline");
  },
}));

// Another window chose a model, installed one or changed the language.
watchSettings([KEY_MODEL, KEY_LANGUAGE], () => {
  if (useDictationStore.getState().status) void useDictationStore.getState().refresh();
});
