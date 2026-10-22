import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import {
  CODI_MISSING,
  codiConfirm,
  codiHush,
  codiOrder,
  codiPrepare,
  codiSetMic,
  codiSetSound,
  codiStatus,
  codiTalk,
  onCodiAnnounce,
  onCodiConfirm,
  onCodiHeard,
  onCodiLevel,
  onCodiPrepare,
  onCodiState,
  onCodiTurn,
  type CodiConfirmation,
  type CodiHeard,
  type CodiPhase,
  type CodiPrepare,
  type CodiState,
  type CodiTurn,
} from "../lib/tauri/codiCommands";
import { onSpeechState } from "../lib/tauri/speechCommands";
import { endListen, setListenLevel } from "../lib/thinking/listen";
import { appendVoice, endVoice, startVoice } from "../lib/thinking/voice";
import { watchSettings } from "../lib/settingsSync";
import { reportMicError } from "./dictationStore";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";

/**
 * «Codi», as one window sees it: the runtime's state (`codi:*`, from `crate::codi`), what it heard
 * and did lately, the confirmation it may be waiting on, and its settings.
 *
 * Per window, like every store: the Codi window draws all of it; the main window reads `state.mic`
 * for its title-bar button, the status bar's «Codi escucha» and the announcer branch in
 * `speechStore`; Settings › Voz y sonido › Codi reads and writes the settings half. The runtime
 * itself is the backend's — every action here is a command, and what comes back arrives as an event
 * every window hears.
 */

export const CODI_KEYS = {
  listenModel: "codi_listen_model",
  mode: "codi_listen_mode",
  wakeWords: "codi_wake_words",
  brain: "codi_brain",
  voiceEs: "codi_voice_es",
  voiceEn: "codi_voice_en",
} as const;

export type CodiMode = CodiState["mode"];
export type CodiBrain = "tiers" | "provider" | "local";

export interface CodiSettings {
  /** A listener's id, `""` = what this machine is recommended. */
  listenModel: string;
  mode: CodiMode;
  /** Extra names, comma-separated, beside «Codi». */
  wakeWords: string;
  brain: CodiBrain;
  /** A downloaded voice per language, `""` = the reading aloud's. */
  voiceEs: string;
  voiceEn: string;
}

const DEFAULT_SETTINGS: CodiSettings = { listenModel: "", mode: "wake", wakeWords: "", brain: "tiers", voiceEs: "", voiceEn: "" };

/** How many of each the window keeps — more than it draws. */
export const HEARD_KEPT = 6;
export const TURNS_KEPT = 30;
export const ANNOUNCED_KEPT = 10;

export interface HeardLine extends CodiHeard {
  /** `Date.now()` when it arrived. */
  at: number;
}

export interface TurnLine extends CodiTurn {
  at: number;
}

export interface AnnouncedLine {
  text: string;
  source: string;
  at: number;
}

export interface PrepareProgress {
  running: boolean;
  /** `library` · `detector` · a listener's id — what is downloading now. */
  item: string | null;
  done: number;
  total: number;
  error: string | null;
}

const IDLE_PREPARE: PrepareProgress = { running: false, item: null, done: 0, total: 0, error: null };

interface CodiStore {
  /** `null` until the first `codi_status` answers (or in a build without the backend half). */
  state: CodiState | null;
  /** `performance.now()` when the phase last changed — the `ask` cue's `at` while it waits. */
  phaseSince: number;
  /** Newest first. */
  heard: HeardLine[];
  turns: TurnLine[];
  announced: AnnouncedLine[];
  /** `performance.now()` of the last utterance addressed to it — the face's wake cue. */
  wakeAt: number | null;
  /** The destructive action waiting for a yes, or `null`. */
  confirmation: CodiConfirmation | null;
  prepare: PrepareProgress;
  /** A switch whose command is under way, so a double click does not send two. */
  switching: boolean;

  settings: CodiSettings;
  settingsLoaded: boolean;

  /** Subscribes (once) and reads the state. Safe to call from every component that needs it. */
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setMic: (on: boolean) => Promise<void>;
  setSound: (on: boolean) => Promise<void>;
  /** Downloads what is missing, then opens the microphone. */
  prepareAndListen: () => Promise<void>;
  talk: (held: boolean) => void;
  order: (text: string) => void;
  confirm: (yes: boolean) => Promise<void>;
  hush: () => void;

  loadSettings: () => Promise<void>;
  setSettingValue: <K extends keyof CodiSettings>(key: K, value: CodiSettings[K]) => Promise<void>;
}

/** The phases the microphone's level is drawn in. */
export function listensIn(phase: CodiPhase | undefined): boolean {
  return phase === "idle" || phase === "hearing";
}

/** `CODI_MISSING:library,listener` → `["library", "listener"]`; `null` for any other error. */
export function parseMissing(error: unknown): CodiState["missing"] | null {
  const message = String(error);
  const at = message.indexOf(`${CODI_MISSING}:`);
  if (at < 0) return null;
  const list = message.slice(at + CODI_MISSING.length + 1).split(/[,:\s]/);
  return list.filter((item): item is CodiState["missing"][number] => item === "library" || item === "detector" || item === "listener");
}

const mode = (stored: string | undefined): CodiMode => (stored === "conversation" || stored === "ptt" ? stored : "wake");
const brain = (stored: string | undefined): CodiBrain => (stored === "provider" || stored === "local" ? stored : "tiers");

export const useCodiStore = create<CodiStore>((set, get) => ({
  state: null,
  phaseSince: 0,
  heard: [],
  turns: [],
  announced: [],
  wakeAt: null,
  confirmation: null,
  prepare: IDLE_PREPARE,
  switching: false,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,

  load: async () => {
    ensureCodiEvents();
    if (!get().state) await get().refresh();
  },

  refresh: async () => {
    try {
      applyState(await codiStatus());
    } catch {
      // A build without the backend half: nothing listens, and nothing is drawn as listening.
    }
  },

  setMic: async (on) => {
    if (get().switching) return;
    set({ switching: true });
    try {
      applyState(await codiSetMic(on));
    } catch (error) {
      const missing = parseMissing(error);
      if (missing) {
        // What the window offers to prepare — the backend's own list, fresher than ours.
        const state = get().state;
        if (state) applyState({ ...state, missing });
        void get().refresh();
      } else {
        reportMicError(error);
      }
    } finally {
      set({ switching: false });
    }
  },

  setSound: async (on) => {
    try {
      applyState(await codiSetSound(on));
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  prepareAndListen: async () => {
    if (get().prepare.running) return;
    set({ prepare: { ...IDLE_PREPARE, running: true } });
    try {
      applyState(await codiPrepare());
      set({ prepare: IDLE_PREPARE });
      await get().setMic(true);
    } catch (error) {
      const message = String(error);
      const failed = message === "cancelled" ? null : message;
      set({ prepare: { ...IDLE_PREPARE, error: failed } });
      if (failed) pushErrorToast(translate("codi.window.prepareFailed", { error: failed }));
      void get().refresh();
    }
  },

  talk: (held) => {
    void codiTalk(held).catch(() => {});
  },

  order: (text) => {
    const said = text.trim();
    if (!said) return;
    void codiOrder(said).catch((error) => pushErrorToast(String(error)));
  },

  confirm: async (yes) => {
    const pending = get().confirmation;
    if (!pending) return;
    // Cleared at once: the card answered is gone, whatever the backend's echo says later.
    set({ confirmation: null });
    try {
      await codiConfirm(pending.id, yes);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  hush: () => {
    void codiHush().catch(() => {});
  },

  loadSettings: async () => {
    try {
      const stored = await getSettings(Object.values(CODI_KEYS));
      set({
        settingsLoaded: true,
        settings: {
          listenModel: stored[CODI_KEYS.listenModel] ?? "",
          mode: mode(stored[CODI_KEYS.mode]),
          wakeWords: stored[CODI_KEYS.wakeWords] ?? "",
          brain: brain(stored[CODI_KEYS.brain]),
          voiceEs: stored[CODI_KEYS.voiceEs] ?? "",
          voiceEn: stored[CODI_KEYS.voiceEn] ?? "",
        },
      });
    } catch {
      set({ settingsLoaded: true });
    }
  },

  setSettingValue: async (key, value) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    try {
      await setSetting(CODI_KEYS[key], String(value));
    } catch (error) {
      pushErrorToast(String(error));
      return;
    }
    // The mode and the listener are part of `codi:state`, which the backend re-reads on its own
    // only at its next change — read it now so every switch here shows the pick.
    if (key === "mode" || key === "listenModel") void get().refresh();
  },
}));

/** One state from the backend, wherever it came from (an event or a command's answer). */
export function applyState(next: CodiState): void {
  const before = useCodiStore.getState().state;
  const changed = before?.phase !== next.phase;
  useCodiStore.setState({ state: next, ...(changed ? { phaseSince: performance.now() } : {}) });
  // The face draws the microphone only while it listens; anything else ends the feed, so a mark
  // drawn listening later starts from silence rather than from the last syllable.
  if (!listensIn(next.phase)) endListen();
  // A confirmation is only ever pending while Codi waits on it.
  if (changed && next.phase !== "waiting" && useCodiStore.getState().confirmation) useCodiStore.setState({ confirmation: null });
}

/** `codi:heard`. */
export function applyHeard(heard: CodiHeard, now: number = performance.now()): void {
  useCodiStore.setState((s) => ({
    heard: [{ ...heard, at: Date.now() }, ...s.heard].slice(0, HEARD_KEPT),
    ...(heard.addressed ? { wakeAt: now } : {}),
  }));
}

/** `codi:turn`. */
export function applyTurn(turn: CodiTurn): void {
  useCodiStore.setState((s) => ({ turns: [{ ...turn, at: Date.now() }, ...s.turns.filter((t) => t.id !== turn.id)].slice(0, TURNS_KEPT) }));
}

/** `codi:confirm`: a question (`answer: null`) is shown; its answer clears it. */
export function applyConfirmation(question: CodiConfirmation): void {
  if (question.answer === null) {
    useCodiStore.setState({ confirmation: question });
    return;
  }
  if (useCodiStore.getState().confirmation?.id === question.id) useCodiStore.setState({ confirmation: null });
}

/** `codi:announce`. */
export function applyAnnounce(said: { text: string; source: string }): void {
  useCodiStore.setState((s) => ({ announced: [{ ...said, at: Date.now() }, ...s.announced].slice(0, ANNOUNCED_KEPT) }));
}

/** `codi:prepare`, while this window's prepare runs — a progress frame that lands after the command
 *  has answered must not start the bar again. */
export function applyPrepare(progress: CodiPrepare): void {
  if (!useCodiStore.getState().prepare.running) return;
  useCodiStore.setState({ prepare: { running: true, item: progress.item, done: progress.done, total: progress.total, error: null } });
}

/** `codi:level`: drawn only while it listens. */
export function applyLevel(level: number): void {
  if (listensIn(useCodiStore.getState().state?.phase)) setListenLevel(level);
}

let subscribed = false;
let levelSubscribed = false;
let voiceSubscribed = false;

/** The runtime's events, once per window. Not the level — see [`ensureCodiLevel`]. */
export function ensureCodiEvents(): void {
  if (subscribed) return;
  subscribed = true;
  void onCodiState(applyState).catch(() => {});
  void onCodiHeard((heard) => applyHeard(heard)).catch(() => {});
  void onCodiTurn(applyTurn).catch(() => {});
  void onCodiConfirm(applyConfirmation).catch(() => {});
  void onCodiAnnounce(applyAnnounce).catch(() => {});
  void onCodiPrepare(applyPrepare).catch(() => {});
}

/**
 * The microphone's level, ~25 a second — only in the window that draws it (Codi's own). A window
 * that never listens for `codi:level` is never sent it, and the main window's small mark makes do
 * with the stand-in pattern (`listenLevel` with nothing fed).
 */
export function ensureCodiLevel(): void {
  if (levelSubscribed) return;
  levelSubscribed = true;
  void onCodiLevel(applyLevel).catch(() => {});
}

/**
 * Codi's voice, for the face to move with while it speaks — what `speechStore`'s listener does for
 * the reading aloud, for Codi's own utterances (`origin: "codi"`) only. The Codi window does not load
 * `speechStore` (and its notifications, meetings and dictation behind it), so this is the one feed
 * there. A window that also runs `ensureSpeechEvents` must not call this.
 */
export function ensureCodiVoice(): void {
  if (voiceSubscribed) return;
  voiceSubscribed = true;
  let current: number | null = null;
  void onSpeechState((event) => {
    if (event.origin !== "codi") return;
    if (event.phase === "speaking") {
      if (event.append && current === event.id) appendVoice(event.envelope);
      else startVoice(event.envelope, event.stepMs);
      current = event.id;
      return;
    }
    if (event.phase !== "preparing" && current === event.id) {
      current = null;
      endVoice();
    }
  }).catch(() => {});
}

/** Tests only. */
export function resetCodiStoreForTests(): void {
  subscribed = false;
  levelSubscribed = false;
  voiceSubscribed = false;
  useCodiStore.setState({
    state: null,
    phaseSince: 0,
    heard: [],
    turns: [],
    announced: [],
    wakeAt: null,
    confirmation: null,
    prepare: IDLE_PREPARE,
    switching: false,
    settings: DEFAULT_SETTINGS,
    settingsLoaded: false,
  });
}

// Settings › Codi is the main window's; Codi's window shows the mode and the listener in use, which
// are read through `codi_status` — so a write over there is a re-read here.
watchSettings(Object.values(CODI_KEYS), () => {
  const store = useCodiStore.getState();
  if (store.settingsLoaded) void store.loadSettings();
  if (store.state) void store.refresh();
});
