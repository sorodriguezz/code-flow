import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import type { PrTarget } from "../lib/prTarget";
import type { PullRequestSummary } from "../types/domain";
import { useUiStore } from "./uiStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * What the assistant panel shows, and the one way to change it.
 *
 * # Why this exists
 *
 * The panel used to have no navigation of its own. What it drew was *derived*, at render time, from
 * three stores that knew nothing of each other — a PR reviewed from a link, the selected pull
 * request, the per-project analysis flag, and last of all the chat — in that order of precedence.
 * Every way into the panel (a sidebar row, a notification, the Changes button, an Activity row…)
 * therefore had to remember to clear the other two, and each remembered a different subset: with a
 * link review on screen, opening a chat or an analysis did nothing visible at all. And because only
 * one body was ever mounted, switching threw away whatever lived in the one being left — a draft,
 * the findings ticked for publishing, the cards that were open.
 *
 * Here the panel is a set of **tabs per workspace** plus the Inbox, and [`open`] is the only door:
 * whatever wants something on screen names it, and nothing else decides visibility. Each tab names
 * its own project (or, for a link review, its own workspace), so no tab is ever re-pointed by moving
 * to another repository — the class of bug `prStore.selectedPrProjectId` used to guard against by
 * refusing to draw. What a tab holds while it is not on screen lives in [`view`] and [`drafts`],
 * keyed by the tab, so leaving one costs nothing.
 *
 * # Persistence
 *
 * Tabs and unread marks are kept per workspace, drafts globally, in `app_settings`. Every write
 * waits for that key's read first: writing the in-memory copy before the disk copy has been merged
 * in is how a list gets replaced by its first new entry (the bug `prWatchStore` had). Nothing is
 * *run* again on restore — a tab comes back as a place to look, never as work restarted.
 */

/** A pull request opened from its link with nothing checked out for it. Lives in its tab: a link
 * review belongs to no project here, so the tab is the only handle anything has on it. */
export interface LinkPrSession {
  url: string;
  pr: PullRequestSummary;
  /** "owner/repo" — the only thing on screen naming which repository this PR is in. */
  repoLabel: string;
  /** Offered as "clone it after all" from inside the review. */
  cloneUrl: string;
  /** Whose review standard, contexts and skills it runs under — and where its tab lives. */
  workspaceId: string;
}

export type PanelTab =
  | {
      kind: "chat";
      key: string;
      projectId: string;
      conversationId: string;
      /** A chat nobody has written in yet. "New chat" reuses one of these rather than piling up
       *  empty tabs, and the Inbox does not list it — a conversation starts with its first question. */
      fresh?: boolean;
    }
  | { kind: "pr"; key: string; projectId: string; prId: number; pr: PullRequestSummary }
  | { kind: "prLink"; key: string; session: LinkPrSession }
  | { kind: "analysis"; key: string; projectId: string; jobId: string | null };

/** Something to put on screen. `finding` opens that finding in the document it belongs to. */
export type PanelTarget =
  | { kind: "inbox"; workspaceId?: string | null }
  | { kind: "chat"; projectId: string; conversationId?: string | null }
  | { kind: "pr"; projectId: string; pr: PullRequestSummary; finding?: string | null }
  | { kind: "prLink"; session: LinkPrSession; finding?: string | null }
  | { kind: "analysis"; projectId: string; jobId?: string | null; finding?: string | null };

export type DocSegment = "findings" | "comments" | "summary";

/** What a tab remembers about how it was left. Plain JSON on purpose (records, not sets). */
export interface TabView {
  segment?: DocSegment;
  /** Finding id → open. */
  expanded?: Record<string, boolean>;
  /** Publishing mode: the checkboxes only exist while choosing what to publish. */
  selecting?: boolean;
  /** Finding id → left out of the next publish. Absent means included, so a new finding starts
   *  ticked without anything having to be written for it. */
  deselected?: Record<string, boolean>;
  includeSummary?: boolean;
  commentOnDecide?: boolean;
  /** A past run pinned for reading (`null`/absent = the latest). */
  runId?: string | null;
  /** The finding shown in the detail column of the wide layout. */
  picked?: string | null;
  scroll?: number;
}

export interface UnreadMark {
  at: number;
  status: "success" | "error";
  /** The workspace the result belongs to — the Inbox only lists its own. */
  workspaceId: string | null;
}

export const INBOX_KEY = "inbox";
/** Where tabs go when no workspace has been chosen yet (first run, or every workspace deleted). */
export const NO_WORKSPACE = "__none__";
/** Enough for a real afternoon of parallel work without the strip becoming its own navigation
 *  problem. Past it the least recently used idle tab closes — it is still one click away in the
 *  Inbox, which is the whole difference between closing and losing. */
export const MAX_TABS = 8;

export const chatTabKey = (conversationId: string) => `chat:${conversationId}`;
export const prTabKey = (projectId: string, prId: number) => `pr:${projectId}:${prId}`;
export const prLinkTabKey = (url: string) => `prlink:${url}`;
export const analysisTabKey = (projectId: string) => `analysis:${projectId}`;

/** The tab key of a pull request, whichever way it is reached. */
export function prTargetTabKey(target: PrTarget, prId: number): string {
  return target.kind === "project" ? prTabKey(target.projectId, prId) : prLinkTabKey(target.url);
}

export function newConversationId(): string {
  return `conv-${crypto.randomUUID()}`;
}

/** The workspace a target's tab lives in. A project answers through its workspace; the active one
 *  is only the fallback for a repository whose workspace list has not been loaded. */
export function workspaceForTarget(target: PanelTarget): string {
  const workspaces = useWorkspaceStore.getState();
  if (target.kind === "inbox") return target.workspaceId ?? workspaces.activeWorkspaceId ?? NO_WORKSPACE;
  if (target.kind === "prLink") return target.session.workspaceId;
  return workspaces.workspaceOfProject(target.projectId) ?? workspaces.activeWorkspaceId ?? NO_WORKSPACE;
}

function projectOf(tab: PanelTab): string | null {
  return tab.kind === "prLink" ? null : tab.projectId;
}

interface PersistedWorkspace {
  tabs: PanelTab[];
  active: string;
  unread: Record<string, UnreadMark>;
}

interface AiPanelState {
  /** Open tabs per workspace, in strip order. The Inbox is implicit and always first. */
  tabsByWorkspace: Record<string, PanelTab[]>;
  /** The tab on screen per workspace; the Inbox when absent. */
  activeByWorkspace: Record<string, string>;
  view: Record<string, TabView>;
  /** Unsent text, keyed by whatever owns it: `chat:<conversation>`, a comment thread, a note. */
  drafts: Record<string, string>;
  /** Results that landed while their tab was not on screen, keyed by tab key. */
  unread: Record<string, UnreadMark>;
  /** When each tab was last on screen — what the tab cap evicts by. Not persisted. */
  lastUsed: Record<string, number>;
  /** The panel's wide mode: half the window, and a two-column document. */
  wide: boolean;

  /** Puts `target` on screen (unless `focus: false`) and returns its tab key. Opening something
   *  that is already open focuses it; it never duplicates. */
  open: (target: PanelTarget, opts?: { focus?: boolean }) => string;
  focus: (key: string, workspaceId?: string) => void;
  close: (key: string, workspaceId?: string) => void;
  setView: (key: string, patch: Partial<TabView>) => void;
  setDraft: (key: string, text: string) => void;
  /** Files a finished result as unread — unless its tab is the one on screen right now. */
  markUnread: (key: string, mark: Omit<UnreadMark, "at">) => void;
  markSeen: (key: string) => void;
  /** The first question has been asked: the tab is a conversation now, not a blank one. */
  markChatStarted: (key: string) => void;
  /** Writes the host's latest copy of a pull request into every tab showing it. */
  updatePr: (target: PrTarget, pr: PullRequestSummary) => void;
  /** Points an analysis tab at a particular run (a new one, or one opened from history). */
  setAnalysisJob: (projectId: string, jobId: string | null) => void;
  toggleWide: () => void;
  /** Reads a workspace's tabs from disk and merges them under what is already in memory. */
  load: (workspaceId: string) => Promise<void>;
}

const loading = new Map<string, Promise<void>>();
let draftsLoad: Promise<void> | null = null;
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFTS_KEY = "ai_panel_drafts";
const WIDE_KEY = "ai_panel_wide";
const MAX_DRAFTS = 60;
const settingKey = (workspaceId: string) => `ai_panel_${workspaceId}`;

function isTab(value: unknown): value is PanelTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  if (typeof tab.key !== "string") return false;
  switch (tab.kind) {
    case "chat":
      return typeof tab.projectId === "string" && typeof tab.conversationId === "string";
    case "pr":
      return typeof tab.projectId === "string" && typeof tab.prId === "number" && !!tab.pr;
    case "prLink": {
      const session = tab.session as Record<string, unknown> | undefined;
      return !!session && typeof session.url === "string" && !!session.pr;
    }
    case "analysis":
      return typeof tab.projectId === "string";
    default:
      return false;
  }
}

/** Debounced so a burst of edits is one write, and after the key's read so it can never clobber it. */
function schedule(key: string, write: () => Promise<void>): void {
  const pending = persistTimers.get(key);
  if (pending) clearTimeout(pending);
  persistTimers.set(
    key,
    setTimeout(() => {
      persistTimers.delete(key);
      void write().catch(() => {});
    }, 400),
  );
}

function persistWorkspace(workspaceId: string): void {
  if (workspaceId === NO_WORKSPACE) return;
  schedule(settingKey(workspaceId), async () => {
    await useAiPanelStore.getState().load(workspaceId);
    const s = useAiPanelStore.getState();
    const unread: Record<string, UnreadMark> = {};
    for (const [key, mark] of Object.entries(s.unread)) {
      if (mark.workspaceId === workspaceId) unread[key] = mark;
    }
    const payload: PersistedWorkspace = {
      // A brand-new chat nobody wrote in is not worth restoring: it has nothing but a blank page.
      tabs: (s.tabsByWorkspace[workspaceId] ?? []).filter(
        (tab) => !(tab.kind === "chat" && tab.fresh && !s.drafts[tab.key]),
      ),
      active: s.activeByWorkspace[workspaceId] ?? INBOX_KEY,
      unread,
    };
    await setSetting(settingKey(workspaceId), JSON.stringify(payload));
  });
}

function persistDrafts(): void {
  schedule(DRAFTS_KEY, async () => {
    await loadDrafts();
    const entries = Object.entries(useAiPanelStore.getState().drafts)
      .filter(([, text]) => text.trim().length > 0)
      .slice(-MAX_DRAFTS);
    await setSetting(DRAFTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  });
}

function loadDrafts(): Promise<void> {
  if (!draftsLoad) {
    draftsLoad = (async () => {
      const raw = await getSetting(DRAFTS_KEY).catch(() => null);
      const wide = await getSetting(WIDE_KEY).catch(() => null);
      let stored: Record<string, string> = {};
      try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object") {
          stored = Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          );
        }
      } catch {
        // A corrupt blob is a lost draft, never a broken panel.
      }
      useAiPanelStore.setState((s) => ({
        // Whatever was typed this session is newer than the disk copy.
        drafts: { ...stored, ...s.drafts },
        wide: wide === null ? s.wide : wide === "true",
      }));
    })();
  }
  return draftsLoad;
}

/** Drops the least recently used idle tab while there are too many. The tab being opened, the one
 *  on screen and anything with unsent text are never candidates. */
function trim(tabs: PanelTab[], keep: string, active: string, s: AiPanelState): PanelTab[] {
  let next = tabs;
  while (next.length > MAX_TABS) {
    const candidates = next.filter((tab) => tab.key !== keep && tab.key !== active && !s.drafts[tab.key]);
    if (candidates.length === 0) break;
    const victim = candidates.reduce((oldest, tab) =>
      (s.lastUsed[tab.key] ?? 0) < (s.lastUsed[oldest.key] ?? 0) ? tab : oldest,
    );
    next = next.filter((tab) => tab.key !== victim.key);
  }
  return next;
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Whether `key` is what the user is looking at right now: the panel open, on its workspace, on it. */
export function isTabVisible(key: string, workspaceId: string | null): boolean {
  if (!useUiStore.getState().aiPanelOpen) return false;
  const active = useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
  if ((workspaceId ?? NO_WORKSPACE) !== active) return false;
  return (useAiPanelStore.getState().activeByWorkspace[active] ?? INBOX_KEY) === key;
}

export const useAiPanelStore = create<AiPanelState>((set, get) => ({
  tabsByWorkspace: {},
  activeByWorkspace: {},
  view: {},
  drafts: {},
  unread: {},
  lastUsed: {},
  wide: false,

  open: (target, opts = {}) => {
    const focus = opts.focus !== false;
    const workspaceId = workspaceForTarget(target);
    void get().load(workspaceId);
    if (target.kind === "inbox") {
      if (focus) {
        set((s) => ({ activeByWorkspace: { ...s.activeByWorkspace, [workspaceId]: INBOX_KEY } }));
        useUiStore.getState().openAiPanel();
        persistWorkspace(workspaceId);
      }
      return INBOX_KEY;
    }

    const existing = get().tabsByWorkspace[workspaceId] ?? [];
    let tab: PanelTab;
    if (target.kind === "chat") {
      // "New chat" lands on the blank one this repository already has, if there is one.
      const reusable = target.conversationId
        ? undefined
        : existing.find((t) => t.kind === "chat" && t.fresh && t.projectId === target.projectId);
      const conversationId = target.conversationId ?? (reusable?.kind === "chat" ? reusable.conversationId : newConversationId());
      tab = {
        kind: "chat",
        key: chatTabKey(conversationId),
        projectId: target.projectId,
        conversationId,
        fresh: target.conversationId ? undefined : true,
      };
    } else if (target.kind === "pr") {
      tab = { kind: "pr", key: prTabKey(target.projectId, target.pr.id), projectId: target.projectId, prId: target.pr.id, pr: target.pr };
    } else if (target.kind === "prLink") {
      tab = { kind: "prLink", key: prLinkTabKey(target.session.url), session: target.session };
    } else {
      tab = { kind: "analysis", key: analysisTabKey(target.projectId), projectId: target.projectId, jobId: target.jobId ?? null };
    }

    const finding = target.kind === "chat" ? null : (target.finding ?? null);
    set((s) => {
      const tabs = s.tabsByWorkspace[workspaceId] ?? [];
      const at = tabs.findIndex((t) => t.key === tab.key);
      let next: PanelTab[];
      if (at >= 0) {
        next = tabs.map((t, i) => {
          if (i !== at) return t;
          // What the caller knows now beats what the tab was opened with: a fresher PR snapshot, a
          // run picked from history. A chat keeps its own flags — reopening one does not make it
          // blank again.
          if (t.kind === "analysis" && tab.kind === "analysis") {
            return target.kind === "analysis" && target.jobId !== undefined ? { ...t, jobId: tab.jobId } : t;
          }
          if (t.kind === "chat") return t;
          return tab;
        });
      } else {
        next = [...tabs, tab];
      }
      const active = focus ? tab.key : (s.activeByWorkspace[workspaceId] ?? INBOX_KEY);
      next = trim(next, tab.key, active, s);
      const view = finding
        ? {
            ...s.view,
            [tab.key]: {
              ...s.view[tab.key],
              segment: "findings" as const,
              runId: null,
              picked: finding,
              expanded: { ...s.view[tab.key]?.expanded, [finding]: true },
            },
          }
        : s.view;
      return {
        tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: next },
        activeByWorkspace: focus ? { ...s.activeByWorkspace, [workspaceId]: tab.key } : s.activeByWorkspace,
        lastUsed: { ...s.lastUsed, [tab.key]: Date.now() },
        unread: focus ? omit(s.unread, tab.key) : s.unread,
        view,
      };
    });
    if (focus) useUiStore.getState().openAiPanel();
    persistWorkspace(workspaceId);
    return tab.key;
  },

  focus: (key, workspaceId) => {
    const ws = workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
    set((s) => ({
      activeByWorkspace: { ...s.activeByWorkspace, [ws]: key },
      lastUsed: { ...s.lastUsed, [key]: Date.now() },
      unread: omit(s.unread, key),
    }));
    persistWorkspace(ws);
  },

  close: (key, workspaceId) => {
    if (key === INBOX_KEY) return;
    const ws = workspaceId ?? useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
    set((s) => {
      const tabs = s.tabsByWorkspace[ws] ?? [];
      const at = tabs.findIndex((t) => t.key === key);
      if (at < 0) return s;
      const next = tabs.filter((t) => t.key !== key);
      let active = s.activeByWorkspace[ws] ?? INBOX_KEY;
      // Closing the tab on screen lands on its neighbour, the way a browser does — never on nothing.
      if (active === key) active = next[Math.min(at, next.length - 1)]?.key ?? INBOX_KEY;
      const closed = tabs[at];
      return {
        tabsByWorkspace: { ...s.tabsByWorkspace, [ws]: next },
        activeByWorkspace: { ...s.activeByWorkspace, [ws]: active },
        // How a document was being read goes with it. Drafts stay: they are keyed by what they
        // belong to, so reopening the conversation from the Inbox brings its unsent text back.
        view: omit(s.view, key),
        drafts: closed.kind === "chat" && closed.fresh ? omit(s.drafts, key) : s.drafts,
      };
    });
    persistWorkspace(ws);
  },

  setView: (key, patch) => set((s) => ({ view: { ...s.view, [key]: { ...s.view[key], ...patch } } })),

  setDraft: (key, text) => {
    if ((get().drafts[key] ?? "") === text) return;
    set((s) => ({ drafts: text ? { ...s.drafts, [key]: text } : omit(s.drafts, key) }));
    persistDrafts();
  },

  markUnread: (key, mark) => {
    if (isTabVisible(key, mark.workspaceId)) return;
    set((s) => ({ unread: { ...s.unread, [key]: { ...mark, at: Date.now() } } }));
    persistWorkspace(mark.workspaceId ?? NO_WORKSPACE);
  },

  markSeen: (key) => {
    const mark = get().unread[key];
    if (!mark) return;
    set((s) => ({ unread: omit(s.unread, key) }));
    persistWorkspace(mark.workspaceId ?? NO_WORKSPACE);
  },

  markChatStarted: (key) => {
    let owner: string | null = null;
    set((s) => {
      const tabsByWorkspace = { ...s.tabsByWorkspace };
      for (const [ws, tabs] of Object.entries(s.tabsByWorkspace)) {
        if (!tabs.some((t) => t.key === key && t.kind === "chat" && t.fresh)) continue;
        owner = ws;
        tabsByWorkspace[ws] = tabs.map((t) => (t.key === key && t.kind === "chat" ? { ...t, fresh: undefined } : t));
      }
      return owner ? { tabsByWorkspace } : s;
    });
    if (owner) persistWorkspace(owner);
  },

  updatePr: (target, pr) => {
    const key = prTargetTabKey(target, pr.id);
    const touched: string[] = [];
    set((s) => {
      const tabsByWorkspace = { ...s.tabsByWorkspace };
      for (const [ws, tabs] of Object.entries(s.tabsByWorkspace)) {
        if (!tabs.some((t) => t.key === key)) continue;
        touched.push(ws);
        tabsByWorkspace[ws] = tabs.map((t) => {
          if (t.key !== key) return t;
          if (t.kind === "pr") return { ...t, pr };
          if (t.kind === "prLink") return { ...t, session: { ...t.session, pr } };
          return t;
        });
      }
      return touched.length > 0 ? { tabsByWorkspace } : s;
    });
    touched.forEach(persistWorkspace);
  },

  setAnalysisJob: (projectId, jobId) => {
    const key = analysisTabKey(projectId);
    set((s) => {
      const tabsByWorkspace = { ...s.tabsByWorkspace };
      let changed = false;
      for (const [ws, tabs] of Object.entries(s.tabsByWorkspace)) {
        if (!tabs.some((t) => t.key === key)) continue;
        changed = true;
        tabsByWorkspace[ws] = tabs.map((t) => (t.key === key && t.kind === "analysis" ? { ...t, jobId } : t));
      }
      return changed ? { tabsByWorkspace } : s;
    });
  },

  toggleWide: () => {
    const wide = !get().wide;
    set({ wide });
    void setSetting(WIDE_KEY, String(wide)).catch(() => {});
  },

  load: (workspaceId) => {
    const existing = loading.get(workspaceId);
    if (existing) return existing;
    const task = (async () => {
      void loadDrafts();
      if (workspaceId === NO_WORKSPACE) return;
      const raw = await getSetting(settingKey(workspaceId)).catch(() => null);
      if (!raw) return;
      let parsed: Partial<PersistedWorkspace>;
      try {
        parsed = JSON.parse(raw) as Partial<PersistedWorkspace>;
      } catch {
        return;
      }
      const stored = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTab) : [];
      const storedUnread =
        parsed.unread && typeof parsed.unread === "object" ? (parsed.unread as Record<string, UnreadMark>) : {};
      set((s) => {
        // Tabs opened this session win, and keep their place; the restored ones go in front of them
        // in the order they were left.
        const live = s.tabsByWorkspace[workspaceId] ?? [];
        const liveKeys = new Set(live.map((t) => t.key));
        const merged = [...stored.filter((t) => !liveKeys.has(t.key)), ...live].slice(-MAX_TABS);
        const keys = new Set(merged.map((t) => t.key));
        const storedActive = typeof parsed.active === "string" ? parsed.active : INBOX_KEY;
        const active =
          s.activeByWorkspace[workspaceId] ?? (keys.has(storedActive) ? storedActive : INBOX_KEY);
        return {
          tabsByWorkspace: { ...s.tabsByWorkspace, [workspaceId]: merged },
          activeByWorkspace: { ...s.activeByWorkspace, [workspaceId]: active },
          unread: { ...storedUnread, ...s.unread },
        };
      });
    })();
    loading.set(workspaceId, task);
    return task;
  },
}));

/** The tabs of one workspace, stable when there are none (a selector returning a fresh `[]` would
 *  re-render every subscriber on every store write). */
export const EMPTY_TABS: PanelTab[] = [];

/** Every open tab that shows something of `projectId`'s. */
export function tabsOfProject(projectId: string): PanelTab[] {
  return Object.values(useAiPanelStore.getState().tabsByWorkspace)
    .flat()
    .filter((tab) => projectOf(tab) === projectId);
}

/** The tab on screen, when the panel is open — what the sidebar highlights and the title bar's
 *  "review this PR" acts on. */
export function visibleTab(): PanelTab | null {
  if (!useUiStore.getState().aiPanelOpen) return null;
  const ws = useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
  const s = useAiPanelStore.getState();
  const key = s.activeByWorkspace[ws] ?? INBOX_KEY;
  return (s.tabsByWorkspace[ws] ?? EMPTY_TABS).find((tab) => tab.key === key) ?? null;
}

// Opening the panel is looking at whatever it lands on.
useUiStore.subscribe((state, previous) => {
  if (!state.aiPanelOpen || previous.aiPanelOpen) return;
  const ws = useWorkspaceStore.getState().activeWorkspaceId ?? NO_WORKSPACE;
  const key = useAiPanelStore.getState().activeByWorkspace[ws];
  if (key) useAiPanelStore.getState().markSeen(key);
});

/**
 * The pull request of `projectId` on screen in the assistant, if one is — what the sidebar's list
 * highlights. Subscribes, so the row follows the tab.
 */
export function useVisiblePrId(projectId: string): number | null {
  const panelOpen = useUiStore((s) => s.aiPanelOpen);
  const ws = useWorkspaceStore((s) => s.activeWorkspaceId) ?? NO_WORKSPACE;
  return useAiPanelStore((s) => {
    if (!panelOpen) return null;
    const key = s.activeByWorkspace[ws] ?? INBOX_KEY;
    const tab = (s.tabsByWorkspace[ws] ?? EMPTY_TABS).find((t) => t.key === key);
    return tab?.kind === "pr" && tab.projectId === projectId ? tab.prId : null;
  });
}
