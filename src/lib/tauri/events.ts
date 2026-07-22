import { listen } from "@tauri-apps/api/event";
import type { GitDoneEvent, GitProgressEvent } from "../../types/domain";

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
