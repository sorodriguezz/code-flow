import { listen } from "@tauri-apps/api/event";
import type { GitDoneEvent, GitProgressEvent } from "../../types/domain";
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
