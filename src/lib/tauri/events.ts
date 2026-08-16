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

/** How far along a file transfer is. `total` covers the *whole* transfer, not the current file —
 *  a folder of two hundred files gets one bar that fills once. */
export interface RemoteTransferEvent {
  id: string;
  name: string;
  done: number;
  total: number;
  file_index: number;
  files: number;
}

export const onRemoteTransfer = (handler: (event: RemoteTransferEvent) => void) =>
  listen<RemoteTransferEvent>("remote:transfer", (e) => handler(e.payload));

export const onRepoFsChanged = (handler: (event: { repo_path: string }) => void) =>
  listen<{ repo_path: string }>("repo:fs-changed", (e) => handler(e.payload));

export const onSkillsProgress = (handler: (event: { line: string }) => void) =>
  listen<{ line: string }>("skills:progress", (e) => handler(e.payload));

/**
 * The window coming back on screen after the close button put it in the background.
 *
 * Not the same event as the DOM's `focus`, and neither one covers the other. `focus` is alt-tab:
 * it fires often and says the webview is in front. This one is the tray restore, where the webview
 * never lost focus in the first place and so has none to regain — the emit in `tray.rs` is the
 * only signal that the app is on screen again. Anything that should happen "when the user comes
 * back" wants both.
 */
export const onAppForeground = (handler: () => void) => listen("app:foreground", () => handler());

/**
 * A backup starting and finishing, whether it was the button or the scheduler that started it.
 *
 * The settings panel follows this for two things at once: a "Back up now" it must not let you press
 * twice, and a scheduled run that would otherwise write a new timestamp underneath an open panel
 * still showing the old one. `false` is the cue to re-read the state, not just to re-enable.
 */
export const onBackupRunning = (handler: (running: boolean) => void) =>
  listen<boolean>("backup:running", (e) => handler(e.payload));

export interface AiOutputEvent {
  run_id: string;
  stream: "stdout" | "stderr";
  line: string;
}

/** One line of a running AI process's output, as it happens.
 *
 * Superseded by `onAiOutputBatch` for anything that renders the stream — see there for why. Kept
 * for callers that genuinely want a per-line callback. */
export const onAiOutput = (handler: (event: AiOutputEvent) => void) =>
  listen<AiOutputEvent>("ai:output", (e) => handler(e.payload));

export interface AiOutputBatchEvent {
  run_id: string;
  lines: { stream: "stdout" | "stderr"; line: string }[];
}

/** The same output as `onAiOutput`, coalesced into ~100 ms batches.
 *
 * An agentic turn with `--output-format stream-json --verbose` emits 20-60 lines a second, and a
 * per-line subscription turns each one into an IPC message, a store write and a render. The batch
 * carries the identical lines in the identical order — the backend flushes any partial batch before
 * the run's completion event, so nothing can be lost or arrive out of order — but costs one render
 * per frame-ish instead of one per line. 100 ms is deliberately short enough to still read as live.
 */
export const onAiOutputBatch = (handler: (event: AiOutputBatchEvent) => void) =>
  listen<AiOutputBatchEvent>("ai:output-batch", (e) => handler(e.payload));

export interface AiEngineEvent {
  run_id: string;
  /** Display name of the engine — "Claude", "Codex", "Cline"… */
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
