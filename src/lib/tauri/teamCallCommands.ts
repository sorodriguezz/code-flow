import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "./invoke";
import type { AgentVoice } from "../../types/domain";

/** `team::call::Line`: one thing said, or noted, in a call. */
export interface CallLine {
  id: string;
  /** Milliseconds into the call. */
  atMs: number;
  /** `user`, a member's id, or `call` for a note of the call's own. */
  who: string;
  name: string;
  text: string;
  /** Still being said: the same `id` comes again with more. */
  partial: boolean;
  kind: "say" | "note";
}

export type SeatState = "listening" | "thinking" | "speaking" | "looking" | "hand";

/** `team::call::SeatView`. */
export interface CallSeat {
  memberId: string;
  agentId: string;
  name: string;
  role: string;
  icon: string;
  color: string;
  lead: boolean;
  state: SeatState;
  /** What it is looking at in the code, while it is. */
  note: string;
  /** Its place among those waiting for the word, from 1 — whoever finished first is first; 0
   *  when it is not waiting. */
  hand: number;
  voice: AgentVoice;
  voiceLabel: string;
  /** Whose engine it answers with (`claude`, `codex`…). */
  provider: string;
  /** The model it talks with in the call: its provider's fast one, or its own where there is none. */
  model: string;
  /** The model it looks at the code and works with. */
  ownModel: string;
  /** The account it runs as, by its name; `""` is the provider's own login. */
  account: string;
}

export interface CallTask {
  title: string;
  detail: string;
  member: string;
  memberName: string;
}

/** `team::call::wrap::WrapUp`: a call's minutes. */
export interface CallWrapUp {
  title: string;
  summary: string;
  decisions: string[];
  tasks: CallTask[];
  open: string[];
  closing: string;
}

export type CallPhase = "live" | "closing" | "countdown" | "starting" | "started" | "ended";
export type CallListening = "ready" | "missing" | "denied" | "unsupported" | "failed";

/** `team::call::CallState`. */
export interface CallState {
  id: string;
  chatId: string;
  teamId: string;
  teamName: string;
  workspaceId: string;
  lang: "es" | "en";
  phase: CallPhase;
  /** Milliseconds since the epoch. */
  startedAtMs: number;
  seats: CallSeat[];
  mic: boolean;
  /** The user is speaking now. */
  hearing: boolean;
  listening: CallListening;
  /** What has to be downloaded before the microphone can open: `library`, `detector`, `listener`. */
  missing: string[];
  headphones: boolean;
  /** Which model agents talk with when none was chosen for one: their provider's fast one, or their own. */
  talk: "fast" | "own";
  wrap: CallWrapUp | null;
  countdownEndsMs: number | null;
  runId: string | null;
  error: string;
  /** Everything said so far — only on what a command returns; the events carry none. */
  lines: CallLine[];
}

/** `team::call::cast::PoolVoice`: a voice an agent can be given. */
export interface PoolVoice {
  id: string;
  label: string;
  /** `pocket`: a voice of the calls' own engine (`speech::pocket`). */
  kind: "pocket" | "local" | "clone" | "system" | "cloud";
  lang: "es" | "en" | "multi";
}

export const teamCallStart = (teamId: string, projectId: string | null) => invoke<CallState>("team_call_start", { teamId, projectId });
/** The id of the model a call would listen with now: the one chosen for calls, or the recommended one. */
export const teamCallListening = () => invoke<string | null>("team_call_listening");
export const teamCallState = () => invoke<CallState | null>("team_call_state");
export const teamCallSay = (text: string) => invoke<void>("team_call_say", { text });
export const teamCallMic = (on: boolean) => invoke<CallState>("team_call_mic", { on });
/** Another microphone was chosen: the call listens with it from now on. */
export const teamCallMicChanged = () => invoke<CallState>("team_call_mic_changed");
export const teamCallHeadphones = (on: boolean) => invoke<void>("team_call_headphones", { on });
/** Which model the agents talk with when none was chosen for one. The call as it is after, if one is on. */
export const teamCallTalk = (mode: "fast" | "own") => invoke<CallState | null>("team_call_talk", { mode });
export const teamCallInterrupt = () => invoke<void>("team_call_interrupt");
/** Gives the word to a participant with its hand up: it says what it was waiting to say. */
export const teamCallGrant = (memberId: string) => invoke<void>("team_call_grant", { memberId });
/** Lowers a participant's hand: what it was waiting to say is not wanted. */
export const teamCallLower = (memberId: string) => invoke<void>("team_call_lower", { memberId });
export const teamCallHangUp = () => invoke<void>("team_call_hang_up");
export const teamCallStartNow = () => invoke<void>("team_call_start_now");
export const teamCallCancelStart = () => invoke<void>("team_call_cancel_start");
export const teamCallClose = () => invoke<void>("team_call_close");
export const teamCallVoices = () => invoke<PoolVoice[]>("team_call_voices");
/** The calls' voice engine: one model on this computer and a voice of its own for every agent. */
export interface PocketStatus {
  installed: boolean;
  /** What it holds on disk now. */
  bytes: number;
  /** What installing it brings down. */
  estimateBytes: number;
  voices: number;
  licence: string;
}
export const speechPocketStatus = () => invoke<PocketStatus>("speech_pocket_status");
/** Installs it; its progress arrives through {@link onPocketInstall}. Minutes. */
export const speechPocketInstall = () => invoke<void>("speech_pocket_install");
export const speechPocketRemove = () => invoke<void>("speech_pocket_remove");
export const onPocketInstall = (handler: (event: { state: "running" | "done" | "failed"; line: string | null }) => void) =>
  listen<{ state: "running" | "done" | "failed"; line: string | null }>("voice:pocket", (event) => handler(event.payload));

/** The voices a call would hand out now: the app's language, from where Settings says. */
export const teamCallPool = () => invoke<PoolVoice[]>("team_call_pool");
/** «Probar» on a voice chosen for an agent. */
export const speechTryVoice = (text: string, voice: AgentVoice, lang: string) => invoke<number>("speech_try_voice", { text, voice, lang });

export const onCallState = (handler: (state: CallState) => void): Promise<UnlistenFn> => listen<CallState>("team-call:state", (event) => handler(event.payload));
export const onCallLine = (handler: (line: CallLine) => void): Promise<UnlistenFn> => listen<CallLine>("team-call:line", (event) => handler(event.payload));
export const onCallLevel = (handler: (level: number) => void): Promise<UnlistenFn> => listen<number>("team-call:level", (event) => handler(event.payload));
