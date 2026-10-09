import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { DictationModel } from "./dictationCommands";

/** `db::meeting_queries::MeetingRow`. */
export interface Meeting {
  id: string;
  workspaceId: string;
  noteId: string;
  /** `virtual` (microphone + the computer's audio) · `room` (microphone only) · `import`. */
  kind: "virtual" | "room" | "import";
  mode: MeetingMode;
  transcriber: "local" | "cloud";
  language: string;
  status: MeetingStatus;
  stage: string;
  error: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /** JSON array: `["mic","system"]`. */
  channels: string;
  audioFile: string;
  audioBytes: number;
  audioExpiresAt: string;
  speakersHint: number;
  liveComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export type MeetingMode = "light" | "balanced" | "full";
export type MeetingStatus = "recording" | "paused" | "queued" | "processing" | "ready" | "failed" | "interrupted";

/** `LineRow`: one line of the transcript. `speaker` is a key: `me`, `others`, `p0`, `p1`… */
export interface MeetingLine {
  seq: number;
  channel: "mic" | "system";
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
  pass: "live" | "final";
  edited: boolean;
}

/** `SpeakerRow`. */
export interface MeetingSpeaker {
  key: string;
  name: string;
  color: number;
  isMe: boolean;
  voiceId: string;
  talkMs: number;
  /** A voice can be saved from it. */
  hasVoice: boolean;
}

export interface MeetingDetail {
  meeting: Meeting;
  lines: MeetingLine[];
  speakers: MeetingSpeaker[];
  localOnly: boolean;
}

export interface MeetingRecipe {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Voice {
  id: string;
  name: string;
  isMe: boolean;
  samples: number;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/** `meetings_status`. */
export interface MeetingsStatus {
  supported: boolean;
  engineInstalled: boolean;
  vadInstalled: boolean;
  voicesInstalled: boolean;
  voicesSupported: boolean;
  voicesBytes: number;
  models: DictationModel[];
  recording: { meetingId: string; noteId: string; elapsedMs: number; paused: boolean; behind: boolean } | null;
  processing: string | null;
  queued: string[];
  cloudKey: boolean;
}

export interface MeetingBench {
  measuredAt: string;
  threads: number;
  perUtteranceMs: [string, number][];
  recommended: MeetingMode;
  liveModel: string;
}

/** What the engine is told about the meeting above its transcript. */
export interface MeetingFacts {
  title: string;
  date: string;
  duration: string;
  participants: string[];
  language: string;
}

export const MIC_DENIED = "MIC_DENIED";
export const SYSTEM_AUDIO_DENIED = "SYSTEM_AUDIO_DENIED";
export const NO_MODEL = "MEETINGS_NO_MODEL";
export const NO_CLOUD_KEY = "MEETINGS_NO_CLOUD_KEY";
export const LOCAL_UNAVAILABLE = "MEETINGS_LOCAL_UNAVAILABLE";

export const meetingsStatus = () => invoke<MeetingsStatus>("meetings_status");
export const meetingsInstall = (item: "vad" | "voices") => invoke<void>("meetings_install", { item });
export const meetingsCancelInstall = () => invoke<void>("meetings_cancel_install");
export const meetingsRemoveVoices = () => invoke<void>("meetings_remove_voices");
export const meetingsSetCloudKey = (key: string) => invoke<void>("meetings_set_cloud_key", { key });
export const meetingsTestCloud = () => invoke<void>("meetings_test_cloud");
export const meetingsBench = () => invoke<MeetingBench>("meetings_bench");
export const meetingsSystemAudioSettings = () => invoke<void>("meetings_system_audio_settings");

export const meetingsStart = (args: { noteId: string; workspaceId: string; kind: "virtual" | "room"; mode?: MeetingMode; language: string }) =>
  invoke<{ meeting: Meeting; warning: string | null; mode: MeetingMode }>("meetings_start", args);
export const meetingsPause = (meetingId: string, paused: boolean) => invoke<void>("meetings_pause", { meetingId, paused });
export const meetingsStop = (meetingId: string) => invoke<Meeting>("meetings_stop", { meetingId });
export const meetingsDiscard = (meetingId: string) => invoke<void>("meetings_discard", { meetingId });
export const meetingsDelete = (meetingId: string) => invoke<void>("meetings_delete", { meetingId });
export const meetingsCancelJob = (meetingId: string) => invoke<void>("meetings_cancel_job", { meetingId });
export const meetingsReprocess = (meetingId: string, retranscribe: boolean, speakers: number, cloud?: boolean) =>
  invoke<void>("meetings_reprocess", { meetingId, retranscribe, speakers, cloud });
export const meetingsImport = (noteId: string, workspaceId: string, path: string, language: string) =>
  invoke<Meeting>("meetings_import", { noteId, workspaceId, path, language });

export const meetingsForNote = (noteId: string) => invoke<Meeting[]>("meetings_for_note", { noteId });
export const meetingsNotesWith = (workspaceId: string) => invoke<string[]>("meetings_notes_with", { workspaceId });
export const meetingsDetail = (meetingId: string) => invoke<MeetingDetail>("meetings_detail", { meetingId });
export const meetingsAudio = (meetingId: string) => invoke<ArrayBuffer>("meetings_audio", { meetingId });
export const meetingsPeaks = (meetingId: string) => invoke<Record<string, number[]>>("meetings_peaks", { meetingId });
export const meetingsExportAudio = (meetingId: string, path: string) => invoke<void>("meetings_export_audio", { meetingId, path });

export const meetingsUpdateLine = (meetingId: string, seq: number, text: string) => invoke<void>("meetings_update_line", { meetingId, seq, text });
export const meetingsSetLineSpeaker = (meetingId: string, seq: number, speaker: string) =>
  invoke<void>("meetings_set_line_speaker", { meetingId, seq, speaker });
export const meetingsRenameSpeaker = (meetingId: string, key: string, name: string) => invoke<void>("meetings_rename_speaker", { meetingId, key, name });
export const meetingsMergeSpeakers = (meetingId: string, from: string, into: string) => invoke<void>("meetings_merge_speakers", { meetingId, from, into });
export const meetingsAddSpeaker = (meetingId: string) => invoke<string>("meetings_add_speaker", { meetingId });
export const meetingsSetBookLocalOnly = (bookId: string, localOnly: boolean) => invoke<void>("meetings_set_book_local_only", { bookId, localOnly });

export const meetingsVoices = () => invoke<Voice[]>("meetings_voices");
export const meetingsSaveVoice = (args: { meetingId: string; key: string; name: string; isMe: boolean; voiceId?: string }) =>
  invoke<Voice>("meetings_save_voice", args);
export const meetingsRenameVoice = (voiceId: string, name: string) => invoke<void>("meetings_rename_voice", { voiceId, name });
export const meetingsDeleteVoice = (voiceId: string) => invoke<void>("meetings_delete_voice", { voiceId });

export const meetingsRecipes = (workspaceId: string) => invoke<MeetingRecipe[]>("meetings_recipes", { workspaceId });
export const meetingsSaveRecipe = (workspaceId: string, id: string | null, name: string, prompt: string) =>
  invoke<MeetingRecipe>("meetings_save_recipe", { workspaceId, id, name, prompt });
export const meetingsDeleteRecipe = (id: string) => invoke<void>("meetings_delete_recipe", { id });

export const meetingsAi = (request: {
  meetingId: string;
  recipe?: string;
  instruction?: string;
  question: boolean;
  facts: MeetingFacts;
  names: Record<string, string>;
  runId?: string;
  workspaceId?: string;
}) => invoke<{ markdown: string; engine: string }>("meetings_ai", { request });

// ---- events -------------------------------------------------------------------------------

export interface LevelEvent {
  meetingId: string;
  channel: "mic" | "system";
  level: number;
}
export interface LineEvent {
  meetingId: string;
  line: MeetingLine;
}
export interface StateEvent {
  meetingId: string;
  noteId: string;
  status: MeetingStatus | "deleted";
  stage: string;
  error: string;
}
export interface ProgressEvent {
  meetingId: string;
  stage: "detect" | "transcribe" | "voices" | "finish" | "decode" | "compress";
  fraction: number;
}
export interface LagEvent {
  meetingId: string;
  lagMs: number;
  behind: boolean;
}
export interface DownloadEvent {
  item: "vad" | "voices";
  phase: "downloading" | "unpacking" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  error?: string;
}
export interface DetectedEvent {
  caller: { id: string; name: string };
}

export const onMeetingLevel = (f: (e: LevelEvent) => void): Promise<UnlistenFn> => listen<LevelEvent>("meetings:level", (e) => f(e.payload));
export const onMeetingLine = (f: (e: LineEvent) => void): Promise<UnlistenFn> => listen<LineEvent>("meetings:line", (e) => f(e.payload));
export const onMeetingState = (f: (e: StateEvent) => void): Promise<UnlistenFn> => listen<StateEvent>("meetings:state", (e) => f(e.payload));
export const onMeetingProgress = (f: (e: ProgressEvent) => void): Promise<UnlistenFn> => listen<ProgressEvent>("meetings:progress", (e) => f(e.payload));
export const onMeetingLag = (f: (e: LagEvent) => void): Promise<UnlistenFn> => listen<LagEvent>("meetings:lag", (e) => f(e.payload));
export const onMeetingDownload = (f: (e: DownloadEvent) => void): Promise<UnlistenFn> => listen<DownloadEvent>("meetings:download", (e) => f(e.payload));
export const onMeetingDetected = (f: (e: DetectedEvent) => void): Promise<UnlistenFn> => listen<DetectedEvent>("meetings:detected", (e) => f(e.payload));
