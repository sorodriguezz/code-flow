import { create } from "zustand";
// Type-only: this module is part of the shell's boot path (`App` installs the host), and the editor
// it speaks for is a lazy chunk with Monaco in it. A value import of `EditorPane` here would put the
// whole editor on the critical path of every launch.
import type { OpenTab } from "../components/editor/EditorPane";
import { listenWindowMessages, onWindowMessage, sendTo } from "./windowBus";
import { MAIN_LABEL, WINDOW } from "./windowIdentity";
import { registerUnsavedProvider } from "./unsavedWork";
import { getProject, writeEditorFile } from "./tauri/commands";
import { focusSatellite, showMainWindow } from "./tauri/windows";
import { useWindowStore } from "../state/windowStore";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useUiStore } from "../state/uiStore";

/**
 * Floating editors: one tab of the editor torn out into a window of its own — VS Code's floating
 * editor windows, and an island like the app and repository windows (`windows.rs`, kind `file`).
 *
 * # The rule: it moves, it never duplicates
 *
 * The same rule every island keeps. A file shown in a floating window is **not** also open in the
 * main window's editor: two editors on one file in two webviews are two buffers, and whichever was
 * saved second would quietly win. So detaching hands the tab over — text, unsaved edits, the
 * version it was read at, how it was being viewed — and closing the window hands it back. Opening a
 * file the main window has handed away brings its window forward instead of opening a second copy
 * (`islandHolding`), exactly as a rail icon whose app is elsewhere does.
 *
 * # The handover, and why it is acknowledged both ways
 *
 * A buffer in flight between two webviews must never exist in neither.
 *
 * - **Out.** The main window keeps the tab in its `outbox` from the moment it detaches it until the
 *   floating window says it has it (`island-taken`). The window asks for it as it boots
 *   (`island-claim`), because only then is there a page to receive it; until it answers, the copy
 *   here is the only one, and a window that dies before answering gives it back to the editor
 *   (see `installIslandHost`). A window put back from the tray asks the same question and gets the
 *   tab the main window was given when it closed — the same path, nothing special.
 * - **Back.** Closing the window sends the tab home (`island-return`) and waits for the main window
 *   to say it has it (`island-returned`) before letting the window go. No answer, no close: the
 *   window stays open with the buffer in it and says so.
 *
 * What lands in the main window lands in `useIslandInbox`, and the editor takes it from there for
 * the project it is showing. A file of another project waits for that project, protected by the
 * quit question like any unsaved tab (the `editor-islands` provider below).
 */

/** A floating editor's id in the satellite registry — `"<project id>:<path>"`. A project id is a
 *  UUID, so the first colon is always the separator, whatever the path holds. */
export function fileIslandRef(projectId: string, path: string): string {
  return `${projectId}:${path}`;
}

export function parseFileIslandRef(ref: string): { projectId: string; path: string } | null {
  const cut = ref.indexOf(":");
  if (cut <= 0 || cut === ref.length - 1) return null;
  return { projectId: ref.slice(0, cut), path: ref.slice(cut + 1) };
}

/** What crosses between the windows: the editor's own tab, which is plain data throughout. */
export type IslandTab = OpenTab;

/** How long a floating editor waits for its buffer before reading the file from disk instead. Long,
 *  on purpose: the answer is a local IPC round trip, and giving up early is the one outcome that can
 *  leave unsaved text behind — the window would show the disk while the edits sat in the outbox. */
const CLAIM_TIMEOUT_MS = 15_000;

/** How long a closing floating editor waits for the main window to say it has the tab. */
const RETURN_TIMEOUT_MS = 5_000;

// ===================== the main window's side =====================

interface Handed {
  tab: IslandTab;
  repoPath: string;
}

/** Tabs handed to a floating editor that has not yet said it has them, by ref. */
const outbox = new Map<string, Handed>();

/** A tab given back by a floating editor, waiting for the main window's editor to take it. */
export interface ReturnedTab {
  projectId: string;
  repoPath: string;
  tab: IslandTab;
}

/** What came back from floating editors and has not been reopened yet. A store so the editor
 *  re-renders when something arrives; see `takeReturns`. */
export const useIslandInbox = create<{ returned: ReturnedTab[] }>(() => ({ returned: [] }));

/** Takes the returns waiting for one project, removing them from the inbox. */
export function takeReturns(projectId: string): ReturnedTab[] {
  const all = useIslandInbox.getState().returned;
  const mine = all.filter((entry) => entry.projectId === projectId);
  if (mine.length > 0) useIslandInbox.setState({ returned: all.filter((entry) => entry.projectId !== projectId) });
  return mine;
}

/**
 * The main window's editor, as a claim sees it: a way to take a file out of it.
 *
 * Asked when a floating editor claims a file that is not in the outbox — the window put back from
 * the tray, whose file came home when it closed and now has to leave again.
 */
export interface IslandHost {
  take: (projectId: string, path: string) => Handed | null;
}

let host: IslandHost | null = null;

export function registerIslandHost(next: IslandHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/** Keeps the tab for the floating editor about to open on it. Called *before* the window is asked
 *  for, so a claim can never arrive ahead of it. */
export function stashForIsland(projectId: string, repoPath: string, tab: IslandTab): void {
  outbox.set(fileIslandRef(projectId, tab.path), { tab, repoPath });
}

/** The tab as it is now, for a stash the window has not collected yet — what was typed between
 *  the drop and the window opening goes with it. */
export function refreshStash(projectId: string, tab: IslandTab): void {
  const ref = fileIslandRef(projectId, tab.path);
  const held = outbox.get(ref);
  if (held) outbox.set(ref, { ...held, tab });
}

/** Takes a stash back — the window was refused (the limit), so the tab never left. */
export function dropStash(projectId: string, path: string): void {
  outbox.delete(fileIslandRef(projectId, path));
}

/**
 * The floating editor holding this file: its label, `""` while one is still opening on it, or
 * `null` when no window has it — which is the only answer that lets the main window open it.
 */
export function islandHolding(projectId: string, path: string): string | null {
  const ref = fileIslandRef(projectId, path);
  const window = useWindowStore.getState().satellites.find((s) => s.kind === "file" && s.ref_id === ref);
  if (window) return window.label;
  return outbox.has(ref) ? "" : null;
}

/** Every path of a project that a floating editor holds or is about to — whose crash-journal rows
 *  the main window must leave alone, since it no longer has their buffers. */
export function islandPaths(projectId: string): Set<string> {
  const paths = new Set<string>();
  for (const window of useWindowStore.getState().satellites) {
    if (window.kind !== "file") continue;
    const parsed = parseFileIslandRef(window.ref_id);
    if (parsed?.projectId === projectId) paths.add(parsed.path);
  }
  for (const ref of outbox.keys()) {
    const parsed = parseFileIslandRef(ref);
    if (parsed?.projectId === projectId) paths.add(parsed.path);
  }
  return paths;
}

/** Brings the floating editor holding a file forward, and at a line when there is one. */
export function showInIsland(label: string, line?: number, column?: number): void {
  // Still opening: it is about to be on screen anyway, and it has no page yet to take a jump.
  if (!label) return;
  void focusSatellite(label).catch(() => {});
  if (line) void sendTo(label, { kind: "island-reveal", line, column }).catch(() => {});
}

/** Tells the floating editor holding a file that the explorer moved or deleted it. */
export function recallIsland(label: string, movedTo: string | null): void {
  if (label) void sendTo(label, { kind: "island-recall", movedTo }).catch(() => {});
}

/** The project's name for the quit question, from whatever this window has loaded. */
function projectName(projectId: string, repoPath: string): string {
  for (const projects of Object.values(useWorkspaceStore.getState().projectsByWorkspace)) {
    const found = projects.find((p) => p.id === projectId);
    if (found) return found.name;
  }
  return repoPath.split(/[\\/]/).pop() || repoPath;
}

/** Puts the main window on the project, and on the Editor — the return button's promise is that
 *  the file is on screen afterwards, not merely somewhere. */
async function focusEditorOn(projectId: string): Promise<void> {
  const workspaces = useWorkspaceStore.getState();
  if (workspaces.activeProjectId !== projectId) {
    const workspaceId =
      workspaces.workspaceOfProject(projectId) ??
      (await getProject(projectId).catch(() => null))?.workspace_id ??
      null;
    // A project removed since has nowhere to show it; its tab waits in the inbox, which the quit
    // question still covers.
    if (!workspaceId) return;
    await workspaces.focusProject(workspaceId, projectId);
  }
  useUiStore.getState().setActiveView("editor");
}

const dirty = (tab: IslandTab) => !tab.loading && tab.content !== tab.originalContent;

let installed = false;

/**
 * The main window's half, installed once at boot from `App`.
 *
 * Here rather than in the editor because the editor is a lazy view that may not be mounted — a
 * floating editor closing while the main window shows the graph still has somewhere to send its tab.
 */
export function installIslandHost(): void {
  if (!WINDOW.main || installed) return;
  installed = true;

  onWindowMessage((message, from) => {
    switch (message.kind) {
      case "island-claim": {
        const ref = fileIslandRef(message.projectId, message.path);
        // Wherever this window has the file: on its way out, back from a window and not reopened
        // yet (its project is not the one on screen), or open in the editor.
        let handed = outbox.get(ref);
        if (!handed) {
          const inbox = useIslandInbox.getState().returned;
          const waiting = inbox.find(
            (entry) => entry.projectId === message.projectId && entry.tab.path === message.path,
          );
          if (waiting) {
            useIslandInbox.setState({ returned: inbox.filter((entry) => entry !== waiting) });
            handed = { tab: waiting.tab, repoPath: waiting.repoPath };
          } else {
            handed = host?.take(message.projectId, message.path) ?? undefined;
          }
          if (handed) outbox.set(ref, handed);
        }
        void sendTo(from, { kind: "island-handoff", requestId: message.requestId, tab: handed?.tab ?? null }).catch(
          () => {},
        );
        break;
      }
      case "island-taken":
        outbox.delete(message.ref);
        break;
      case "island-return": {
        const { projectId, repoPath, tab } = message;
        // The newest copy wins — a window closed twice in a row must not leave its first answer.
        useIslandInbox.setState((state) => ({
          returned: [
            ...state.returned.filter((entry) => !(entry.projectId === projectId && entry.tab.path === tab.path)),
            { projectId, repoPath, tab },
          ],
        }));
        void sendTo(from, { kind: "island-returned", requestId: message.requestId }).catch(() => {});
        if (message.reveal) {
          void showMainWindow().catch(() => {});
          void focusEditorOn(projectId);
        }
        break;
      }
      case "island-open":
        // A go-to-definition from a floating editor: the main window's editor opens it — or, if
        // another floating editor holds that file, brings that one forward (see `openFile`).
        void showMainWindow().catch(() => {});
        void focusEditorOn(message.projectId).then(() =>
          useUiStore.getState().openInEditor(message.path, message.line),
        );
        break;
    }
  });

  // A floating editor gone before it took its tab — closed while it was still opening, or its page
  // died — leaves the outbox copy as the only one. It comes home rather than waiting forever.
  useWindowStore.subscribe((state, previous) => {
    for (const window of previous.satellites) {
      if (window.kind !== "file" || state.satellites.some((now) => now.label === window.label)) continue;
      const handed = outbox.get(window.ref_id);
      const parsed = parseFileIslandRef(window.ref_id);
      if (!handed || !parsed) continue;
      outbox.delete(window.ref_id);
      useIslandInbox.setState((inbox) => ({
        returned: [...inbox.returned, { projectId: parsed.projectId, repoPath: handed.repoPath, tab: handed.tab }],
      }));
    }
  });

  // Tabs on their way home, or on their way out, are nowhere else: the quit question lists them,
  // and "save all" writes them where they belong, checked against the version they were read at.
  registerUnsavedProvider({
    id: "editor-islands",
    unsaved: () => [
      ...useIslandInbox
        .getState()
        .returned.filter((entry) => dirty(entry.tab))
        .map((entry) => ({ label: entry.tab.path, detail: projectName(entry.projectId, entry.repoPath) })),
      ...[...outbox.entries()]
        .filter(([, handed]) => dirty(handed.tab))
        .map(([ref, handed]) => ({
          label: handed.tab.path,
          detail: projectName(parseFileIslandRef(ref)?.projectId ?? "", handed.repoPath),
        })),
    ],
    saveAll: async () => {
      const failed: string[] = [];
      const returned = useIslandInbox.getState().returned;
      const saved = await Promise.all(
        returned.map(async (entry) => {
          if (!dirty(entry.tab)) return entry;
          try {
            const version = await writeEditorFile(entry.repoPath, entry.tab.path, entry.tab.content, entry.tab.version);
            return { ...entry, tab: { ...entry.tab, originalContent: entry.tab.content, version } };
          } catch {
            failed.push(entry.tab.path);
            return entry;
          }
        }),
      );
      useIslandInbox.setState({ returned: saved });
      // In flight to a window that has not taken it yet: that window lists it as its own the moment
      // it does, and saves it from there.
      for (const [, handed] of outbox) if (dirty(handed.tab)) failed.push(handed.tab.path);
      return failed;
    },
  });
}

// ===================== the floating editor's side =====================

/** What the floating window's title bar shows and does — kept by the editor inside it. */
interface FileIslandState {
  /** The file, once the editor has it. */
  path: string | null;
  dirty: boolean;
  /** Sends the file back to the main window and closes this one. `reveal` is the return button:
   *  the main window comes forward on the file. Registered by the editor. */
  giveBack: ((reveal: boolean) => Promise<void>) | null;
}

export const useFileIslandStore = create<FileIslandState>(() => ({ path: null, dirty: false, giveBack: null }));

/**
 * Asks the main window for this window's buffer. Resolves to the tab it was holding, or `null` when
 * it held none — the file is then read from disk. Acknowledged on arrival, which is what lets the
 * main window let go of its copy.
 */
export async function claimFromMain(projectId: string, path: string): Promise<IslandTab | null> {
  const requestId = crypto.randomUUID();
  let answer: (tab: IslandTab | null) => void = () => {};
  const answered = new Promise<IslandTab | null>((resolve) => (answer = resolve));
  let stop: (() => void) | null = null;
  try {
    // Listening before asking: an answer that beats the listener would be lost, and the window
    // would read the disk while the edits sat in the main window's outbox.
    stop = await listenWindowMessages((message) => {
      if (message.kind === "island-handoff" && message.requestId === requestId) answer(message.tab);
    });
    await sendTo(MAIN_LABEL, { kind: "island-claim", requestId, projectId, path });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tab = await Promise.race([
      answered,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CLAIM_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (tab) void sendTo(MAIN_LABEL, { kind: "island-taken", ref: fileIslandRef(projectId, path) }).catch(() => {});
    return tab;
  } catch {
    return null;
  } finally {
    stop?.();
  }
}

/**
 * Sends a tab home, and resolves `true` once the main window has it. `false` — no answer, or the
 * message could not be sent — means the tab is still only here, and the window must not close.
 */
export async function returnToMain(
  projectId: string,
  repoPath: string,
  tab: IslandTab,
  reveal: boolean,
): Promise<boolean> {
  const requestId = crypto.randomUUID();
  let answer: () => void = () => {};
  const answered = new Promise<boolean>((resolve) => (answer = () => resolve(true)));
  let stop: (() => void) | null = null;
  try {
    stop = await listenWindowMessages((message) => {
      if (message.kind === "island-returned" && message.requestId === requestId) answer();
    });
    await sendTo(MAIN_LABEL, { kind: "island-return", requestId, projectId, repoPath, tab, reveal });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = await Promise.race([
      answered,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), RETURN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    return ok;
  } catch {
    return false;
  } finally {
    stop?.();
  }
}

/** Opens another file of the repository in the main window, and brings it forward. */
export function openInMainWindow(projectId: string, path: string, line?: number, column?: number): void {
  void sendTo(MAIN_LABEL, { kind: "island-open", projectId, path, line, column }).catch(() => {});
}
