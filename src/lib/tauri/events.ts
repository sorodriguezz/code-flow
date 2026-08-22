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

/** How a model download is going. One event carries every phase — see `localai::download::Phase`. */
export interface LocalAiDownloadEvent {
  model_id: string;
  phase: "downloading" | "verifying" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  /** Only on `failed`, and already a sentence a person can act on. */
  error?: string;
}

export const onLocalAiDownload = (handler: (event: LocalAiDownloadEvent) => void) =>
  listen<LocalAiDownloadEvent>("localai:download", (e) => handler(e.payload));

/** Every move the local completion engine makes: off → warming → ready, or a failure.
 *  Mirrors `localai::engine::Status`, which serializes with `#[serde(tag = "kind")]`. */
export type LocalAiEngineEvent =
  | { kind: "off" }
  | { kind: "starting"; model_id: string }
  | { kind: "ready"; model_id: string }
  | { kind: "failed"; message: string };

export const onLocalAiEngine = (handler: (event: LocalAiEngineEvent) => void) =>
  listen<LocalAiEngineEvent>("localai:engine", (e) => handler(e.payload));

export const onRepoFsChanged = (handler: (event: { repo_path: string }) => void) =>
  listen<{ repo_path: string }>("repo:fs-changed", (e) => handler(e.payload));

/**
 * The `origin` a change made in this window carries.
 *
 * Must match `DESKTOP_ORIGIN` in `src-tauri/src/remotectl/bridge.rs`. Each client skips the frames
 * whose origin is itself: the desktop skips this one, a phone skips its own device id. Without that
 * both ends act on their own echo — the phone refetching what it just drew, and this window
 * reloading a store over the write that is still settling into it.
 */
export const DESKTOP_ORIGIN = "desktop";

/** Which slice of in-memory state somebody else just made stale, and who made it so. */
export interface StateInvalidateEvent {
  /** Absent when the action changed nothing that any store holds — opening a terminal, say. The
   *  event still arrives, because `action` is worth announcing on its own.
   *
   *  `remote` is the odd one out and has no `Invalidate` variant behind it: it is not "your copy of
   *  something is stale", it is a *setting* being pushed to the phones on the channel they are
   *  already reading. This window ignores it — it changed the setting, so it has the answer. */
  domain?: "repo" | "chains" | "tasks" | "reviews" | "chat" | "remote";
  /** Who caused it: a remote device's id, or [`DESKTOP_ORIGIN`] for this window's own changes.
   *  Present so each client can ignore the echo of its own action. */
  origin?: string;
  /** What that device calls itself, for the notification centre. Absent for a desktop change —
   *  the person who made it is sitting in front of the window. */
  device?: string;
  /** A `remote.action.*` translation key naming what was done, when it is worth telling the user
   *  about. Absent for the many calls that are not — staging a file, a keystroke. */
  action?: string;
  /** Which project the call named, when it named one. Job history and chat transcripts are both
   *  stored per project, so the domain alone cannot say what to re-read. */
  project?: string;
  /** Which conversation a `chat` change belongs to. A project holds dozens, and the domain alone
   *  cannot say whether the transcript on screen is the one that moved. */
  conversation?: string;
  /** Which chain a `chains` change moved, and the workspace that chain belongs to.
   *
   *  Both, because this window is the thing that actually *advances* a chain — the executor is
   *  `chainStore.ts` — and it holds one workspace at a time. The id says what to advance; the
   *  workspace says whether reloading the list already in memory would even find it. A gate
   *  approved from a phone pointed at another workspace used to reload a list the chain is not in
   *  and then look for queued chains in it, so nothing ran and the plan sat there.
   *
   *  Absent on a `chains` frame from a client too old to send them, which the reader treats as
   *  "pump whatever is queued here" — the behaviour it had before they existed. */
  chain?: string;
  workspace?: string;
  /** The job id a review or an analysis filed its output under, so the notification it raises can
   *  open that result instead of only mentioning it. */
  job?: string;
  /** Present, and `"error"`, only when the action *failed* and still left something durable — a
   *  review or an analysis that errored writes its `job_history` row either way. Absent means the
   *  action succeeded, which is what every emitter used to imply by saying nothing. */
  status?: "error";
  /** The new value of the shell grant, on a `remote` frame. Pushed rather than left to be polled:
   *  a phone learns this once, at bootstrap, and re-probing for it is what used to unpair devices —
   *  see `remotectl_set_allow_terminal`. */
  allowTerminal?: boolean;
}

/**
 * A change this window did not make and could not otherwise find out about.
 *
 * It exists because two of the three ways state travels already worked and the third did not: a
 * phone that commits moves bytes on disk, so `repo:fs-changed` fires; a phone that cancels a run is
 * the same process, so `ai:output-batch` fires. But a phone that approves a chain gate writes SQLite
 * and touches nothing else — no watcher sees it, and the zustand copy of those rows would stay wrong
 * until the user navigated away and back.
 *
 * There are two emitters, and for a while there was only one. `remotectl/server.rs` raises it for
 * every mutating call a phone makes; `notifyStateChange` raises it for the same changes made *here*,
 * so a phone hears about them too. Anything that subscribes must therefore check [`DESKTOP_ORIGIN`]
 * before acting, or this window will reload its own stores on top of its own writes.
 *
 * The payload names a *domain* rather than carrying the new value, so the reload goes through the
 * same loader the view already uses. Sending the row itself would mean the backend knowing the
 * shape of every store, and would be wrong the moment two clients act at once.
 */
export const onStateInvalidate = (handler: (event: StateInvalidateEvent) => void) =>
  listen<StateInvalidateEvent>("state:invalidate", (e) => handler(e.payload));

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
  /** Stable provider id — `"claude"`, `"gemini"`, `"codex"`… What `ProviderGlyph` keys its brand
   *  mark off, and what `AI_PROVIDERS` is indexed by. Sent beside `engine` rather than instead of
   *  it: that one is the word a person reads and is allowed to be renamed. */
  provider: string;
  /** Display name of the engine — "Claude", "Codex", "Cline"… */
  engine: string;
  /** Model id forced for this run; empty when the CLI is picking its own default. */
  model: string;
}

/** Which engine and model a run is using, announced as it starts — so "working…" can say what is
 * doing the work rather than leaving the user to guess from the settings screen. */
export const onAiEngine = (handler: (event: AiEngineEvent) => void) =>
  listen<AiEngineEvent>("ai:engine", (e) => handler(e.payload));

/**
 * A run finishing, announced by the run itself.
 *
 * Redundant for anything this window started — its `invoke` promise resolving says the same thing,
 * earlier. It exists for the runs this window did *not* start: a chat turn or a review kicked off
 * from a paired phone reaches the same engine through the same code, but there is no promise here
 * to resolve, so without this the desktop would show an agent working and never stop.
 *
 * Emitted after the run's final output batch, so a listener can treat it as final.
 */
export const onAiDone = (handler: (event: { run_id: string }) => void) =>
  listen<{ run_id: string }>("ai:done", (e) => handler(e.payload));

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

/** A server's verdict on one file, pushed rather than asked for — which is why diagnostics are the
 *  one LSP feature that is an event and not a request. `uri` is a `file://` URI. */
export interface LspDiagnosticsEvent {
  session_id: string;
  uri: string;
  diagnostics: unknown[];
}

export const onLspDiagnostics = (handler: (event: LspDiagnosticsEvent) => void) =>
  listen<LspDiagnosticsEvent>("lsp:diagnostics", (e) => handler(e.payload));

/** Indexing. `rust-analyzer` spends its first minute here and answers nothing useful until it is
 *  done, so this is the difference between a status line and an editor that looks broken. */
export const onLspProgress = (handler: (event: { session_id: string; params: unknown }) => void) =>
  listen<{ session_id: string; params: unknown }>("lsp:progress", (e) => handler(e.payload));

/** The server's process ended — crashed, killed, or exited. Whatever was registered against it is
 *  now answering nothing. */
export const onLspExited = (handler: (event: { session_id: string }) => void) =>
  listen<{ session_id: string }>("lsp:exited", (e) => handler(e.payload));
