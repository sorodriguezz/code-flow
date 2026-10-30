/**
 * What feeds Settings › Estadísticas from this side: which app or tab is in front and for how long,
 * which one-off surfaces were opened, the actions inside each app, chats, shortcuts, palette
 * commands and failures. AI runs and git operations are counted by the backend where they happen
 * (`usage_stats.rs`), so nothing that spends or writes can be missed.
 *
 * **One observer for every app's actions.** Rather than a counter in each component, the app's
 * `tauri/invoke` wrapper reports completed commands and `usageActions` decides what each counts as.
 * Tauri's own IPC functions are read-only and must never be replaced: doing so throws during boot
 * and used to leave every satellite on its loading skeleton.
 *
 * **Batched.** Increments add up in memory under `day|hour|workspace|repo|kind|key` and go to the
 * database every {@link FLUSH_MS}, when the window is hidden and before it unloads.
 *
 * **Time is time in front of it.** Seconds accrue to the active view only while the window is
 * visible and focused; a CodeFlow left open behind a browser all afternoon is not four hours of
 * Graph.
 *
 * **Never content.** Keys name kinds of things; see `usageActions`.
 */

import { usageRecord, usageSetContext } from "./tauri/commands";
import { setInvokeObserver } from "./tauri/invoke";
import { paletteKey, usageHitsFor, type ChatSurface } from "./usageActions";
import { REPO_VIEWS, useUiStore } from "../state/uiStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useTerminalStore } from "../state/terminalStore";
import type { UsageEvent, UsageKind } from "../types/domain";

const FLUSH_MS = 30_000;

const pending = new Map<string, UsageEvent>();

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day, the same one `chrono::Local` files backend events under. */
export function localDay(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function workspaceNow(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId ?? null;
}

/** The open repository, when the view in front is one of its tabs. */
function repoInView(): string | null {
  const ui = useUiStore.getState();
  return REPO_VIEWS.includes(ui.activeView) ? (useWorkspaceStore.getState().activeProjectId ?? null) : null;
}

/** The project a call is about, from the id or the path it names. */
export function repoFromArgs(args: Record<string, unknown>): string | null {
  const { projectsByWorkspace } = useWorkspaceStore.getState();
  const projects = Object.values(projectsByWorkspace).flat();
  if (typeof args.projectId === "string" && projects.some((p) => p.id === args.projectId)) return args.projectId;
  const path = [args.repoPath, args.projectPath, args.cwd].find((value): value is string => typeof value === "string");
  if (!path) return null;
  const normal = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const wanted = normal(path);
  let best: { id: string; length: number } | null = null;
  for (const project of projects) {
    const root = normal(project.local_path);
    if (root && (wanted === root || wanted.startsWith(`${root}/`)) && (!best || root.length > best.length)) {
      best = { id: project.id, length: root.length };
    }
  }
  return best?.id ?? null;
}

/** Adds to one counter. `workspaceId` defaults to the active workspace; `repo` to none. */
export function trackUsage(
  kind: UsageKind,
  key: string,
  amounts: { count?: number; seconds?: number } = {},
  workspaceId: string | null = workspaceNow(),
  repo: string | null = null,
) {
  const count = amounts.count ?? (amounts.seconds ? 0 : 1);
  const seconds = amounts.seconds ?? 0;
  if (!key || (count <= 0 && seconds <= 0)) return;
  const now = new Date();
  const day = localDay(now);
  const hour = now.getHours();
  const id = `${day}|${hour}|${workspaceId ?? ""}|${repo ?? ""}|${kind}|${key}`;
  const entry = pending.get(id);
  if (entry) {
    entry.count += count;
    entry.seconds += seconds;
  } else {
    pending.set(id, { kind, key, workspaceId: workspaceId ?? "", repo: repo ?? "", count, seconds, day, hour });
  }
}

/** The view key a state stands for: the API tab is two apps behind one view. */
export function viewKey(view: string, apiWorkspace: string): string {
  return view === "api" && apiWorkspace === "database" ? "databases" : view;
}

/** A shortcut that ran, by its catalogue id. */
export function trackShortcut(id: string) {
  trackUsage("shortcut", id);
}

/** A command-palette row that was chosen. */
export function trackPaletteCommand(group: string, key: string) {
  trackUsage("command", paletteKey(group, key));
}

// --------------------------------------------------------------------------- time in front

let current: { key: string; workspaceId: string | null; repo: string | null } | null = null;
let since = 0;
let attending = false;

function isAttending(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** Books the seconds since the last booking to the view in front, then restarts the clock. */
function bookTime() {
  const now = Date.now();
  if (attending && current && since > 0) {
    const seconds = (now - since) / 1000;
    // A machine that slept with the window focused comes back to one enormous interval; nobody
    // looked at the graph for nine hours overnight.
    if (seconds > 0 && seconds < 30 * 60) {
      trackUsage("view", current.key, { seconds }, current.workspaceId, current.repo);
      trackUsage("session", "active", { seconds }, current.workspaceId);
    }
  }
  since = now;
}

export async function flushUsage(): Promise<void> {
  bookTime();
  if (pending.size === 0) return;
  const events = Array.from(pending.values()).map((event) => ({ ...event, seconds: Math.round(event.seconds) }));
  pending.clear();
  await usageRecord(events).catch(() => {});
}

// ----------------------------------------------------------------------- the command observer

let workspaceChatIds: (() => Record<string, unknown>) | null = null;

function chatSurface(args: Record<string, unknown>): ChatSurface {
  if (windowKind === "quick") return "quickAsk";
  const id = args.conversationId;
  if (typeof id === "string" && workspaceChatIds && id in workspaceChatIds()) return "workspace";
  return "chat";
}

let windowKind = "main";

function observe(cmd: string, args: Record<string, unknown>, ok: boolean, result: unknown) {
  const hits = usageHitsFor(cmd, args, ok, result, chatSurface);
  if (!hits) return;
  const repo = repoFromArgs(args) ?? (cmd.startsWith("chat") || cmd === "send_chat_message" ? null : repoInView());
  for (const hit of hits) {
    trackUsage(hit.kind, hit.key, hit.seconds ? { count: 1, seconds: hit.seconds } : {}, workspaceNow(), repo);
  }
}

let started = false;

function startCommon() {
  setInvokeObserver(observe);
  window.addEventListener("pagehide", () => void flushUsage());
  window.setInterval(() => void flushUsage(), FLUSH_MS);
  void import("../state/workspaceChatStore")
    .then(({ useWorkspaceChatStore }) => {
      workspaceChatIds = () => useWorkspaceChatStore.getState().byConversation;
    })
    .catch(() => {});
}

/**
 * A satellite window counts what is done in it — actions, chats, shortcuts — but not time: the main
 * window's clock is the one that says how long the app was in front.
 */
export function startSatelliteUsageTracking(kind: string) {
  if (started) return;
  started = true;
  windowKind = kind;
  startCommon();
  const flushWhenHidden = () => {
    if (document.visibilityState === "hidden") void flushUsage();
  };
  document.addEventListener("visibilitychange", flushWhenHidden);
}

/** Starts counting in the main window. Idempotent; called once from `App`'s boot batch. */
export function startUsageTracking() {
  if (started) return;
  started = true;
  startCommon();

  trackUsage("session", "launch");
  const ui = useUiStore.getState();
  current = { key: viewKey(ui.activeView, ui.apiWorkspace), workspaceId: workspaceNow(), repo: repoInView() };
  trackUsage("view", current.key, {}, current.workspaceId, current.repo);
  attending = isAttending();
  since = Date.now();
  const sendContext = () =>
    void usageSetContext(workspaceNow(), useWorkspaceStore.getState().activeProjectId ?? null).catch(() => {});
  sendContext();

  useUiStore.subscribe((state, previous) => {
    const next = viewKey(state.activeView, state.apiWorkspace);
    if (next !== viewKey(previous.activeView, previous.apiWorkspace)) {
      bookTime();
      current = { key: next, workspaceId: workspaceNow(), repo: repoInView() };
      trackUsage("view", next, {}, current.workspaceId, current.repo);
    }
    if (state.settingsOpen && !previous.settingsOpen) trackUsage("feature", "settings");
    if (state.settingsOpen && (state.settingsSection !== previous.settingsSection || !previous.settingsOpen)) {
      trackUsage("settings", state.settingsSection);
    }
    if (state.commandPaletteOpen && !previous.commandPaletteOpen) trackUsage("feature", "commandPalette");
    if (state.aiPanelOpen && !previous.aiPanelOpen) trackUsage("feature", "aiPanel");
    if (state.branchSwitcherOpen && !previous.branchSwitcherOpen) trackUsage("feature", "branchSwitcher");
  });

  useTerminalStore.subscribe((state, previous) => {
    if (state.panelOpen && !previous.panelOpen) trackUsage("feature", "terminal");
  });

  useWorkspaceStore.subscribe((state, previous) => {
    const workspaceChanged = state.activeWorkspaceId !== previous.activeWorkspaceId;
    const repoChanged = state.activeProjectId !== previous.activeProjectId;
    if (!workspaceChanged && !repoChanged) return;
    bookTime();
    if (current) current = { ...current, workspaceId: state.activeWorkspaceId ?? null, repo: repoInView() };
    if (workspaceChanged && state.activeWorkspaceId) trackUsage("feature", "workspaceSwitch");
    if (repoChanged && state.activeProjectId) trackUsage("feature", "repoSwitch", {}, workspaceNow(), state.activeProjectId);
    sendContext();
  });

  const onAttention = () => {
    bookTime();
    attending = isAttending();
    if (document.visibilityState === "hidden") void flushUsage();
  };
  window.addEventListener("focus", onAttention);
  window.addEventListener("blur", onAttention);
  document.addEventListener("visibilitychange", onAttention);
}

/** For tests: forget what is queued and the started flag. */
export function resetUsageTrackingForTests() {
  setInvokeObserver(null);
  pending.clear();
  started = false;
  current = null;
}

export function pendingUsageForTests(): UsageEvent[] {
  return Array.from(pending.values());
}
