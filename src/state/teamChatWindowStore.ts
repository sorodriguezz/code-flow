/**
 * The conversations with teams and with single agents open as floating windows over whichever view
 * is on screen: one per team and one per agent, at most one unfolded and the rest minimised to the
 * shelf at the bottom. Apart from every view's own overlay on purpose — a chat that stays open
 * must not be what keeps a card, a launcher or a member's sheet from opening.
 *
 * Free of the chat stores so those can tell this one when a turn ends.
 */
import { create } from "zustand";
import type { Rect } from "../lib/floatingRect";

export interface TeamChatWindow {
  /** Stable while the window lives, whichever of its owner's conversations it shows. */
  key: string;
  /** Whose conversation it is: a team's, or one agent's. */
  kind: "team" | "agent";
  /** The conversation: a team chat's id, or the task that is the agent's conversation. */
  chatId: string;
  /** The team — or, for an agent's window, the agent: there is one window for each. */
  teamId: string;
  /** An agent's window says which workspace it is of; a team's conversation says it itself. */
  workspaceId: string;
  minimized: boolean;
  /** A turn ended while nobody was looking: how it ended. */
  unread: "" | "done" | "error";
}

const FRAME_KEY = "cf.crew.teamChatWindow";

interface Frame {
  rect: Rect | null;
  maximized: boolean;
}

function readFrame(): Frame {
  try {
    const raw = JSON.parse(localStorage.getItem(FRAME_KEY) ?? "null") as Partial<Frame> | null;
    const r = raw?.rect;
    const whole = r && [r.x, r.y, r.w, r.h].every((n) => typeof n === "number" && Number.isFinite(n));
    return { rect: whole ? { x: r.x, y: r.y, w: r.w, h: r.h } : null, maximized: raw?.maximized === true };
  } catch {
    return { rect: null, maximized: false };
  }
}

function writeFrame(frame: Frame): void {
  try {
    localStorage.setItem(FRAME_KEY, JSON.stringify(frame));
  } catch {
    /* private window, blocked storage */
  }
}

interface TeamChatWindowState extends Frame {
  windows: TeamChatWindow[];
  /** Unfolds the team's window on `chatId` — making it, or turning the one it has to that
   *  conversation — and minimises whichever was unfolded. */
  open: (chatId: string, teamId: string) => void;
  /** The same for one agent: its window, on the task `taskId` that is the conversation. An agent
   *  that is gone (`agentId` empty) has a window per conversation. */
  openAgent: (taskId: string, agentId: string, workspaceId: string) => void;
  minimize: (key: string) => void;
  restore: (key: string) => void;
  close: (key: string) => void;
  /** `chatId` was deleted: the window showing it turns to `next`, or closes when there is none. */
  drop: (chatId: string, next?: string) => void;
  /** A turn of `chatId` ended out of sight. */
  markUnread: (chatId: string, how: "done" | "error") => void;
  /** Where the user left the window, kept for the next one. */
  place: (rect: Rect) => void;
  toggleMaximized: () => void;
}

let made = 0;

/** `windows` with the one of `owner` unfolded on `chatId` — made when it has none — and every
 *  other folded. */
function unfold(windows: TeamChatWindow[], kind: TeamChatWindow["kind"], chatId: string, owner: string, workspaceId: string): TeamChatWindow[] {
  const folded = windows.map((w) => (w.minimized ? w : { ...w, minimized: true }));
  const at = folded.findIndex((w) => w.kind === kind && (w.chatId === chatId || (owner !== "" && w.teamId === owner)));
  if (at === -1) return [...folded, { key: `chat-window-${++made}`, kind, chatId, teamId: owner, workspaceId, minimized: false, unread: "" }];
  folded[at] = { ...folded[at], chatId, teamId: owner, workspaceId, minimized: false, unread: "" };
  return folded;
}

export const useTeamChatWindowStore = create<TeamChatWindowState>((set, get) => ({
  windows: [],
  ...(typeof window === "undefined" ? { rect: null, maximized: false } : readFrame()),

  open: (chatId, teamId) => set((s) => ({ windows: unfold(s.windows, "team", chatId, teamId, "") })),

  openAgent: (taskId, agentId, workspaceId) => set((s) => ({ windows: unfold(s.windows, "agent", taskId, agentId, workspaceId) })),

  minimize: (key) => set((s) => ({ windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: true } : w)) })),

  restore: (key) =>
    set((s) => ({
      windows: s.windows.map((w) => (w.key === key ? { ...w, minimized: false, unread: "" } : w.minimized ? w : { ...w, minimized: true })),
    })),

  close: (key) => set((s) => ({ windows: s.windows.filter((w) => w.key !== key) })),

  drop: (chatId, next) =>
    set((s) => {
      if (!s.windows.some((w) => w.chatId === chatId)) return s;
      return { windows: next ? s.windows.map((w) => (w.chatId === chatId ? { ...w, chatId: next, unread: "" } : w)) : s.windows.filter((w) => w.chatId !== chatId) };
    }),

  markUnread: (chatId, how) =>
    set((s) => (s.windows.some((w) => w.chatId === chatId) ? { windows: s.windows.map((w) => (w.chatId === chatId ? { ...w, unread: how } : w)) } : s)),

  place: (rect) => {
    set({ rect });
    writeFrame({ rect, maximized: get().maximized });
  },

  toggleMaximized: () => {
    const maximized = !get().maximized;
    set({ maximized });
    writeFrame({ rect: get().rect, maximized });
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
 * Whether the user can see `chatId` now: drawn, not folded away with its window or its view, and
 * the app itself not hidden. What decides whether a finished turn has to be announced.
 */
export function teamChatOnScreen(chatId: string): boolean {
  if (typeof document === "undefined" || document.hidden) return false;
  for (const element of shown.get(chatId) ?? []) {
    if (element.isConnected && element.getClientRects().length > 0) return true;
  }
  return false;
}
