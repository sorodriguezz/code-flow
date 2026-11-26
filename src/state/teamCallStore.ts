/**
 * A call with a team, as this window sees it. The call itself lives in the backend
 * (`team::call`): the microphone, who has the word and how it ends go on whatever this window
 * shows. Here are its state, what was said, and the window it is drawn in — floating over the
 * view on screen, folded to the shelf when it is in the way.
 */
import { create } from "zustand";
import type { Rect } from "../lib/floatingRect";
import {
  onCallLevel,
  onCallLine,
  onCallState,
  teamCallCancelStart,
  teamCallClose,
  teamCallHangUp,
  teamCallHeadphones,
  teamCallInterrupt,
  teamCallMic,
  teamCallMicChanged,
  teamCallSay,
  teamCallStart,
  teamCallStartNow,
  teamCallTalk,
  teamCallState,
  type CallLine,
  type CallState,
} from "../lib/tauri/teamCallCommands";
import { codiPrepare } from "../lib/tauri/codiCommands";
import { useDictationStore } from "./dictationStore";
import { translate } from "./languageStore";
import { followTarget, notify } from "./notificationStore";
import { pushErrorToast, useToastStore } from "./toastStore";

const FRAME_KEY = "cf.crew.teamCallWindow";

interface Frame {
  rect: Rect | null;
  maximized: boolean;
  /** The transcript under the participants. */
  captions: boolean;
}

function readFrame(): Frame {
  try {
    const raw = JSON.parse(localStorage.getItem(FRAME_KEY) ?? "null") as Partial<Frame> | null;
    const r = raw?.rect;
    const whole = r && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n));
    return { rect: whole ? { x: r.x, y: r.y, w: r.w, h: r.h } : null, maximized: raw?.maximized === true, captions: raw?.captions !== false };
  } catch {
    return { rect: null, maximized: false, captions: true };
  }
}

function writeFrame(frame: Frame): void {
  try {
    localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  } catch {
    /* private window, blocked storage */
  }
}

/** A call that still holds the speaker or the microphone, or is about to hand over work. */
export const callOngoing = (call: CallState | null | undefined): boolean =>
  !!call && (call.phase === "live" || call.phase === "closing" || call.phase === "countdown" || call.phase === "starting");

interface TeamCallStore extends Frame {
  call: CallState | null;
  lines: CallLine[];
  minimized: boolean;
  /** A call is being set up: its button waits. */
  starting: boolean;
  /** What the microphone needs is being downloaded. */
  preparing: boolean;
  start: (teamId: string, projectId: string | null) => Promise<void>;
  /** Reads a call that is going on — after a reload, or in a window opened late. */
  resume: () => Promise<void>;
  say: (text: string) => void;
  mic: (on: boolean) => Promise<void>;
  /** Listens with another microphone — the app's one choice, the same as in Settings. */
  micDevice: (device: string) => Promise<void>;
  headphones: (on: boolean) => void;
  /** Which model the agents talk with when none was chosen for one. */
  talk: (mode: "fast" | "own") => Promise<void>;
  interrupt: () => void;
  hangUp: () => void;
  startNow: () => void;
  cancelStart: () => void;
  /** Lets go of a call that is over, and of its window. */
  close: () => Promise<void>;
  /** Downloads what listening needs and opens the microphone. */
  prepare: () => Promise<void>;
  minimize: () => void;
  restore: () => void;
  place: (rect: Rect) => void;
  toggleMaximized: () => void;
  toggleCaptions: () => void;
}

const failed = (error: unknown) => pushErrorToast(String(error));

export const useTeamCallStore = create<TeamCallStore>((set, get) => {
  const keep = () => writeFrame({ rect: get().rect, maximized: get().maximized, captions: get().captions });
  return {
    call: null,
    lines: [],
    minimized: false,
    starting: false,
    preparing: false,
    ...(typeof window === "undefined" ? { rect: null, maximized: false, captions: true } : readFrame()),

    start: async (teamId, projectId) => {
      const current = get().call;
      if (callOngoing(current)) {
        // One call at a time: the button of a call that is going on brings it back.
        set({ minimized: false });
        if (current?.teamId !== teamId) pushErrorToast(translate("teamCall.busy", { team: current?.teamName ?? "" }));
        return;
      }
      if (get().starting) return;
      set({ starting: true });
      try {
        // A call that ended and was left on screen gives way to the new one.
        if (current) await teamCallClose().catch(() => undefined);
        const call = await teamCallStart(teamId, projectId);
        set({ call: { ...call, lines: [] }, lines: call.lines, minimized: false });
      } catch (error) {
        failed(error);
      } finally {
        set({ starting: false });
      }
    },

    resume: async () => {
      const call = await teamCallState().catch(() => null);
      if (call) set({ call: { ...call, lines: [] }, lines: call.lines });
    },

    say: (text) => void teamCallSay(text).catch(failed),
    mic: async (on) => {
      try {
        const call = await teamCallMic(on);
        set((s) => ({ call: s.call ? { ...call, lines: [] } : s.call }));
      } catch (error) {
        failed(error);
      }
    },
    micDevice: async (device) => {
      try {
        // Saved first: the call opens whichever microphone the setting names.
        await useDictationStore.getState().setDevice(device);
        const call = await teamCallMicChanged();
        set((s) => ({ call: s.call ? { ...call, lines: [] } : s.call }));
      } catch (error) {
        failed(error);
      }
    },
    headphones: (on) => {
      set((s) => ({ call: s.call ? { ...s.call, headphones: on } : s.call }));
      void teamCallHeadphones(on).catch(failed);
    },
    talk: async (mode) => {
      try {
        const call = await teamCallTalk(mode);
        if (call) set((s) => ({ call: s.call ? { ...call, lines: [] } : s.call }));
      } catch (error) {
        failed(error);
      }
    },
    interrupt: () => void teamCallInterrupt().catch(failed),
    hangUp: () => void teamCallHangUp().catch(failed),
    startNow: () => void teamCallStartNow().catch(failed),
    cancelStart: () => void teamCallCancelStart().catch(failed),

    close: async () => {
      set({ call: null, lines: [], minimized: false });
      await teamCallClose().catch(failed);
    },

    prepare: async () => {
      if (get().preparing) return;
      set({ preparing: true });
      try {
        await codiPrepare();
        await get().mic(true);
      } catch (error) {
        failed(error);
      } finally {
        set({ preparing: false });
      }
    },

    minimize: () => set({ minimized: true }),
    restore: () => set({ minimized: false }),
    place: (rect) => {
      set({ rect });
      keep();
    },
    toggleMaximized: () => {
      set((s) => ({ maximized: !s.maximized }));
      keep();
    },
    toggleCaptions: () => {
      set((s) => ({ captions: !s.captions }));
      keep();
    },
  };
});

/** How loud the microphone hears the user right now, 0–1: what their bars move by. Not state — it
 *  changes twenty-five times a second, and only the bars read it. */
let level = { value: 0, at: 0 };
export function callMicLevel(now: number = performance.now()): number {
  // No reading for a while is silence: the microphone closed, or muted.
  return now - level.at > 300 ? 0 : level.value;
}

/** The elements that are drawing the call, so its end is announced only to somebody not looking. */
const shown = new Set<HTMLElement>();
export function showingTeamCall(element: HTMLElement): () => void {
  shown.add(element);
  return () => void shown.delete(element);
}
function onScreen(): boolean {
  if (typeof document === "undefined" || document.hidden) return false;
  for (const element of shown) if (element.isConnected && element.getClientRects().length > 0) return true;
  return false;
}

/** The team started on what the call agreed. Seen happening, the room says it; otherwise the bell
 *  keeps it and a toast says it where the user is. */
function announceStart(call: CallState): void {
  if (!call.runId || onScreen()) return;
  const target = { view: "agents" as const, select: { kind: "teamRun" as const, id: call.runId } };
  notify({ source: "agents", titleKey: "notifications.teamCallStarted", params: { team: call.teamName }, workspaceId: call.workspaceId, target, status: "success", detail: call.wrap?.title || undefined });
  useToastStore.getState().pushToast(translate("notifications.teamCallStarted", { team: call.teamName }), "success", {
    action: { label: translate("notifications.openTeamRun"), run: () => void followTarget(call.workspaceId, target) },
    lifetimeMs: 12_000,
  });
}

/** Takes a state the backend sent. Exported for the tests: the events only call it. */
export function acceptCallState(next: CallState): void {
  const previous = useTeamCallStore.getState().call;
  // A call nobody here started — begun in another window — is not drawn over this one's.
  if (!previous || previous.id !== next.id) return;
  useTeamCallStore.setState({ call: { ...next, lines: [] } });
  if (previous.phase !== "started" && next.phase === "started") announceStart(next);
}

export function acceptCallLine(line: CallLine): void {
  useTeamCallStore.setState((s) => {
    if (!s.call) return s;
    const at = s.lines.findIndex((old) => old.id === line.id);
    if (at === -1) return { lines: [...s.lines, line] };
    const lines = [...s.lines];
    lines[at] = line;
    return { lines };
  });
}

if (typeof window !== "undefined") {
  void onCallState(acceptCallState);
  void onCallLine(acceptCallLine);
  void onCallLevel((value) => {
    level = { value: Math.min(1, Math.max(0, value)), at: performance.now() };
  });
  void useTeamCallStore.getState().resume();
}
