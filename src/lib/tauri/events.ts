import { listen } from "@tauri-apps/api/event";
import type { GitDoneEvent, GitProgressEvent } from "../../types/domain";
import type {
  StreamMessage as ApiStreamMessage,
  StreamStatusEvent as ApiStreamStatusEvent,
} from "../../types/api";
import type { StackFrame } from "./commands";

export const onGitProgress = (handler: (event: GitProgressEvent) => void) =>
  listen<GitProgressEvent>("git:progress", (e) => handler(e.payload));

export const onGitDone = (handler: (event: GitDoneEvent) => void) =>
  listen<GitDoneEvent>("git:done", (e) => handler(e.payload));

export interface TerminalOutputEvent {
  id: string;
  data: string;
}

export const onTerminalOutput = (handler: (event: TerminalOutputEvent) => void) =>
  listen<TerminalOutputEvent>("terminal:output", (e) => handler(e.payload));

export const onTerminalExit = (handler: (event: { id: string }) => void) =>
  listen<{ id: string }>("terminal:exit", (e) => handler(e.payload));

export const onRepoFsChanged = (handler: (event: { repo_path: string }) => void) =>
  listen<{ repo_path: string }>("repo:fs-changed", (e) => handler(e.payload));

export const onSkillsProgress = (handler: (event: { line: string }) => void) =>
  listen<{ line: string }>("skills:progress", (e) => handler(e.payload));

export interface AiOutputEvent {
  run_id: string;
  stream: "stdout" | "stderr";
  line: string;
}

/** One line of a running AI process's output, as it happens. */
export const onAiOutput = (handler: (event: AiOutputEvent) => void) =>
  listen<AiOutputEvent>("ai:output", (e) => handler(e.payload));

export interface AiEngineEvent {
  run_id: string;
  /** Display name of the engine — "Claude", "Codex", "Ollama"… */
  engine: string;
  /** Model id forced for this run; empty when the CLI is picking its own default. */
  model: string;
}

/** Which engine and model a run is using, announced as it starts — so "working…" can say what is
 * doing the work rather than leaving the user to guess from the settings screen. */
export const onAiEngine = (handler: (event: AiEngineEvent) => void) =>
  listen<AiEngineEvent>("ai:engine", (e) => handler(e.payload));

export interface DebugPausedEvent {
  /** `breakpoint`, `step`, `exception`… */
  reason: string;
  frames: StackFrame[];
}

/** The program stopped: at a breakpoint, after a step, or on an exception. */
export const onDebugPaused = (handler: (event: DebugPausedEvent) => void) =>
  listen<DebugPausedEvent>("debug:paused", (e) => handler(e.payload));

export const onDebugResumed = (handler: () => void) => listen("debug:resumed", () => handler());

/** A line the debugged program printed, or a `console.*` call it made. */
export const onDebugOutput = (handler: (event: { kind: string; text: string }) => void) =>
  listen<{ kind: string; text: string }>("debug:output", (e) => handler(e.payload));

export const onDebugTerminated = (handler: () => void) => listen("debug:terminated", () => handler());

/** One frame of a live WebSocket/Socket.IO/MQTT connection. Routed by `connection_id`, not by
 * tab: the transport has no idea which tab opened the socket. */
export const onApiStreamMessage = (handler: (event: ApiStreamMessage) => void) =>
  listen<ApiStreamMessage>("api:stream-message", (e) => handler(e.payload));

export const onApiStreamStatus = (handler: (event: ApiStreamStatusEvent) => void) =>
  listen<ApiStreamStatusEvent>("api:stream-status", (e) => handler(e.payload));
