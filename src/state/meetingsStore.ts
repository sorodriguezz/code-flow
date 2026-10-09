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
  meetingsSystemAudioSettings,
  MIC_DENIED,
  NO_CLOUD_KEY,
  NO_MODEL,
  onMeetingDetected,
  onMeetingDownload,
  onMeetingLag,
  onMeetingLevel,
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
};

/** How many levels each channel keeps for the waveform. */
const LEVELS = 120;

interface MeetingsState {
  status: MeetingsStatus | null;
  settings: MeetingSettings;
  /** The recording's levels, newest last. */
  levels: { mic: number[]; system: number[] };
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
  stop: (meetingId: string) => Promise<void>;
  discard: (meetingId: string) => Promise<void>;
  remove: (meetingId: string) => Promise<void>;
  reprocess: (meetingId: string, retranscribe: boolean, speakers: number, cloud?: boolean) => Promise<void>;
  importFile: (noteId: string, workspaceId: string, path: string, language: string) => Promise<void>;
  install: (item: "vad" | "voices") => Promise<void>;
  cancelInstall: () => Promise<void>;
  dismissSuggestion: () => void;
  toggleCollapsed: (noteId: string) => void;
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
  lag: null,
  byNote: {},
  details: {},
  progress: {},
  downloads: {},
  notesWith: new Set(),
  notesWithWorkspace: null,
  suggestion: null,
  collapsed: {},
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

  stop: async (meetingId) => {
    try {
      const meeting = await meetingsStop(meetingId);
      set((state) => ({ byNote: withMeeting(state.byNote, meeting), levels: { mic: [], system: [] }, lag: null }));
      await get().refreshStatus();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  discard: async (meetingId) => {
    try {
      await meetingsDiscard(meetingId);
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

  setStartOpen: (noteId) => set({ startOpenFor: noteId }),

  setAi: (meetingId, run) =>
    set((state) => {
      const ai = { ...state.ai };
      if (run) ai[meetingId] = run;
      else delete ai[meetingId];
      return { ai };
    }),
}));

let listening = false;

/** Attaches the event listeners once per window. */
export function ensureMeetingEvents() {
  if (listening) return;
  listening = true;
  const store = useMeetingsStore;
  void onMeetingLevel(({ meetingId, channel, level }) => {
    if (store.getState().status?.recording?.meetingId !== meetingId) return;
    store.setState((state) => {
      const list = [...state.levels[channel], level];
      if (list.length > LEVELS) list.splice(0, list.length - LEVELS);
      return { levels: { ...state.levels, [channel]: list } };
    });
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
    // The detail is re-read when it is on screen (or about to be): a finished pass rewrites it.
    if (store.getState().details[meetingId] || store.getState().byNote[noteId]) void store.getState().loadDetail(meetingId);
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
