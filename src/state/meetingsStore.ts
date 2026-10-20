import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import {
  meetingsCancelInstall,
  meetingsDelete,
  meetingsDetail,
  meetingsDiscard,
  meetingsForNote,
  meetingsImport,
  meetingsInstall,
  meetingsNotesWith,
  meetingsPause,
  meetingsReprocess,
  meetingsStart,
  meetingsStatus,
  meetingsStop,
  meetingsTranscribe,
  meetingsSystemAudioSettings,
  MIC_DENIED,
  NO_CLOUD_KEY,
  NO_MODEL,
  onMeetingDetected,
  onMeetingDownload,
  onMeetingLag,
  onMeetingLevel,
  onMeetingMonitor,
  onMeetingLine,
  onMeetingProgress,
  onMeetingState,
  SYSTEM_AUDIO_DENIED,
  type DownloadEvent,
  type Meeting,
  type MeetingBench,
  type MeetingDetail,
  type MeetingMode,
  type MeetingsStatus,
  type ProgressEvent,
  meetingsSetMicMuted,
} from "../lib/tauri/meetingsCommands";
import { dictationMicSettings } from "../lib/tauri/dictationCommands";
import { watchSettings } from "../lib/settingsSync";
import { setNotificationSoundsSuppressed } from "../lib/notificationSound";
import { isMainWindow } from "../lib/windowIdentity";
import { translate } from "./languageStore";
import { pushErrorToast, useToastStore } from "./toastStore";
import { useConfirmStore } from "./confirmStore";
import { useWorkspaceStore } from "./workspaceStore";
import { useUiStore } from "./uiStore";

/**
 * «Reuniones» in the windows: what is installed, the one meeting being recorded (its levels, its
 * live lines, how far behind the text is), the meetings of the notes looked at, and the jobs that
 * finish them.
 *
 * **The backend owns the recording.** This store mirrors it from events — `meetings:level`,
 * `meetings:line`, `meetings:state`, `meetings:progress` — so a satellite window, a reload, or the
 * main window coming back from the tray all show the same meeting in the same state:
 * `refreshStatus` asks again whenever it may have missed something.
 *
 * **The badge list follows the workspace** (`notesWith`), subscribed at the bottom of this file —
 * the rule `notesStore` and `diagramsStore` keep, so a workspace switch can never show one
 * workspace's microphones on another's notes.
 */

export const KEYS = {
  mode: "meetings_mode",
  transcriber: "meetings_transcriber",
  liveModel: "meetings_live_model",
  finalModel: "meetings_final_model",
  cloud: "meetings_cloud",
  threads: "meetings_threads",
  audioDays: "meetings_audio_days",
  detect: "meetings_detect",
  bench: "meetings_bench",
  vocabulary: "meetings_vocabulary",
  consent: "meetings_consent_seen",
  micGain: "meetings_mic_gain",
  afterStop: "meetings_after_stop",
} as const;

export interface MeetingSettings {
  /** `""` = automatic. */
  mode: "" | MeetingMode;
  transcriber: "local" | "cloud";
  liveModel: string;
  finalModel: string;
  cloudUrl: string;
  cloudModel: string;
  threads: number;
  audioDays: number;
  detect: boolean;
  vocabulary: string;
  bench: MeetingBench | null;
  consentSeen: boolean;
  /** The microphone's gain, linear (1 = as the device hears it). */
  micGain: number;
  /** «Detener» transcribes at once; `false` keeps the recording to be transcribed later. */
  transcribeOnStop: boolean;
}

const DEFAULT_SETTINGS: MeetingSettings = {
  mode: "",
  transcriber: "local",
  liveModel: "",
  finalModel: "",
  cloudUrl: "",
  cloudModel: "",
  threads: 0,
  audioDays: 30,
  detect: true,
  vocabulary: "",
  bench: null,
  consentSeen: false,
  micGain: 1,
  transcribeOnStop: true,
};

/** How many levels each channel keeps for the waveform. */
const LEVELS = 120;
export interface MeterBlocks {
  rms: number[];
  peak: number[];
}
const EMPTY_METER: Record<"mic" | "system", MeterBlocks> = { mic: { rms: [], peak: [] }, system: { rms: [], peak: [] } };

/** How many blocks a meter judges by: 2 s at the backend's 25 a second. */
const METER = 50;

interface MeetingsState {
  status: MeetingsStatus | null;
  settings: MeetingSettings;
  /** The recording's levels, newest last. */
  levels: { mic: number[]; system: number[] };
  /** Each input's last blocks, recording or not (the meters before a meeting starts): RMS and peak. */
  meter: Record<"mic" | "system", MeterBlocks>;
  /** Why a meter's input did not open (`MIC_DENIED`, `MIC_NONE`, `SYSTEM_AUDIO_DENIED`…). */
  meterError: Record<"mic" | "system", string | null>;
  /** The microphone silenced in this app only (`meetings_set_mic_muted`) — lifted when a recording stops. */
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  lag: { ms: number; behind: boolean } | null;
  /** Meetings by note id — loaded when a note is opened. */
  byNote: Record<string, Meeting[]>;
  details: Record<string, MeetingDetail>;
  progress: Record<string, ProgressEvent>;
  downloads: Partial<Record<"vad" | "voices", DownloadEvent>>;
  /** Which notes of `notesWithWorkspace` have a meeting. */
  notesWith: Set<string>;
  notesWithWorkspace: string | null;
  /** A call app using the microphone, offered for notes. */
  suggestion: { name: string } | null;
  /** Collapsed panels, by note id. */
  collapsed: Record<string, boolean>;
  /** A search result in a transcript, waiting for its note's meeting panel to show the line. */
  jumpTo: { noteId: string; meetingId: string; atMs: number } | null;
  /** When `status` was read — the recording's clock runs on from it. */
  statusAt: number;
  /** The note whose "record a meeting" options are open. */
  startOpenFor: string | null;
  /** AI runs by meeting: what is being written, and an answer waiting to be read or inserted. */
  ai: Record<string, MeetingAiRun>;

  refreshStatus: () => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSetting: (key: keyof typeof KEYS, value: string) => Promise<void>;
  loadNote: (noteId: string) => Promise<void>;
  loadDetail: (meetingId: string) => Promise<MeetingDetail | null>;
  loadNotesWith: (workspaceId: string | null) => Promise<void>;
  start: (args: { noteId: string; workspaceId: string; kind: "virtual" | "room"; mode?: MeetingMode; language: string }) => Promise<boolean>;
  pause: (meetingId: string, paused: boolean) => Promise<void>;
  /** `transcribe` overrides the «Al detener» setting for this one recording. */
  stop: (meetingId: string, transcribe?: boolean) => Promise<void>;
  /** Transcribes a recording that was kept for later. */
  transcribe: (meetingId: string) => Promise<void>;
  discard: (meetingId: string) => Promise<void>;
  remove: (meetingId: string) => Promise<void>;
  reprocess: (meetingId: string, retranscribe: boolean, speakers: number, cloud?: boolean) => Promise<void>;
  importFile: (noteId: string, workspaceId: string, path: string, language: string) => Promise<void>;
  install: (item: "vad" | "voices") => Promise<void>;
  cancelInstall: () => Promise<void>;
  dismissSuggestion: () => void;
  toggleCollapsed: (noteId: string) => void;
  /** Opens a transcript at a line: selects its meeting, unfolds the panel and puts the line in view. */
  jumpToLine: (noteId: string, meetingId: string, atMs: number) => void;
  clearJump: () => void;
  setStartOpen: (noteId: string | null) => void;
  setAi: (meetingId: string, run: MeetingAiRun | null) => void;
}

export interface MeetingAiRun {
  runId: string;
  /** What is being written — a recipe's name, or the question. */
  label: string;
  question: boolean;
  status: "running" | "ready" | "failed";
  markdown?: string;
  error?: string;
}

function parseSettings(raw: Record<string, string>): MeetingSettings {
  let cloud: { url?: string; model?: string } = {};
  try {
    cloud = JSON.parse(raw[KEYS.cloud] || "{}");
  } catch {
    cloud = {};
  }
  let bench: MeetingBench | null = null;
  try {
    bench = raw[KEYS.bench] ? (JSON.parse(raw[KEYS.bench]) as MeetingBench) : null;
  } catch {
    bench = null;
  }
  const mode = raw[KEYS.mode];
  const days = Number.parseInt(raw[KEYS.audioDays] ?? "", 10);
  return {
    mode: mode === "light" || mode === "balanced" || mode === "full" ? mode : "",
    transcriber: raw[KEYS.transcriber] === "cloud" ? "cloud" : "local",
    liveModel: raw[KEYS.liveModel] ?? "",
    finalModel: raw[KEYS.finalModel] ?? "",
    cloudUrl: cloud.url ?? "",
    cloudModel: cloud.model ?? "",
    threads: Number.parseInt(raw[KEYS.threads] ?? "0", 10) || 0,
    audioDays: Number.isFinite(days) ? days : 30,
    detect: raw[KEYS.detect] !== "0",
    vocabulary: raw[KEYS.vocabulary] ?? "",
    bench,
    consentSeen: raw[KEYS.consent] === "1",
    micGain: Number.parseFloat(raw[KEYS.micGain] ?? "") || 1,
    transcribeOnStop: raw[KEYS.afterStop] !== "keep",
  };
}

/** Replaces `meeting` in a note's list, or adds it. */
function withMeeting(byNote: Record<string, Meeting[]>, meeting: Meeting): Record<string, Meeting[]> {
  const list = byNote[meeting.noteId] ?? [];
  const next = list.some((m) => m.id === meeting.id) ? list.map((m) => (m.id === meeting.id ? meeting : m)) : [...list, meeting];
  return { ...byNote, [meeting.noteId]: next };
}

/** Says what a failed start means, with the way out when there is one. */
async function explainStartError(error: unknown) {
  const text = String(error);
  if (text.includes(MIC_DENIED)) {
    const open = await useConfirmStore.getState().ask({ message: translate("meetings.micDenied"), confirmLabel: translate("dictation.openPrivacy"), danger: false });
    if (open) void dictationMicSettings().catch(() => {});
    return;
  }
  if (text.includes(NO_CLOUD_KEY)) {
    const open = await useConfirmStore.getState().ask({ message: translate("meetings.noCloudKey"), confirmLabel: translate("meetings.openSettings"), danger: false });
    if (open) useUiStore.getState().openSettingsAt("voice", "meetings");
    return;
  }
  if (text.includes(NO_MODEL)) {
    const open = await useConfirmStore.getState().ask({ message: translate("meetings.noModel"), confirmLabel: translate("meetings.openSettings"), danger: false });
    if (open) useUiStore.getState().openSettingsAt("voice", "meetings");
    return;
  }
  pushErrorToast(text);
}

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  status: null,
  settings: DEFAULT_SETTINGS,
  levels: { mic: [], system: [] },
  meter: EMPTY_METER,
  meterError: { mic: null, system: null },
  micMuted: false,
  setMicMuted: (muted) => {
    set({ micMuted: muted });
    void meetingsSetMicMuted(muted).catch((error) => pushErrorToast(String(error)));
  },
  lag: null,
  byNote: {},
  details: {},
  progress: {},
  downloads: {},
  notesWith: new Set(),
  notesWithWorkspace: null,
  suggestion: null,
  collapsed: {},
  jumpTo: null,
  statusAt: 0,
  startOpenFor: null,
  ai: {},

  refreshStatus: async () => {
    try {
      const status = await meetingsStatus();
      // The app's own chimes would land in the call's channel of the recording.
      setNotificationSoundsSuppressed(!!status.recording);
      set((state) => ({
        status,
        statusAt: Date.now(),
        // A recording that ended elsewhere takes its waveform with it.
        levels: status.recording ? state.levels : { mic: [], system: [] },
        lag: status.recording ? state.lag : null,
      }));
    } catch {
      // The status is a mirror; the next event or refresh puts it right.
    }
  },

  loadSettings: async () => {
    try {
      const raw = await getSettings(Object.values(KEYS));
      set({ settings: parseSettings(raw) });
    } catch {
      // Defaults stand.
    }
  },

  saveSetting: async (key, value) => {
    await setSetting(KEYS[key], value);
    await get().loadSettings();
  },

  loadNote: async (noteId) => {
    try {
      const meetings = await meetingsForNote(noteId);
      set((state) => ({ byNote: { ...state.byNote, [noteId]: meetings } }));
      const latest = meetings[meetings.length - 1];
      if (latest) void get().loadDetail(latest.id);
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  loadDetail: async (meetingId) => {
    try {
      const detail = await meetingsDetail(meetingId);
      set((state) => ({ details: { ...state.details, [meetingId]: detail }, byNote: withMeeting(state.byNote, detail.meeting) }));
      return detail;
    } catch {
      return null;
    }
  },

  loadNotesWith: async (workspaceId) => {
    if (!workspaceId) {
      set({ notesWith: new Set(), notesWithWorkspace: null });
      return;
    }
    try {
      const ids = await meetingsNotesWith(workspaceId);
      // Only if the workspace is still the one asked about.
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) set({ notesWith: new Set(ids), notesWithWorkspace: workspaceId });
    } catch {
      // A badge, not data.
    }
  },

  start: async (args) => {
    try {
      const started = await meetingsStart(args);
      if (started.warning === SYSTEM_AUDIO_DENIED) {
        void useConfirmStore
          .getState()
          .ask({ message: translate("meetings.systemDenied"), confirmLabel: translate("dictation.openPrivacy"), danger: false })
          .then((open) => open && void meetingsSystemAudioSettings().catch(() => {}));
      }
      set((state) => ({
        byNote: withMeeting(state.byNote, started.meeting),
        details: { ...state.details, [started.meeting.id]: { meeting: started.meeting, lines: [], speakers: [], localOnly: false } },
        levels: { mic: [], system: [] },
        meterError: { mic: null, system: null },
        lag: null,
        notesWith: new Set([...state.notesWith, args.noteId]),
      }));
      await get().refreshStatus();
      void get().loadDetail(started.meeting.id);
      return true;
    } catch (error) {
      await explainStartError(error);
      return false;
    }
  },

  pause: async (meetingId, paused) => {
    try {
      await meetingsPause(meetingId, paused);
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  stop: async (meetingId, transcribe) => {
    try {
      const meeting = await meetingsStop(meetingId, transcribe);
      set((state) => ({ byNote: withMeeting(state.byNote, meeting), levels: { mic: [], system: [] }, meter: EMPTY_METER, micMuted: false, lag: null }));
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  discard: async (meetingId) => {
    try {
      await meetingsDiscard(meetingId);
      set({ micMuted: false });
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  remove: async (meetingId) => {
    try {
      await meetingsDelete(meetingId);
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  transcribe: async (meetingId) => {
    try {
      await meetingsTranscribe(meetingId);
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  reprocess: async (meetingId, retranscribe, speakers, cloud) => {
    try {
      await meetingsReprocess(meetingId, retranscribe, speakers, cloud);
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  importFile: async (noteId, workspaceId, path, language) => {
    try {
      const meeting = await meetingsImport(noteId, workspaceId, path, language);
      set((state) => ({ byNote: withMeeting(state.byNote, meeting), notesWith: new Set([...state.notesWith, noteId]) }));
      await get().refreshStatus();
    } catch (error) {
      await explainStartError(error);
    }
  },

  install: async (item) => {
    try {
      await meetingsInstall(item);
    } catch (error) {
      if (String(error) !== "cancelled") pushErrorToast(String(error));
    } finally {
      await get().refreshStatus();
    }
  },

  cancelInstall: async () => {
    await meetingsCancelInstall().catch(() => {});
  },

  dismissSuggestion: () => set({ suggestion: null }),

  toggleCollapsed: (noteId) => set((state) => ({ collapsed: { ...state.collapsed, [noteId]: !state.collapsed[noteId] } })),

  jumpToLine: (noteId, meetingId, atMs) =>
    set((state) => ({ jumpTo: { noteId, meetingId, atMs }, collapsed: { ...state.collapsed, [noteId]: false } })),

  clearJump: () => set({ jumpTo: null }),

  setStartOpen: (noteId) => set({ startOpenFor: noteId }),

  setAi: (meetingId, run) =>
    set((state) => {
      const ai = { ...state.ai };
      if (run) ai[meetingId] = run;
      else delete ai[meetingId];
      return { ai };
    }),
}));

function pushMeter(meter: MeterBlocks, rms: number, peak: number): MeterBlocks {
  return { rms: [...meter.rms, rms].slice(-METER), peak: [...meter.peak, peak].slice(-METER) };
}

let listening = false;

/** Attaches the event listeners once per window. */
export function ensureMeetingEvents() {
  if (listening) return;
  listening = true;
  const store = useMeetingsStore;
  void onMeetingLevel(({ meetingId, channel, level, peak }) => {
    if (store.getState().status?.recording?.meetingId !== meetingId) return;
    store.setState((state) => {
      const list = [...state.levels[channel], level];
      if (list.length > LEVELS) list.splice(0, list.length - LEVELS);
      // The recording's own level proves the channel works: a monitor's error from before it started
      // (on Windows the meeting's loopback invalidates the monitor's stream) must not stay shown.
      return {
        levels: { ...state.levels, [channel]: list },
        meter: { ...state.meter, [channel]: pushMeter(state.meter[channel], level, peak) },
        meterError: state.meterError[channel] ? { ...state.meterError, [channel]: null } : state.meterError,
      };
    });
  });
  void onMeetingMonitor(({ channel, level, peak, error }) => {
    if (store.getState().status?.recording) return;
    store.setState((state) => ({
      meterError: { ...state.meterError, [channel]: error },
      meter: { ...state.meter, [channel]: error ? { rms: [], peak: [] } : pushMeter(state.meter[channel], level, peak) },
    }));
  });
  void onMeetingLine(({ meetingId, line }) => {
    store.setState((state) => {
      const detail = state.details[meetingId];
      if (!detail) return {};
      const lines = [...detail.lines.filter((l) => l.seq !== line.seq), line].sort((a, b) => a.startMs - b.startMs || a.seq - b.seq);
      const speakers = detail.speakers.some((s) => s.key === line.speaker)
        ? detail.speakers
        : [...detail.speakers, { key: line.speaker, name: "", color: detail.speakers.length, isMe: line.speaker === "me", voiceId: "", talkMs: 0, hasVoice: false }];
      return { details: { ...state.details, [meetingId]: { ...detail, lines, speakers } } };
    });
  });
  void onMeetingLag(({ meetingId, lagMs, behind }) => {
    if (store.getState().status?.recording?.meetingId !== meetingId) return;
    store.setState({ lag: { ms: lagMs, behind } });
  });
  void onMeetingProgress((event) => {
    store.setState((state) => ({ progress: { ...state.progress, [event.meetingId]: event } }));
  });
  void onMeetingDownload((event) => {
    store.setState((state) => ({ downloads: { ...state.downloads, [event.item]: event } }));
    if (event.phase === "done" || event.phase === "failed" || event.phase === "cancelled") {
      void store.getState().refreshStatus();
      window.setTimeout(() => store.setState((state) => ({ downloads: { ...state.downloads, [event.item]: undefined } })), 1500);
    }
  });
  void onMeetingState(({ meetingId, noteId, status, error }) => {
    if (status === "deleted") {
      store.setState((state) => {
        const details = { ...state.details };
        delete details[meetingId];
        const list = (state.byNote[noteId] ?? []).filter((m) => m.id !== meetingId);
        const notesWith = new Set(state.notesWith);
        if (list.length === 0) notesWith.delete(noteId);
        return { details, byNote: { ...state.byNote, [noteId]: list }, notesWith };
      });
      void store.getState().refreshStatus();
      return;
    }
    void store.getState().refreshStatus();
    // A meeting this window has never seen — started in another one (an island of Notes) — over a
    // note whose list it already holds: the list is read again, or the note keeps showing the one
    // it read before the meeting existed until the app is restarted.
    const known = store.getState().byNote[noteId];
    if (known && !known.some((m) => m.id === meetingId)) {
      void store.getState().loadNote(noteId);
      store.setState((state) => (state.notesWith.has(noteId) ? {} : { notesWith: new Set([...state.notesWith, noteId]) }));
    } else if (store.getState().details[meetingId] || known) {
      // The detail is re-read when it is on screen (or about to be): a finished pass rewrites it.
      void store.getState().loadDetail(meetingId);
    }
    if (status === "ready" || status === "failed") {
      store.setState((state) => {
        const progress = { ...state.progress };
        delete progress[meetingId];
        return { progress };
      });
    }
    if (status === "ready" && isMainWindow()) {
      useToastStore.getState().pushToast(translate("meetings.readyToast"), "success");
    }
    if (status === "failed" && error && error !== "cancelled" && isMainWindow()) {
      pushErrorToast(translate("meetings.failedToast", { error }));
    }
  });
  if (isMainWindow()) {
    void onMeetingDetected(({ caller }) => {
      if (store.getState().status?.recording) return;
      store.setState({ suggestion: { name: caller.name } });
    });
  }
  void store.getState().refreshStatus();
  void store.getState().loadSettings();
}

watchSettings(Object.values(KEYS), () => void useMeetingsStore.getState().loadSettings());

useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  void useMeetingsStore.getState().loadNotesWith(state.activeWorkspaceId);
});
