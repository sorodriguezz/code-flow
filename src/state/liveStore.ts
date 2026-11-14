import { create } from "zustand";
import type { LiveFile } from "../lib/collabLive/wire";

/**
 * What the live channel of each shared session shows (`lib/collabLive`): who is here and in which
 * file, the turns others are writing right now, and which files this window has open live. Written by
 * the channel, read by the chat bar, the transcript and the editor's auto-save.
 */

export interface LivePeer {
  nick: string;
  file: LiveFile | null;
  /** When they were last heard from (ms). */
  at: number;
}

export interface LiveTurn {
  nick: string;
  text: string;
  engine: string | null;
  done: boolean;
  at: number;
}

export interface LiveSessionState {
  connected: boolean;
  peers: Record<string, LivePeer>;
  /** By person id: the answer each one's engine is writing now. */
  turns: Record<string, LiveTurn>;
}

interface LiveState {
  sessions: Record<string, LiveSessionState>;
  /** By workspace project id: the paths open live in it (the session projects only). */
  openFiles: Record<string, string[]>;
  /** Bumped whenever a session project starts or stops being live, so editors re-check. */
  targets: number;
}

export const EMPTY_LIVE_SESSION: LiveSessionState = { connected: false, peers: {}, turns: {} };

export const useLiveStore = create<LiveState>(() => ({ sessions: {}, openFiles: {}, targets: 0 }));

export function patchLiveSession(sessionId: string, change: (current: LiveSessionState) => LiveSessionState): void {
  useLiveStore.setState((s) => ({ sessions: { ...s.sessions, [sessionId]: change(s.sessions[sessionId] ?? EMPTY_LIVE_SESSION) } }));
}

export function forgetLiveSession(sessionId: string): void {
  useLiveStore.setState((s) => {
    const { [sessionId]: _gone, ...rest } = s.sessions;
    return { sessions: rest, targets: s.targets + 1 };
  });
}

export function bumpLiveTargets(): void {
  useLiveStore.setState((s) => ({ targets: s.targets + 1 }));
}

export function setOpenLive(projectId: string, path: string, open: boolean): void {
  useLiveStore.setState((s) => {
    const current = s.openFiles[projectId] ?? [];
    const next = open ? (current.includes(path) ? current : [...current, path]) : current.filter((p) => p !== path);
    if (next === current) return s;
    return { openFiles: { ...s.openFiles, [projectId]: next } };
  });
}

/** A peer counts as here while heard from in the last `staleMs`. */
export function presentPeers(state: LiveSessionState | undefined, now = Date.now(), staleMs = 25_000): [string, LivePeer][] {
  return Object.entries(state?.peers ?? {}).filter(([, p]) => now - p.at < staleMs);
}
