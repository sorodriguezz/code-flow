import type { EditorGroup } from "./editorGroups";
import { isMainWindow } from "./windowIdentity";

/**
 * What the editor and its explorer looked like in each repository this window has shown — kept so a
 * switch to another repository, or to another workspace, and back finds them as they were left.
 *
 * Switching used to start every repository from nothing: no tabs, every folder in the tree closed,
 * no row selected (user report, 2026-11-12). Two things caused it, and this module answers both:
 *
 * - **A repository switch** emptied the editor unless it had unsaved tabs, which are parked (see
 *   `lib/parkedEditors`). Parking keeps whole buffers and their undo history, which is why it is
 *   reserved for unsaved work; what is remembered here is only the *shape* — which files, in which
 *   groups, which one on top — and the files are read again from disk on the way back.
 * - **A workspace switch** clears the active project for a moment, and `App` unmounts every
 *   repository view while there is none, so anything held in the editor's own state went with it.
 *   This lives at module level for that reason: it outlives the component.
 *
 * And where each file was left: its caret, selection, scroll and folds (Monaco's view state), so
 * coming back to a file — after a switch, or after a restart — lands where you were reading rather
 * than on line 1.
 *
 * Kept in `localStorage` as well, so all of it survives a restart (user report, 2026-11-12). Not in
 * settings like `recentFilesStore`: those are read asynchronously, and the editor needs its memory
 * synchronously, in the first render after launch, or it would paint empty and then jump. Written
 * shortly after every change rather than on quit, because nothing tells a Tauri webview reliably
 * that it is about to go — a ⌘Q fires no `beforeunload`.
 *
 * Nothing here is the user's work — unsaved text lives in the draft journal — so losing it costs a
 * layout, never an edit; a store that cannot be read or written just means starting from nothing.
 */

/** Repositories remembered at all; the one left longest ago goes first. */
const LIMIT = 30;
/** Files whose view state is remembered, across every repository; the least recently left go first. */
const VIEW_LIMIT = 300;
const STORAGE_KEY = "cf.editorMemory.v1";
/** Writes are batched: a scroll is one write after it settles, not one per frame. */
const PERSIST_DELAY_MS = 400;

/** One open file, as much of it as can be put back without its text. */
export interface RememberedTab<V extends string = string> {
  path: string;
  preview: boolean;
  viewMode: V;
}

/** The editor of one repository, without any buffer in it. */
export interface RememberedEditor<V extends string = string> {
  tabs: RememberedTab<V>[];
  groups: EditorGroup[];
  activeGroupId: string;
}

/** The explorer of one repository. */
export interface RememberedExplorer {
  /** Folders open, by repo-relative path. */
  expanded: string[];
  /** File rows whose nest is unfolded — `FileTree`'s `nestOpen`. */
  nestOpen: string[];
  /** The clicked row, where a new file would land. */
  focus: { path: string; isDir: boolean };
  scrollTop: number;
}

const editors = new Map<string, RememberedEditor>();
const explorers = new Map<string, RememberedExplorer>();
/**
 * Monaco's `saveViewState()` per model URI (`lib/editorModel` — the project id is in it, so two
 * repositories' `src/main.ts` never share one). Opaque here: it is plain JSON, and Monaco validates
 * it against the model on the way back in, clamping a caret past the end of a file that shrank and
 * dropping folds that no longer match its lines.
 */
const viewStates = new Map<string, unknown>();

/** `value` under `key`, as the newest entry, with the oldest dropped past the limit. */
function put<T>(map: Map<string, T>, key: string, value: T, limit = LIMIT) {
  map.delete(key);
  map.set(key, value);
  schedulePersist();
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The editor's shape with the tabs `keep` refuses taken out of it — out of the registry and out of
 * every group, with each group's top tab moved to one still there. `null` when nothing is left: an
 * editor left empty comes back empty, which needs no entry.
 */
export function editorShape<V extends string>(
  slice: { tabs: RememberedTab<V>[]; groups: EditorGroup[]; activeGroupId: string },
  keep: (path: string) => boolean,
): RememberedEditor<V> | null {
  const tabs = slice.tabs
    .filter((tab) => keep(tab.path))
    .map((tab) => ({ path: tab.path, preview: tab.preview, viewMode: tab.viewMode }));
  if (tabs.length === 0) return null;
  const open = new Set(tabs.map((tab) => tab.path));
  const groups = slice.groups.map((group) => {
    const paths = group.paths.filter((path) => open.has(path));
    const activePath = group.activePath !== null && open.has(group.activePath) ? group.activePath : (paths[0] ?? null);
    return { ...group, paths, pinned: group.pinned.filter((path) => open.has(path)), activePath };
  });
  const activeGroupId = groups.some((group) => group.id === slice.activeGroupId) ? slice.activeGroupId : groups[0].id;
  return { tabs, groups, activeGroupId };
}

export function rememberEditor(repoPath: string, editor: RememberedEditor | null) {
  if (editor) put(editors, repoPath, editor);
  else if (editors.delete(repoPath)) schedulePersist();
}

export function recallEditor(repoPath: string | null | undefined): RememberedEditor | undefined {
  return repoPath ? editors.get(repoPath) : undefined;
}

export function rememberExplorer(repoPath: string, explorer: RememberedExplorer) {
  put(explorers, repoPath, explorer);
}

export function recallExplorer(repoPath: string): RememberedExplorer | undefined {
  return explorers.get(repoPath);
}

export function rememberViewState(modelUri: string, state: unknown) {
  if (state) put(viewStates, modelUri, state, VIEW_LIMIT);
}

export function recallViewState(modelUri: string): unknown {
  return viewStates.get(modelUri);
}

/** Tests only: start from nothing. */
export function forgetAllEditorMemory() {
  editors.clear();
  explorers.clear();
  viewStates.clear();
}

// ── Across restarts ──────────────────────────────────────────────────────────────────────────────

interface StoredMemory {
  editors: [string, RememberedEditor][];
  explorers: [string, RememberedExplorer][];
  views: [string, unknown][];
}

const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A view mode worth coming back to. A diff compared the buffer against something that was on
 *  screen then — after a restart there is nothing left to compare, so the file opens as code. */
const RESTORABLE_MODES = new Set(["code", "preview", "split"]);

function readEditor(value: unknown): RememberedEditor | null {
  if (!isRecord(value) || !Array.isArray(value.tabs) || !Array.isArray(value.groups) || !isString(value.activeGroupId)) {
    return null;
  }
  const tabs: RememberedTab[] = [];
  for (const tab of value.tabs) {
    if (!isRecord(tab) || !isString(tab.path)) continue;
    const viewMode = isString(tab.viewMode) && RESTORABLE_MODES.has(tab.viewMode) ? tab.viewMode : "code";
    tabs.push({ path: tab.path, preview: tab.preview === true, viewMode });
  }
  const groups: EditorGroup[] = [];
  for (const group of value.groups) {
    if (
      !isRecord(group) ||
      !isString(group.id) ||
      !isString(group.column) ||
      !isStringArray(group.paths) ||
      !isStringArray(group.pinned) ||
      !(group.activePath === null || isString(group.activePath))
    ) {
      return null;
    }
    groups.push({ id: group.id, column: group.column, paths: group.paths, pinned: group.pinned, activePath: group.activePath });
  }
  // Through `editorShape`, so a group can only ever name a tab that is in the registry — the same
  // guarantee the in-memory copy has, now for text that came from outside the program.
  return groups.length > 0 ? editorShape({ tabs, groups, activeGroupId: value.activeGroupId }, () => true) : null;
}

function readExplorer(value: unknown): RememberedExplorer | null {
  if (!isRecord(value) || !isStringArray(value.expanded) || !isStringArray(value.nestOpen) || !isRecord(value.focus)) {
    return null;
  }
  const { path, isDir } = value.focus;
  if (!isString(path) || typeof isDir !== "boolean") return null;
  const scrollTop = typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) ? Math.max(0, value.scrollTop) : 0;
  return { expanded: value.expanded, nestOpen: value.nestOpen, focus: { path, isDir }, scrollTop };
}

/** What was stored, entry by entry — anything that is not what this version writes is skipped, and
 *  text that is not JSON at all is an empty memory, never an error. */
export function parseEditorMemory(raw: string | null | undefined): StoredMemory {
  const empty: StoredMemory = { editors: [], explorers: [], views: [] };
  if (!raw) return empty;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!isRecord(value)) return empty;
  const entries = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is [string, unknown] => Array.isArray(entry) && isString(entry[0])) : [];
  const out = empty;
  for (const [key, editor] of entries(value.editors)) {
    const read = readEditor(editor);
    if (read) out.editors.push([key, read]);
  }
  for (const [key, explorer] of entries(value.explorers)) {
    const read = readExplorer(explorer);
    if (read) out.explorers.push([key, read]);
  }
  for (const [key, view] of entries(value.views)) {
    if (isRecord(view)) out.views.push([key, view]);
  }
  out.editors = out.editors.slice(-LIMIT);
  out.explorers = out.explorers.slice(-LIMIT);
  out.views = out.views.slice(-VIEW_LIMIT);
  return out;
}

/** Everything remembered, oldest first — the order the maps hold it in, and rebuild it from. */
export function serializeEditorMemory(): string {
  const stored: StoredMemory = { editors: [...editors], explorers: [...explorers], views: [...viewStates] };
  return JSON.stringify(stored);
}

/** Reads `raw` into the maps, under whatever this session has already remembered. */
export function loadEditorMemory(raw: string | null | undefined) {
  const stored = parseEditorMemory(raw);
  const under = <T>(map: Map<string, T>, entries: [string, T][]) => {
    const session = [...map];
    map.clear();
    for (const [key, value] of [...entries, ...session]) {
      map.delete(key);
      map.set(key, value);
    }
  };
  under(editors, stored.editors);
  under(explorers, stored.explorers);
  under(viewStates, stored.views);
}

function storage(): Storage | null {
  try {
    // `window` first: Node 22+ defines a `localStorage` global of its own that warns on every touch,
    // and a test run is not a place this memory has anywhere to go.
    return typeof window === "undefined" || typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistNow() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  try {
    storage()?.setItem(STORAGE_KEY, serializeEditorMemory());
  } catch {
    // Over quota, or storage refused: the session keeps its memory, and the next launch starts from
    // whatever was written last.
  }
}

function schedulePersist() {
  // Only the main window writes. A floating editor (`satellite`) shares this origin's storage but
  // holds its own copy of the maps from its own launch, and writing that whole copy back would put
  // the main window's layout back to how it was when the floating one opened.
  if (!isMainWindow() || !storage()) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, PERSIST_DELAY_MS);
}

// At import, so the very first render after a launch already has it.
try {
  loadEditorMemory(storage()?.getItem(STORAGE_KEY));
} catch {
  // A store that cannot be read is an empty memory.
}

// Best effort on the way out — a window hidden or closed writes what is still waiting rather than
// losing its last 400ms. Not the mechanism (see the header): a ⌘Q may fire neither.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  const flush = () => {
    if (persistTimer) persistNow();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
