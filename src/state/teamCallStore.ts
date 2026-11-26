/**
 * A call with a team, as this window sees it. The call itself lives in the backend
 * (`team::call`): the microphone, who has the word and how it ends go on whatever any window
 * shows. Here are its state and what was said.
 *
 * It is drawn in a window of the system's of its own (`lib/floats`, key `call`), which reads the
 * same state from the backend. **The main window holds whether that window is shown or folded** to
 * the chip on its shelf, opens it and closes it; the call's own window asks it to (`FloatAction`).
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { encodeFloatRef, FLOAT, parseFloatRef } from "../lib/floats";
import { floatClose, floatHide, floatList, floatOpen, type SatelliteInfo } from "../lib/tauri/windows";
import { broadcast, onWindowMessage } from "../lib/windowBus";
import { isMainWindow, MAIN_LABEL } from "../lib/windowIdentity";
import {
  onCallLevel,
  onCallLine,
  onCallState,
  teamCallCancelStart,
  teamCallClose,
  teamCallGrant,
  teamCallHangUp,
  teamCallHeadphones,
  teamCallInterrupt,
  teamCallLower,
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
import { askMain } from "./teamChatWindowStore";
import { pushErrorToast, useToastStore } from "./toastStore";

const FRAME_KEY = "cf.crew.teamCallWindow";
const MAIN = isMainWindow();
/** The call's floating window: there is one. */
const CALL_KEY = "call";

interface Frame {
  /** The transcript under the participants. */
  captions: boolean;
}

function readFrame(): Frame {
  try {
    const raw = JSON.parse(localStorage.getItem(FRAME_KEY) ?? "null") as Partial<Frame> | null;
    return { captions: raw?.captions !== false };
  } catch {
    return { captions: true };
  }
}

/** Puts the call's window on screen. */
function showWindow(call: CallState): void {
  const ref = encodeFloatRef({ key: CALL_KEY, kind: "call", chatId: call.id, workspaceId: call.workspaceId, owner: call.teamId });
  void floatOpen(CALL_KEY, ref, call.teamName, call.workspaceId || null).catch(() => {});
  broadcast({ kind: "float-state", key: CALL_KEY, minimized: false, chatId: null });
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
  /** Gives the word to a participant with its hand up. */
  grant: (memberId: string) => void;
  /** Lowers a participant's hand: what it had to say is not wanted. */
  lower: (memberId: string) => void;
  startNow: () => void;
  cancelStart: () => void;
  /** Lets go of a call that is over, and of its window. */
  close: () => Promise<void>;
  /** Downloads what listening needs and opens the microphone. */
  prepare: () => Promise<void>;
  minimize: () => void;
  restore: () => void;
  toggleCaptions: () => void;
}

const failed = (error: unknown) => pushErrorToast(String(error));

export const useTeamCallStore = create<TeamCallStore>((set, get) => {
  const keep = () => writeFrame({ captions: get().captions });
  return {
    call: null,
    lines: [],
    minimized: false,
    starting: false,
    preparing: false,
    ...(typeof window === "undefined" ? { captions: true } : readFrame()),

    start: async (teamId, projectId) => {
      // The main window starts it: it is the one that opens the call's window and keeps its chip.
      if (!MAIN) return askMain({ do: "call-start", teamId, projectId });
      const current = get().call;
      if (callOngoing(current)) {
        // One call at a time: the button of a call that is going on brings it back.
        get().restore();
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
        showWindow(call);
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
    grant: (memberId) => void teamCallGrant(memberId).catch(failed),
    lower: (memberId) => void teamCallLower(memberId).catch(failed),
    startNow: () => void teamCallStartNow().catch(failed),
    cancelStart: () => void teamCallCancelStart().catch(failed),

    close: async () => {
      if (!MAIN) return askMain({ do: "call-close" });
      set({ call: null, lines: [], minimized: false });
      void floatClose(CALL_KEY).catch(() => {});
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

    minimize: () => {
      if (!MAIN) return askMain({ do: "call-minimize" });
      set({ minimized: true });
      void floatHide(CALL_KEY).catch(() => {});
      broadcast({ kind: "float-state", key: CALL_KEY, minimized: true, chatId: null });
    },
    restore: () => {
      if (!MAIN) return askMain({ do: "call-restore" });
      set({ minimized: false });
      const call = get().call;
      if (call) showWindow(call);
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

/** The team started on what the call agreed. Seen happening — the call's window is open — the room
 *  says it; folded away, the bell keeps it and a toast says it where the user is. Said by the main
 *  window alone, which is where the bell and the user's other work are. */
function announceStart(call: CallState): void {
  if (!MAIN || !call.runId || !useTeamCallStore.getState().minimized) return;
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
  if (MAIN) {
    onWindowMessage((message) => {
      if (message.kind !== "float" || message.to !== MAIN_LABEL) return;
      const store = useTeamCallStore.getState();
      const { action } = message;
      if (action.do === "call-start") void store.start(action.teamId, action.projectId);
      else if (action.do === "call-minimize") store.minimize();
      else if (action.do === "call-restore") store.restore();
      else if (action.do === "call-close") void store.close();
    });
    // The call's window, as the system has it. One that is there and hidden — after a reload of
    // this window — is a call folded to its chip; one that went without being closed from here
    // (⌘W) leaves the call going, so it folds to the chip it can be brought back from.
    let had = false;
    const read = (keys: { key: string; visible: boolean }[]) => {
      const mine = keys.find((entry) => entry.key === CALL_KEY);
      if (mine) {
        had = true;
        if (!mine.visible) useTeamCallStore.setState({ minimized: true });
      } else if (had) {
        had = false;
        if (useTeamCallStore.getState().call) useTeamCallStore.setState({ minimized: true });
      }
    };
    void floatList()
      .then((floats) => read((floats ?? []).map((float) => ({ key: parseFloatRef(float.refId)?.key ?? "", visible: float.visible }))))
      .catch(() => {});
    void listen<SatelliteInfo[]>("windows:satellites", (event) => {
      read(event.payload.filter((s) => s.kind === "float").map((s) => ({ key: parseFloatRef(s.ref_id)?.key ?? "", visible: true })));
    }).catch(() => {});
  } else if (FLOAT?.kind === "call") {
    onWindowMessage((message) => {
      if (message.kind === "float-state" && message.key === CALL_KEY) useTeamCallStore.setState({ minimized: message.minimized });
    });
  }
}
