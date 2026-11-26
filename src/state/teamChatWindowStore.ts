/**
 * The conversations with teams and with single agents, each in a floating window of its own — a
 * window of the system's, beside the app's rather than inside it (`windows::float_open`): one per
 * team and one per agent, as many on screen at once as the user opens, each where it was left.
 * Folded, a window is hidden and a chip on the main window's shelf stands for it.
 *
 * **The main window holds the list.** Which windows exist and which are folded is one fact, and
 * the shelf that draws it lives there; every other window — an island that starts a chat, a
 * floating window folding or closing itself — asks it over the bus (`FloatAction`) instead of
 * keeping a list of its own. A floating window holds just its own entry, as the main window tells
 * it (`float-state`).
 *
 * Free of the chat stores so those can tell this one when a turn ends.
 */
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { encodeFloatRef, FLOAT, floatKey, parseFloatRef, type FloatRef } from "../lib/floats";
import { floatClose, floatHide, floatList, floatOpen, showMainWindow, type SatelliteInfo } from "../lib/tauri/windows";
import { broadcast, onWindowMessage, sendTo, type FloatAction } from "../lib/windowBus";
import { isMainWindow, MAIN_LABEL } from "../lib/windowIdentity";

export interface TeamChatWindow {
  /** Whose window it is — `team:<id>`, `agent:<id>` — whichever of its owner's conversations it shows. */
  key: string;
  /** Whose conversation it is: a team's, or one agent's. */
  kind: "team" | "agent";
  /** The conversation: a team chat's id, or the task that is the agent's conversation. */
  chatId: string;
  /** The team — or, for an agent's window, the agent: there is one window for each. */
  teamId: string;
  /** The workspace its conversation is of. A team's may be unknown until its conversation is read. */
  workspaceId: string;
  /** What the system calls the window: the team's or the agent's name. */
  title: string;
  minimized: boolean;
  /** A turn ended while nobody was looking: how it ended. */
  unread: "" | "done" | "error";
}

interface TeamChatWindowState {
  windows: TeamChatWindow[];
  /** Shows the team's window on `chatId` — making it, or turning the one it has to that
   *  conversation. The others stay as they are. */
  open: (chatId: string, teamId: string, about?: { workspaceId?: string; title?: string }) => void;
  /** The same for one agent: its window, on the task `taskId` that is the conversation. An agent
   *  that is gone (`agentId` empty) has a window per conversation. */
  openAgent: (taskId: string, agentId: string, workspaceId: string, title?: string) => void;
  minimize: (key: string) => void;
  restore: (key: string) => void;
  close: (key: string) => void;
  /** `chatId` was deleted: the window showing it turns to `next`, or closes when there is none. */
  drop: (chatId: string, next?: string) => void;
  /** A turn of `chatId` ended out of sight. */
  markUnread: (chatId: string, how: "done" | "error") => void;
}

const MAIN = isMainWindow();

/** Asks the main window, from one that is not it. */
export function askMain(action: FloatAction): void {
  void sendTo(MAIN_LABEL, { kind: "float", to: MAIN_LABEL, action }).catch(() => {});
}

const refOf = (win: TeamChatWindow): FloatRef => ({ key: win.key, kind: win.kind, chatId: win.chatId, workspaceId: win.workspaceId, owner: win.teamId });

/** Tells the window itself what it is now. */
const tell = (win: TeamChatWindow) => broadcast({ kind: "float-state", key: win.key, minimized: win.minimized, chatId: win.chatId });

/** Puts `win`'s window on screen, on its conversation. */
function show(win: TeamChatWindow): void {
  void floatOpen(win.key, encodeFloatRef(refOf(win)), win.title, win.workspaceId || null).catch(() => {});
  tell(win);
}

/** `windows` with the one of `owner` shown on `chatId` — made when it has none. */
function unfold(windows: TeamChatWindow[], kind: TeamChatWindow["kind"], chatId: string, owner: string, workspaceId: string, title: string): TeamChatWindow[] {
  const key = floatKey(kind, owner, chatId);
  const at = windows.findIndex((w) => w.key === key);
  const was = at === -1 ? null : windows[at];
  const win: TeamChatWindow = { key, kind, chatId, teamId: owner, workspaceId: workspaceId || was?.workspaceId || "", title: title || was?.title || "", minimized: false, unread: "" };
  if (at === -1) return [...windows, win];
  const next = [...windows];
  next[at] = win;
  return next;
}

/**
 * In a floating window: its own entry turned to `chatId` at once, when `key` is its own — the main
 * window says the same a moment later, and what is drawn must not sit on a conversation that was
 * just deleted, or left, while that moment passes.
 */
function turn(set: (update: (state: TeamChatWindowState) => Partial<TeamChatWindowState>) => void, key: string, chatId: string): void {
  set((s) => (s.windows.some((w) => w.key === key && w.chatId !== chatId) ? { windows: s.windows.map((w) => (w.key === key ? { ...w, chatId, unread: "" } : w)) } : {}));
}

/** What a floating window holds of itself: its own entry, as it was opened. */
function own(): TeamChatWindow[] {
  if (!FLOAT || FLOAT.kind === "call") return [];
  return [{ key: FLOAT.key, kind: FLOAT.kind, chatId: FLOAT.chatId, teamId: FLOAT.owner, workspaceId: FLOAT.workspaceId, title: "", minimized: false, unread: "" }];
}

export const useTeamChatWindowStore = create<TeamChatWindowState>((set, get) => ({
  windows: own(),

  open: (chatId, teamId, about) => {
    if (!MAIN) {
      turn(set, floatKey("team", teamId, chatId), chatId);
      return askMain({ do: "open", kind: "team", chatId, owner: teamId, workspaceId: about?.workspaceId ?? "", title: about?.title ?? "" });
    }
    set((s) => ({ windows: unfold(s.windows, "team", chatId, teamId, about?.workspaceId ?? "", about?.title ?? "") }));
    const win = get().windows.find((w) => w.key === floatKey("team", teamId, chatId));
    if (win) show(win);
  },

  openAgent: (taskId, agentId, workspaceId, title) => {
    if (!MAIN) {
      turn(set, floatKey("agent", agentId, taskId), taskId);
      return askMain({ do: "open", kind: "agent", chatId: taskId, owner: agentId, workspaceId, title: title ?? "" });
    }
    set((s) => ({ windows: unfold(s.windows, "agent", taskId, agentId, workspaceId, title ?? "") }));
    const win = get().windows.find((w) => w.key === floatKey("agent", agentId, taskId));
    if (win) show(win);
  },

  minimize: (key) => {
    if (!MAIN) return askMain({ do: "minimize", key });
    set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: true } : w)) }));
    const win = get().windows.find((w) => w.key === key);
    if (!win) return;
    void floatHide(key).catch(() => {});
    tell(win);
  },

  restore: (key) => {
    if (!MAIN) return askMain({ do: "restore", key });
    set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: false, unread: "" } : w)) }));
    const win = get().windows.find((w) => w.key === key);
    if (win) show(win);
  },

  close: (key) => {
    if (!MAIN) return askMain({ do: "close", key });
    set((s) => ({ windows: s.windows.filter((w) => w.key !== key) }));
    void floatClose(key).catch(() => {});
  },

  drop: (chatId, next) => {
    if (!MAIN) {
      const mine = get().windows.find((w) => w.chatId === chatId);
      if (mine && next) turn(set, mine.key, next);
      return askMain({ do: "drop", chatId, next });
    }
    const gone = get().windows.filter((w) => w.chatId === chatId);
    if (gone.length === 0) return;
    set((s) => ({ windows: next ? s.windows.map((w) => (w.chatId === chatId ? { ...w, chatId: next, unread: "" } : w)) : s.windows.filter((w) => w.chatId !== chatId) }));
    for (const was of gone) {
      const now = get().windows.find((w) => w.key === was.key);
      if (!now) void floatClose(was.key).catch(() => {});
      else if (now.minimized) tell(now);
      // Shown: its window is told, and keeps what the system knows it by in step.
      else show(now);
    }
  },

  markUnread: (chatId, how) => {
    if (!MAIN) return askMain({ do: "ended", chatId, how, seen: false });
    set((s) => (s.windows.some((w) => w.chatId === chatId) ? { windows: s.windows.map((w) => (w.chatId === chatId ? { ...w, unread: how } : w)) } : s));
  },
}));

/** The conversations drawn somewhere in this window right now, by the element that draws each. */
const shown = new Map<string, Set<HTMLElement>>();

/** Says `element` is showing `chatId` until the returned function is called. */
export function showingTeamChat(chatId: string, element: HTMLElement): () => void {
  const elements = shown.get(chatId) ?? new Set<HTMLElement>();
  elements.add(element);
  shown.set(chatId, elements);
  return () => {
    elements.delete(element);
    if (elements.size === 0) shown.delete(chatId);
  };
}

/**
 * Whether the user can see `chatId` in this window now: drawn, not folded away with its window or
 * its view, and the window itself not hidden. What decides whether a finished turn has to be
 * announced.
 */
export function teamChatOnScreen(chatId: string): boolean {
  if (typeof document === "undefined" || document.hidden) return false;
  for (const element of shown.get(chatId) ?? []) {
    if (element.isConnected && element.getClientRects().length > 0) return true;
  }
  return false;
}

/** The floating windows the system has had: one that goes without being closed from here — ⌘W,
 *  its page reloading into nothing — is taken off the list when the system says it is gone. */
const alive = new Set<string>();

/** Takes what another window asked for. Exported for the tests: the bus only calls it. */
export function acceptFloatAction(action: FloatAction): void {
  const store = useTeamChatWindowStore.getState();
  switch (action.do) {
    case "open":
      if (action.kind === "team") store.open(action.chatId, action.owner, { workspaceId: action.workspaceId, title: action.title });
      else store.openAgent(action.chatId, action.owner, action.workspaceId, action.title);
      break;
    case "minimize":
      store.minimize(action.key);
      break;
    case "restore":
      store.restore(action.key);
      break;
    case "close":
      store.close(action.key);
      break;
    case "drop":
      store.drop(action.chatId, action.next);
      break;
    case "crew-open":
      // What only the Agents view shows — the launcher with a draft, a task's whole sheet — asked
      // for from a floating window: the main window comes forward on it.
      void showMainWindow().catch(() => {});
      void Promise.all([import("../components/crew/state"), import("./uiStore")]).then(([crew, ui]) => {
        ui.useUiStore.getState().setActiveView("agents");
        crew.useCrewStore.getState().open(action.overlay as Parameters<ReturnType<typeof crew.useCrewStore.getState>["open"]>[0]);
      });
      break;
    case "follow":
      void showMainWindow().catch(() => {});
      void import("./notificationStore").then((notifications) => notifications.followTarget(action.workspaceId, action.target as Parameters<typeof notifications.followTarget>[1]));
      break;
    default:
      // The call's, and a turn that ended: `teamCallStore` and `teamChatStore` answer those.
      break;
  }
}

if (typeof window !== "undefined") {
  if (MAIN) {
    onWindowMessage((message) => {
      if (message.kind === "float" && message.to === MAIN_LABEL) acceptFloatAction(message.action);
    });
    // After a reload of this window the floating ones are still there: read them back.
    void floatList()
      .then((floats) => {
        const found: TeamChatWindow[] = [];
        for (const float of floats ?? []) {
          const ref = parseFloatRef(float.refId);
          if (!ref || ref.kind === "call") continue;
          alive.add(ref.key);
          found.push({ key: ref.key, kind: ref.kind, chatId: ref.chatId, teamId: ref.owner, workspaceId: ref.workspaceId, title: "", minimized: !float.visible, unread: "" });
        }
        if (found.length > 0) useTeamChatWindowStore.setState((s) => ({ windows: [...found.filter((w) => !s.windows.some((have) => have.key === w.key)), ...s.windows] }));
      })
      .catch(() => {});
    void listen<SatelliteInfo[]>("windows:satellites", (event) => {
      const now = new Set(event.payload.filter((s) => s.kind === "float").map((s) => parseFloatRef(s.ref_id)?.key ?? ""));
      const gone = [...alive].filter((key) => !now.has(key));
      for (const key of now) alive.add(key);
      for (const key of gone) alive.delete(key);
      if (gone.length > 0) useTeamChatWindowStore.setState((s) => (s.windows.some((w) => gone.includes(w.key)) ? { windows: s.windows.filter((w) => !gone.includes(w.key)) } : s));
    }).catch(() => {});
  } else if (FLOAT && FLOAT.kind !== "call") {
    const key = FLOAT.key;
    onWindowMessage((message) => {
      if (message.kind !== "float-state" || message.key !== key) return;
      useTeamChatWindowStore.setState((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: message.minimized, chatId: message.chatId ?? w.chatId } : w)) }));
    });
  }
}
