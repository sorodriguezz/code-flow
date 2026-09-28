import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { isJsonObject, serializeJson, type JsonObject } from "../lib/notebook/json";
import {
  cellOutputs,
  cellSource,
  changeCellType,
  clearAllOutputs,
  deleteCell,
  executionCount,
  insertCell,
  moveCell,
  newCell,
  notebookKernelspec,
  notebookLanguage,
  parseNotebook,
  serializeNotebook,
  setExecutionCount,
  setNotebookMetadata,
  setOutputs,
  setSource,
  type CellType,
  type NotebookCell,
  type NotebookDoc,
} from "../lib/notebook/nbformat";
import { applyOutputMessage, newOutputState, outputText, type OutputState } from "../lib/notebook/outputs";
import { stripAnsi } from "../lib/notebook/ansi";
import { notebookHost, notebookKey } from "../lib/notebook/host";
import {
  discoverKernels,
  executeInKernel,
  interruptKernel,
  notebookAi,
  onKernelEvents,
  replyToInput,
  restartKernel,
  shutdownKernel,
  startKernel,
  type KernelChoice,
  type KernelDiscovery,
  type KernelEvent,
  type NotebookAssistRequest,
  type NotebookCellContext,
} from "../lib/tauri/notebookCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { isCancellation, newRunId, useAiRunStore } from "./aiRunStore";
import { notify } from "./notificationStore";
import { pushErrorToast } from "./toastStore";
import { translate, useLanguageStore } from "./languageStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Every open notebook's working state: the parsed document, its kernel, which cells are queued or
 * running, the `input()` it is waiting on, and the AI runs on its cells.
 *
 * **Why a store and not the notebook view.** The view is the shortest-lived thing here: it unmounts
 * when its tab stops being the active one, when the pane is closed, when the window moves to
 * another project. The kernel does not stop for any of that, and neither do its outputs — they land
 * in the file (through `lib/notebook/host`) whether or not anyone is looking. So a session lives
 * from the moment a notebook is first shown until its tab is closed (`syncOpenNotebooks`).
 *
 * **The file is the tab's.** A session never holds an edit the tab does not: every change is
 * serialized into the tab at once (kernel output a few milliseconds later, batched), which is what
 * makes the dirty dot, the checked save, the crash journal and the quit guard work for notebooks
 * with nothing of their own. Changes that come the other way — a reload, the raw JSON view — are
 * noticed by comparing the tab's text with the last text written ([`current`]).
 *
 * **Runs are isolated** the way every AI run in this app is (see `aiRunStore`): an AI answer is
 * filed under the notebook and the cell it was asked about, with the workspace stamped before the
 * first `await`, and dropped rather than applied if either is gone when it lands.
 */

export type KernelStatus = "starting" | "idle" | "busy" | "restarting" | "unresponsive" | "dead";

export interface NotebookKernel {
  /** Minted here before the start is asked for, so no event can arrive for an id we do not know. */
  kernelId: string;
  choice: KernelChoice;
  status: KernelStatus;
  /** The kernel's `kernel_info_reply` content. */
  info: JsonObject | null;
  /** Why it is dead: a start that failed, or a crash with the kernel's last words. */
  error: string | null;
}

export interface CellRun {
  status: "queued" | "running";
  /** The `execute_request` id — every message about this run carries it as its parent. */
  msgId: string;
}

export interface PendingInput {
  cellKey: string | null;
  prompt: string;
  password: boolean;
}

export interface DeletedCell {
  cell: NotebookCell;
  index: number;
}

export type NotebookAiAction = "generate" | "explain" | "fix" | "document";

export interface NotebookAiRun {
  runId: string;
  action: NotebookAiAction;
  /** Stamped before the request went out — see the run-isolation note above. */
  workspaceId: string | null;
  status: "running" | "ready" | "failed";
  /** The cell's source when it was asked about, for the diff a code answer is shown as. */
  before: string;
  answer: string | null;
  error: string | null;
}

export interface NotebookSession {
  key: string;
  repoPath: string;
  path: string;
  projectId: string;
  workspaceId: string | null;
  /** `null` while the text is not a notebook this editor can read — see `parseError`. */
  doc: NotebookDoc | null;
  parseError: string | null;
  kernel: NotebookKernel | null;
  discovery: KernelDiscovery | null;
  discovering: boolean;
  /** The kernel picked for this notebook — by hand, or remembered from last time. */
  choiceId: string | null;
  runs: Record<string, CellRun>;
  input: PendingInput | null;
  selected: string | null;
  /** The cell in edit mode (Jupyter's), or `null` for command mode. */
  editing: string | null;
  /** Deleted cells, most recent last — what Z and the toolbar's undo bring back. */
  deleted: DeletedCell[];
  ai: Record<string, NotebookAiRun>;
  /** The "generate a cell" prompt, open below this cell (`null`: at the end). */
  generateAt: { cellKey: string | null } | null;
  /** A run found no kernel to start — the notebook offers to install ipykernel instead. */
  noKernel: boolean;
}

export type NotebookMode = "notebook" | "json";

interface NotebookState {
  sessions: Record<string, NotebookSession>;
  /** The notebook, or its file as the JSON it is — per file, like a tab's view mode, and apart from
   *  the session: the toggle is in the tab strip, where it can be pressed before the notebook view
   *  (a lazy chunk) has made one. */
  modes: Record<string, NotebookMode>;
  /** The notebook in the focused pane, for the Editor's status line. */
  focusedKey: string | null;
}

export const useNotebookStore = create<NotebookState>(() => ({ sessions: {}, modes: {}, focusedKey: null }));

const get = () => useNotebookStore.getState();

function patch(key: string, update: Partial<NotebookSession> | ((session: NotebookSession) => Partial<NotebookSession>)): void {
  useNotebookStore.setState((state) => {
    const session = state.sessions[key];
    if (!session) return state;
    const changes = typeof update === "function" ? update(session) : update;
    return { sessions: { ...state.sessions, [key]: { ...session, ...changes } } };
  });
}

// ---------------------------------------------------------------------------------------------
// The document and the tab
// ---------------------------------------------------------------------------------------------

/** The text last written to (or read from) each notebook's tab. */
const written = new Map<string, string>();
/** The serialization of each session's document, which may be ahead of `written` for a moment. */
const serialized = new Map<string, string>();
/** Pending batched writes of kernel output. */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
/** How long kernel output is gathered before it is written to the tab. Output is written at most
 *  this often, which keeps a loop printing thousands of lines from re-rendering the editor for
 *  each; an edit by hand is written at once. */
const OUTPUT_WRITE_MS = 80;
/** What running needs remembered between messages and the file does not hold. */
const outputStates = new Map<string, OutputState>();

function outputStateOf(key: string): OutputState {
  let state = outputStates.get(key);
  if (!state) {
    state = newOutputState();
    outputStates.set(key, state);
  }
  return state;
}

function writeNow(key: string): void {
  const timer = pendingWrites.get(key);
  if (timer !== undefined) clearTimeout(timer);
  pendingWrites.delete(key);
  const session = get().sessions[key];
  const text = serialized.get(key);
  if (!session || text === undefined || written.get(key) === text) return;
  const host = notebookHost(session.repoPath);
  // No tab to write into — its project's editor is parked. The text waits here and goes in when the
  // notebook is shown again (see `sync`).
  if (!host || host.read(session.path) === null) return;
  written.set(key, text);
  host.write(session.path, text);
}

function commit(key: string, doc: NotebookDoc, lazy = false): void {
  serialized.set(key, serializeNotebook(doc));
  patch(key, { doc, parseError: null });
  if (!lazy) {
    writeNow(key);
  } else if (!pendingWrites.has(key)) {
    pendingWrites.set(key, setTimeout(() => writeNow(key), OUTPUT_WRITE_MS));
  }
}

/** Takes text that arrived from outside — a reload, the raw JSON view, a restored draft — as the
 *  notebook. Whatever this session had not written yet loses to it. */
function adopt(key: string, text: string): void {
  const timer = pendingWrites.get(key);
  if (timer !== undefined) clearTimeout(timer);
  pendingWrites.delete(key);
  written.set(key, text);
  serialized.set(key, text);
  const session = get().sessions[key];
  try {
    const doc = parseNotebook(text, session?.doc ?? null);
    patch(key, { doc, parseError: null });
  } catch (e) {
    patch(key, { doc: null, parseError: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * The session's document, first brought up to date with its tab: what the tab holds is the truth,
 * and a difference from the last text written means someone else wrote it.
 */
function current(key: string): NotebookDoc | null {
  const session = get().sessions[key];
  if (!session) return null;
  const text = notebookHost(session.repoPath)?.read(session.path);
  if (text != null && text !== written.get(key)) adopt(key, text);
  return get().sessions[key]?.doc ?? null;
}

function edit(key: string, update: (doc: NotebookDoc) => NotebookDoc): NotebookDoc | null {
  const doc = current(key);
  if (!doc) return null;
  const next = update(doc);
  if (next !== doc) commit(key, next);
  return next;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return serializeJson(a as never, "") === serializeJson(b as never, "");
}

// ---------------------------------------------------------------------------------------------
// Kernel events
// ---------------------------------------------------------------------------------------------

/** Which session each kernel belongs to. */
const kernelSessions = new Map<string, string>();
/** Execution id → the cell it runs, per session. Kept until the kernel goes idle for it, since
 *  outputs may still arrive after the reply. */
const executions = new Map<string, Map<string, string>>();

function executionsOf(key: string): Map<string, string> {
  let map = executions.get(key);
  if (!map) {
    map = new Map();
    executions.set(key, map);
  }
  return map;
}

export interface EventReduction {
  doc: NotebookDoc | null;
  kernel: NotebookKernel | null;
  runs: Record<string, CellRun>;
  input: PendingInput | null;
  docChanged: boolean;
}

/**
 * One batch of a kernel's events applied to a notebook — outputs into cells, execution counts,
 * queued → running → done, `input()` requests, the kernel's own ups and downs. Pure apart from
 * `cells` (execution id → cell, updated as executions finish) and `state`.
 */
export function reduceKernelEvents(
  start: EventReduction,
  events: KernelEvent[],
  cells: Map<string, string>,
  state: OutputState,
): EventReduction {
  let { doc, kernel, runs, input } = start;
  let docChanged = false;
  const setRuns = (next: Record<string, CellRun>) => {
    runs = next;
  };
  for (const event of events) {
    if (!kernel || event.kernelId !== kernel.kernelId) continue;
    if (event.type === "lifecycle") {
      const life = event.lifecycle;
      switch (life.state) {
        case "starting":
          kernel = { ...kernel, status: "starting", error: null };
          break;
        case "ready":
          kernel = { ...kernel, status: "idle", info: life.info, error: null };
          break;
        case "restarting":
          kernel = { ...kernel, status: "restarting" };
          setRuns({});
          cells.clear();
          input = null;
          break;
        case "unresponsive":
          kernel = { ...kernel, status: "unresponsive" };
          break;
        case "responsive":
          kernel = { ...kernel, status: Object.keys(runs).length > 0 ? "busy" : "idle" };
          break;
        case "died": {
          const code = life.code === null ? "" : translate("notebook.kernelDiedCode", { code: life.code });
          const words = life.stderr.trim();
          kernel = {
            ...kernel,
            status: "dead",
            error: `${translate("notebook.kernelDied")}${code}${words ? `\n\n${words}` : ""}`,
          };
          setRuns({});
          cells.clear();
          input = null;
          break;
        }
        case "stopped":
          kernel = null;
          setRuns({});
          cells.clear();
          input = null;
          break;
      }
      continue;
    }

    const cellKey = event.parentMsgId ? cells.get(event.parentMsgId) : undefined;
    if (event.channel === "iopub") {
      if (event.msgType === "status") {
        const state = event.content.execution_state;
        if (state === "busy") kernel = { ...kernel, status: "busy" };
        if (state === "idle") {
          // The execution is over once the kernel is idle *for it*: every output it published is in.
          if (cellKey && event.parentMsgId) {
            cells.delete(event.parentMsgId);
            if (runs[cellKey]?.msgId === event.parentMsgId) {
              const { [cellKey]: _done, ...rest } = runs;
              setRuns(rest);
            }
          }
          const waiting = Object.values(runs).length > 0;
          kernel = { ...kernel, status: waiting ? "busy" : "idle" };
        }
        continue;
      }
      if (event.msgType === "execute_input" && cellKey && runs[cellKey]) {
        setRuns({ ...runs, [cellKey]: { ...runs[cellKey], status: "running" } });
      }
      if (!doc) continue;
      if (cellKey || event.msgType === "update_display_data") {
        const next = applyOutputMessage(doc, cellKey ?? "", event.msgType, event.content, state);
        if (next !== doc) {
          doc = next;
          docChanged = true;
        }
      }
      continue;
    }
    if (event.channel === "shell" && event.msgType === "execute_reply" && cellKey) {
      const status = event.content.status;
      if (status === "aborted") {
        // Never ran: a cell above it failed and the kernel dropped the rest of the queue.
        if (runs[cellKey]) {
          const { [cellKey]: _aborted, ...rest } = runs;
          setRuns(rest);
        }
        if (event.parentMsgId) cells.delete(event.parentMsgId);
      } else if (doc && typeof event.content.execution_count === "number") {
        const next = setExecutionCount(doc, cellKey, event.content.execution_count);
        if (next !== doc) {
          doc = next;
          docChanged = true;
        }
      }
      continue;
    }
    if (event.channel === "stdin" && event.msgType === "input_request") {
      const running = Object.entries(runs).find(([, run]) => run.status === "running")?.[0] ?? null;
      input = {
        cellKey: cellKey ?? running,
        prompt: typeof event.content.prompt === "string" ? event.content.prompt : "",
        password: event.content.password === true,
      };
    }
  }
  return { doc, kernel, runs, input, docChanged };
}

function handleEvents(events: KernelEvent[]): void {
  const bySession = new Map<string, KernelEvent[]>();
  for (const event of events) {
    const key = kernelSessions.get(event.kernelId);
    if (!key) continue;
    const list = bySession.get(key);
    if (list) list.push(event);
    else bySession.set(key, [event]);
  }
  for (const [key, list] of bySession) {
    const session = get().sessions[key];
    if (!session) continue;
    const doc = current(key);
    const reduced = reduceKernelEvents(
      { doc, kernel: session.kernel, runs: session.runs, input: session.input, docChanged: false },
      list,
      executionsOf(key),
      outputStateOf(key),
    );
    patch(key, { kernel: reduced.kernel, runs: reduced.runs, input: reduced.input });
    if (reduced.docChanged && reduced.doc) commit(key, reduced.doc, true);
    if (!reduced.kernel) {
      for (const [id, owner] of kernelSessions) if (owner === key) kernelSessions.delete(id);
    }
  }
}

let listening: Promise<UnlistenFn> | null = null;
function listenOnce(): void {
  if (!listening) listening = onKernelEvents(handleEvents).catch(() => () => {});
}

// ---------------------------------------------------------------------------------------------
// Choosing a kernel
// ---------------------------------------------------------------------------------------------

/** The kernel picked for each notebook, by absolute path — a setting, so it survives a restart. */
const CHOICES_SETTING = "notebook_kernel_choices";
let rememberedChoices: Record<string, string> | null = null;

async function loadRemembered(): Promise<Record<string, string>> {
  if (rememberedChoices) return rememberedChoices;
  try {
    const raw = await getSetting(CHOICES_SETTING);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    rememberedChoices = parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    rememberedChoices = {};
  }
  return rememberedChoices;
}

function remember(absPath: string, choiceId: string): void {
  void loadRemembered().then((choices) => {
    choices[absPath] = choiceId;
    void setSetting(CHOICES_SETTING, JSON.stringify(choices)).catch(() => {});
  });
}

/**
 * The kernel to run a notebook on when nobody picked one: the one it names, if it names a specific
 * one; for Python, the project's own virtualenv before a generic `python3`; then any kernel of its
 * language; then any kernel at all.
 */
export function pickKernel(
  kernels: KernelChoice[],
  wanted: { name: string; language: string } | null,
  remembered: string | null,
): KernelChoice | null {
  if (remembered) {
    const known = kernels.find((kernel) => kernel.id === remembered);
    if (known) return known;
  }
  const name = wanted?.name ?? "";
  const language = (wanted?.language ?? "").toLowerCase();
  const generic = name === "" || name === "python3" || name === "python";
  if (!generic) {
    const named = kernels.find((kernel) => kernel.name === name);
    if (named) return named;
  }
  if (language === "" || language === "python") {
    const venv = kernels.find((kernel) => kernel.source === "venv");
    if (venv) return venv;
  }
  if (name) {
    const named = kernels.find((kernel) => kernel.name === name);
    if (named) return named;
  }
  if (language) {
    const same = kernels.find((kernel) => kernel.language === language);
    if (same) return same;
  }
  return kernels[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// AI context
// ---------------------------------------------------------------------------------------------

const MAX_OUTPUT_CONTEXT = 2_000;

function outputsAsText(cell: NotebookCell): string | null {
  const text = stripAnsi(cellOutputs(cell).map(outputText).filter(Boolean).join("\n")).trim();
  if (!text) return null;
  return text.length > MAX_OUTPUT_CONTEXT ? `…${text.slice(-MAX_OUTPUT_CONTEXT)}` : text;
}

function cellContext(cell: NotebookCell, index: number): NotebookCellContext {
  return {
    index,
    cellType: String(cell.json.cell_type),
    source: cellSource(cell),
    output: cell.json.cell_type === "code" ? outputsAsText(cell) : null,
    executionCount: executionCount(cell),
  };
}

/** A cell's error output as text — name, value and traceback, colours taken out. */
export function errorOf(cell: NotebookCell): string | null {
  const error = cellOutputs(cell).find((output) => output.output_type === "error");
  if (!error) return null;
  const trace = Array.isArray(error.traceback) ? error.traceback.map((line) => String(line)).join("\n") : "";
  return stripAnsi(`${String(error.ename ?? "")}: ${String(error.evalue ?? "")}\n${trace}`).trim();
}

/** What the engine is told about the notebook around `index` (`-1`: no target, the end). */
export function assistRequest(
  doc: NotebookDoc,
  index: number,
  action: NotebookAiAction,
  instruction: string | null,
  path: string,
  replyLanguage: string,
): NotebookAssistRequest {
  const target = index >= 0 ? doc.cells[index] : undefined;
  const end = index >= 0 ? index : doc.cells.length;
  const before = doc.cells
    .slice(Math.max(0, end - 12), end)
    .map((cell, offset) => cellContext(cell, Math.max(0, end - 12) + offset));
  const after = index >= 0 ? doc.cells.slice(index + 1, index + 5).map((cell, offset) => cellContext(cell, index + 1 + offset)) : [];
  return {
    action,
    kernelLanguage: notebookLanguage(doc),
    replyLanguage,
    instruction,
    target: target ? cellContext(target, index) : null,
    error: target && action === "fix" ? errorOf(target) : null,
    before,
    after,
    notebookName: path.split("/").pop() ?? path,
  };
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

const starting = new Map<string, Promise<NotebookKernel | null>>();

/** Lets go of a kernel that died: its process is gone, but the backend still holds its sockets
 *  and heartbeat until it is told to shut it down. */
function releaseDeadKernel(kernel: NotebookKernel): void {
  kernelSessions.delete(kernel.kernelId);
  void shutdownKernel(kernel.kernelId).catch(() => {});
}

function newSession(key: string, repoPath: string, path: string, projectId: string, workspaceId: string | null): NotebookSession {
  return {
    key,
    repoPath,
    path,
    projectId,
    workspaceId,
    doc: null,
    parseError: null,
    kernel: null,
    discovery: null,
    discovering: false,
    choiceId: null,
    runs: {},
    input: null,
    selected: null,
    editing: null,
    deleted: [],
    ai: {},
    generateAt: null,
    noKernel: false,
  };
}

function cellIndex(session: NotebookSession, cellKey: string | null): number {
  if (!cellKey || !session.doc) return -1;
  return session.doc.cells.findIndex((cell) => cell.key === cellKey);
}

export const notebookActions = {
  /**
   * Shows a notebook: makes its session if it has none and brings it up to date with the tab's
   * text. Called by the view on every change of that text, so it has to be cheap when nothing
   * changed — one string comparison.
   */
  open(input: { repoPath: string; path: string; projectId: string; workspaceId: string | null; text: string }): string {
    const key = notebookKey(input.repoPath, input.path);
    listenOnce();
    const existing = get().sessions[key];
    if (!existing) {
      useNotebookStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [key]: newSession(key, input.repoPath, input.path, input.projectId, input.workspaceId),
        },
      }));
      adopt(key, input.text);
      void notebookActions.discover(key);
    } else {
      if (existing.projectId !== input.projectId || existing.workspaceId !== input.workspaceId) {
        patch(key, { projectId: input.projectId, workspaceId: input.workspaceId });
      }
      notebookActions.sync(key, input.text);
    }
    return key;
  },

  /** The tab's text changed: if it is not what this session wrote, it came from outside. If the
   *  session has text the tab has not got yet (its editor was parked), it goes in now. */
  sync(key: string, text: string): void {
    if (text !== written.get(key)) {
      adopt(key, text);
      return;
    }
    if (serialized.get(key) !== text) writeNow(key);
  },

  setMode(key: string, mode: NotebookMode): void {
    if (mode === "notebook") {
      // Back from the raw JSON: whatever was typed there is the notebook now.
      const session = get().sessions[key];
      const text = session ? notebookHost(session.repoPath)?.read(session.path) : null;
      if (text != null) notebookActions.sync(key, text);
    }
    useNotebookStore.setState((state) => ({ modes: { ...state.modes, [key]: mode } }));
    patch(key, { editing: null });
  },

  setFocused(key: string | null): void {
    if (get().focusedKey !== key) useNotebookStore.setState({ focusedKey: key });
  },

  select(key: string, cellKey: string | null, editing = false): void {
    patch(key, (session) =>
      session.selected === cellKey && (session.editing === cellKey) === editing
        ? {}
        : { selected: cellKey, editing: editing ? cellKey : null },
    );
  },

  leaveEditing(key: string): void {
    patch(key, (session) => (session.editing === null ? {} : { editing: null }));
  },

  setSource(key: string, cellKey: string, source: string): void {
    edit(key, (doc) => setSource(doc, cellKey, source));
  },

  /** A new cell next to `cellKey` (`null`: at the end), selected — in edit mode, as Jupyter's A/B
   *  leave it in command mode, but a toolbar "+" means "I want to type". */
  insert(key: string, cellKey: string | null, where: "above" | "below", type: CellType = "code", edit_ = true, source = ""): string | null {
    let created: string | null = null;
    edit(key, (doc) => {
      const at = cellKey ? doc.cells.findIndex((cell) => cell.key === cellKey) : -1;
      const index = at < 0 ? doc.cells.length : where === "above" ? at : at + 1;
      const cell = newCell(doc, type, source);
      created = cell.key;
      return insertCell(doc, index, cell);
    });
    if (created) notebookActions.select(key, created, edit_);
    return created;
  },

  remove(key: string, cellKey: string): void {
    const doc = current(key);
    if (!doc) return;
    const index = doc.cells.findIndex((cell) => cell.key === cellKey);
    if (index < 0) return;
    const cell = doc.cells[index];
    commit(key, deleteCell(doc, cellKey));
    const next = doc.cells[index + 1] ?? doc.cells[index - 1] ?? null;
    patch(key, (session) => ({
      deleted: [...session.deleted.slice(-49), { cell, index }],
      selected: next?.key ?? null,
      editing: null,
      ai: Object.fromEntries(Object.entries(session.ai).filter(([k]) => k !== cellKey)),
    }));
  },

  undoDelete(key: string): void {
    const session = get().sessions[key];
    const last = session?.deleted[session.deleted.length - 1];
    if (!session || !last) return;
    const doc = current(key);
    if (!doc) return;
    // Its key is still its own unless something took it meanwhile.
    const cell = doc.cells.some((c) => c.key === last.cell.key) ? { ...newCell(doc, "code"), json: last.cell.json } : last.cell;
    commit(key, insertCell(doc, last.index, cell));
    patch(key, { deleted: session.deleted.slice(0, -1), selected: cell.key, editing: null });
  },

  move(key: string, cellKey: string, delta: -1 | 1): void {
    edit(key, (doc) => moveCell(doc, cellKey, delta));
  },

  changeType(key: string, cellKey: string, type: CellType): void {
    edit(key, (doc) => changeCellType(doc, cellKey, type));
  },

  clearOutputs(key: string, cellKey?: string): void {
    edit(key, (doc) =>
      cellKey ? setExecutionCount(setOutputs(doc, cellKey, []), cellKey, null) : clearAllOutputs(doc),
    );
  },

  async discover(key: string, force = false): Promise<KernelDiscovery | null> {
    const session = get().sessions[key];
    if (!session) return null;
    if (session.discovery && !force) return session.discovery;
    patch(key, { discovering: true });
    try {
      const [discovery, remembered] = await Promise.all([
        discoverKernels(session.repoPath, session.path),
        loadRemembered(),
      ]);
      const absolute = `${session.repoPath}/${session.path}`;
      patch(key, (latest) => ({
        discovery,
        discovering: false,
        choiceId: latest.choiceId ?? remembered[absolute] ?? null,
        noKernel: latest.noKernel && discovery.kernels.length === 0,
      }));
      return discovery;
    } catch (e) {
      patch(key, { discovering: false });
      pushErrorToast(String(e));
      return null;
    }
  },

  /** The user picked a kernel. The notebook records it (`metadata.kernelspec`, as Jupyter does),
   *  and a kernel already running on another one is stopped; the new one starts on the next run. */
  async chooseKernel(key: string, choiceId: string): Promise<void> {
    const session = get().sessions[key];
    const choice = session?.discovery?.kernels.find((kernel) => kernel.id === choiceId);
    if (!session || !choice) return;
    patch(key, { choiceId });
    remember(`${session.repoPath}/${session.path}`, choiceId);
    edit(key, (doc) =>
      setNotebookMetadata(doc, "kernelspec", {
        display_name: choice.displayName,
        language: choice.language,
        name: choice.name,
      }),
    );
    if (session.kernel && session.kernel.choice.id !== choiceId) await notebookActions.shutdown(key);
  },

  /** The kernel, started if it is not running. `null` when there is none to start. */
  ensureKernel(key: string): Promise<NotebookKernel | null> {
    const session = get().sessions[key];
    if (!session) return Promise.resolve(null);
    if (session.kernel && session.kernel.status !== "dead") return Promise.resolve(session.kernel);
    const pending = starting.get(key);
    if (pending) return pending;
    if (session.kernel) releaseDeadKernel(session.kernel);
    const run = (async (): Promise<NotebookKernel | null> => {
      const discovery = (await notebookActions.discover(key)) ?? null;
      const latest = get().sessions[key];
      if (!latest || !discovery) return null;
      const choice = pickKernel(
        discovery.kernels,
        latest.doc ? notebookKernelspec(latest.doc) : null,
        latest.choiceId,
      );
      if (!choice) {
        patch(key, { kernel: null, noKernel: true });
        return null;
      }
      const kernelId = crypto.randomUUID();
      kernelSessions.set(kernelId, key);
      const kernel: NotebookKernel = { kernelId, choice, status: "starting", info: null, error: null };
      patch(key, { kernel, choiceId: latest.choiceId ?? choice.id, noKernel: false });
      try {
        const info = await startKernel(kernelId, choice.id, latest.repoPath, latest.path);
        const now = get().sessions[key];
        if (!now || now.kernel?.kernelId !== kernelId) {
          // The notebook closed, or another kernel was chosen, while this one started.
          void shutdownKernel(kernelId).catch(() => {});
          kernelSessions.delete(kernelId);
          return null;
        }
        const ready: NotebookKernel = { ...now.kernel, status: now.kernel.status === "starting" ? "idle" : now.kernel.status, info };
        patch(key, { kernel: ready });
        return ready;
      } catch (e) {
        kernelSessions.delete(kernelId);
        patch(key, (now) =>
          now.kernel?.kernelId === kernelId ? { kernel: { ...kernel, status: "dead", error: String(e) } } : {},
        );
        return null;
      }
    })();
    starting.set(key, run);
    void run.finally(() => starting.delete(key));
    return run;
  },

  /**
   * Runs cells in order: each is cleared and queued at once — so the queue is on screen before the
   * kernel has even started — then sent to the kernel, which runs them one after another and drops
   * the rest when one fails (`stop_on_error`). Markdown cells are simply rendered.
   */
  async run(key: string, cellKeys: string[]): Promise<void> {
    const doc = current(key);
    if (!doc) return;
    const queue: { cellKey: string; msgId: string; code: string }[] = [];
    let next = doc;
    for (const cellKey of cellKeys) {
      const cell = next.cells.find((c) => c.key === cellKey);
      if (!cell || cell.json.cell_type !== "code") continue;
      const code = cellSource(cell);
      next = setExecutionCount(setOutputs(next, cellKey, []), cellKey, null);
      // An empty cell is cleared and not sent — what JupyterLab does with one.
      if (code.trim()) queue.push({ cellKey, msgId: crypto.randomUUID(), code });
    }
    if (next !== doc) commit(key, next);
    if (queue.length === 0) return;
    const cells = executionsOf(key);
    for (const item of queue) {
      cells.set(item.msgId, item.cellKey);
      outputStateOf(key).clearPending.delete(item.cellKey);
    }
    patch(key, (session) => {
      const runs = { ...session.runs };
      for (const item of queue) runs[item.cellKey] = { status: "queued", msgId: item.msgId };
      return { runs };
    });

    const kernel = await notebookActions.ensureKernel(key);
    const unqueue = (items: typeof queue) =>
      patch(key, (session) => {
        const runs = { ...session.runs };
        for (const item of items) if (runs[item.cellKey]?.msgId === item.msgId) delete runs[item.cellKey];
        return { runs };
      });
    if (!kernel) {
      unqueue(queue);
      return;
    }
    // The language the kernel reports, into the notebook — as Jupyter records it on every run.
    const info = kernel.info?.language_info;
    if (isJsonObject(info)) {
      edit(key, (d) => {
        const metadata = isJsonObject(d.top.metadata) ? d.top.metadata : {};
        return sameJson(metadata.language_info, info) ? d : setNotebookMetadata(d, "language_info", info);
      });
    }
    for (let i = 0; i < queue.length; i++) {
      try {
        await executeInKernel(kernel.kernelId, queue[i].msgId, queue[i].code);
      } catch (e) {
        unqueue(queue.slice(i));
        pushErrorToast(String(e));
        return;
      }
    }
  },

  async runAll(key: string): Promise<void> {
    const doc = current(key);
    if (doc) await notebookActions.run(key, doc.cells.map((cell) => cell.key));
  },

  async runAbove(key: string, cellKey: string): Promise<void> {
    const doc = current(key);
    if (!doc) return;
    const at = doc.cells.findIndex((cell) => cell.key === cellKey);
    await notebookActions.run(key, doc.cells.slice(0, Math.max(0, at)).map((cell) => cell.key));
  },

  async runBelow(key: string, cellKey: string): Promise<void> {
    const doc = current(key);
    if (!doc) return;
    const at = doc.cells.findIndex((cell) => cell.key === cellKey);
    await notebookActions.run(key, doc.cells.slice(Math.max(0, at)).map((cell) => cell.key));
  },

  /**
   * ⇧↵: runs the cell and moves on to the next — adding a code cell when this was the last one, as
   * Jupyter does, so a notebook can be written top to bottom without reaching for the mouse.
   */
  runAndAdvance(key: string, cellKey: string): void {
    const doc = current(key);
    if (!doc) return;
    const at = doc.cells.findIndex((cell) => cell.key === cellKey);
    void notebookActions.run(key, [cellKey]);
    const next = doc.cells[at + 1];
    if (next) notebookActions.select(key, next.key, false);
    else notebookActions.insert(key, cellKey, "below", "code", true);
  },

  async interrupt(key: string): Promise<void> {
    const kernel = get().sessions[key]?.kernel;
    if (!kernel) return;
    patch(key, { input: null });
    try {
      await interruptKernel(kernel.kernelId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  async restart(key: string, clear: boolean): Promise<void> {
    const kernel = get().sessions[key]?.kernel;
    if (clear) notebookActions.clearOutputs(key);
    if (!kernel || kernel.status === "dead") {
      // A kernel that died starts afresh — `ensureKernel` lets the dead one go first.
      await notebookActions.ensureKernel(key);
      return;
    }
    executionsOf(key).clear();
    patch(key, { runs: {}, input: null, kernel: { ...kernel, status: "restarting" } });
    try {
      const info = await restartKernel(kernel.kernelId);
      patch(key, (session) =>
        session.kernel?.kernelId === kernel.kernelId
          ? { kernel: { ...session.kernel, status: "idle", info, error: null } }
          : {},
      );
    } catch (e) {
      patch(key, (session) =>
        session.kernel?.kernelId === kernel.kernelId
          ? { kernel: { ...session.kernel, status: "dead", error: String(e) } }
          : {},
      );
    }
  },

  async shutdown(key: string): Promise<void> {
    const kernel = get().sessions[key]?.kernel;
    if (!kernel) return;
    kernelSessions.delete(kernel.kernelId);
    executionsOf(key).clear();
    patch(key, { kernel: null, runs: {}, input: null });
    await shutdownKernel(kernel.kernelId).catch(() => {});
  },

  async answerInput(key: string, value: string): Promise<void> {
    const session = get().sessions[key];
    if (!session?.kernel || !session.input) return;
    patch(key, { input: null });
    try {
      await replyToInput(session.kernel.kernelId, value);
    } catch (e) {
      pushErrorToast(String(e));
    }
  },

  dismissKernelError(key: string): void {
    const kernel = get().sessions[key]?.kernel;
    if (kernel?.status === "dead") releaseDeadKernel(kernel);
    patch(key, (session) => ({
      noKernel: false,
      kernel: session.kernel?.status === "dead" ? null : session.kernel,
    }));
  },

  openGenerate(key: string, cellKey: string | null): void {
    patch(key, { generateAt: { cellKey } });
  },

  closeGenerate(key: string): void {
    patch(key, { generateAt: null });
  },

  /**
   * One AI action on a cell. The answer is kept on the cell until the user accepts or discards it —
   * a code answer is never applied by itself — and is dropped if the notebook or the cell is gone
   * by the time it arrives.
   */
  async askAi(key: string, cellKey: string | null, action: NotebookAiAction, instruction: string | null): Promise<void> {
    const session = get().sessions[key];
    const doc = current(key);
    if (!session || !doc) return;
    const index = cellKey ? doc.cells.findIndex((cell) => cell.key === cellKey) : -1;
    if (cellKey && index < 0) return;
    // Filed under the cell it is about; a generation with no cell is filed under the end.
    const slot = cellKey ?? "";
    const runId = newRunId("notebook");
    // Everything the run needs, captured before the first await.
    const workspaceId =
      session.workspaceId ?? useWorkspaceStore.getState().workspaceOfProject(session.projectId) ?? null;
    const before = index >= 0 ? cellSource(doc.cells[index]) : "";
    const request = assistRequest(doc, index, action, instruction, session.path, useLanguageStore.getState().language);
    const name = session.path.split("/").pop() ?? session.path;
    patch(key, (s) => ({
      ai: { ...s.ai, [slot]: { runId, action, workspaceId, status: "running", before, answer: null, error: null } },
      generateAt: action === "generate" ? null : s.generateAt,
    }));
    useAiRunStore.getState().start(runId, {
      kindKey: "notebook.ai.runKind",
      detail: name,
      target: { view: "editor", projectId: session.projectId },
      workspaceId,
    });
    const stillAsked = () => get().sessions[key]?.ai[slot]?.runId === runId;
    try {
      const answer = await notebookAi(request, runId, workspaceId);
      if (!stillAsked()) return;
      patch(key, (s) => ({ ai: { ...s.ai, [slot]: { ...s.ai[slot], status: "ready", answer } } }));
      notify({
        source: "editor",
        workspaceId,
        titleKey: "notebook.ai.ready",
        status: "success",
        detail: name,
        target: { view: "editor", projectId: session.projectId },
      });
    } catch (e) {
      if (!stillAsked()) return;
      if (isCancellation(e)) {
        notebookActions.discardAi(key, slot);
        return;
      }
      patch(key, (s) => ({ ai: { ...s.ai, [slot]: { ...s.ai[slot], status: "failed", error: String(e) } } }));
      notify({
        source: "editor",
        workspaceId,
        titleKey: "notebook.ai.failed",
        status: "error",
        detail: name,
        target: { view: "editor", projectId: session.projectId },
      });
    } finally {
      useAiRunStore.getState().finish(runId);
    }
  },

  cancelAi(key: string, slot: string): void {
    const run = get().sessions[key]?.ai[slot];
    if (run?.status === "running") void useAiRunStore.getState().cancel(run.runId);
  },

  discardAi(key: string, slot: string): void {
    patch(key, (session) => {
      if (!(slot in session.ai)) return {};
      const { [slot]: _gone, ...rest } = session.ai;
      return { ai: rest };
    });
  },

  /** Takes a code answer: the cell's source replaced (fix, document), or a new cell below it
   *  (generate). One edit, so the notebook's undo — the cell editor's own ⌘Z — can take it back. */
  acceptAi(key: string, slot: string): void {
    const run = get().sessions[key]?.ai[slot];
    if (!run || run.status !== "ready" || run.answer === null) return;
    if (run.action === "generate") {
      notebookActions.insert(key, slot || null, "below", "code", false, run.answer);
    } else if (run.action !== "explain") {
      notebookActions.setSource(key, slot, run.answer);
    }
    notebookActions.discardAi(key, slot);
  },

  /** Whether closing this notebook would stop work: a kernel busy, or cells still queued. */
  isBusy(repoPath: string, path: string): boolean {
    const session = get().sessions[notebookKey(repoPath, path)];
    if (!session?.kernel) return false;
    return session.kernel.status === "busy" || Object.keys(session.runs).length > 0;
  },

  /** Forgets a notebook whose tab closed, stopping its kernel. */
  async close(key: string): Promise<void> {
    const session = get().sessions[key];
    if (!session) return;
    for (const run of Object.values(session.ai)) {
      if (run.status === "running") void useAiRunStore.getState().cancel(run.runId);
    }
    const timer = pendingWrites.get(key);
    if (timer !== undefined) clearTimeout(timer);
    pendingWrites.delete(key);
    written.delete(key);
    serialized.delete(key);
    outputStates.delete(key);
    executions.delete(key);
    const kernel = session.kernel;
    useNotebookStore.setState((state) => {
      const { [key]: _closed, ...sessions } = state.sessions;
      const { [key]: _mode, ...modes } = state.modes;
      return { sessions, modes, focusedKey: state.focusedKey === key ? null : state.focusedKey };
    });
    if (kernel) {
      kernelSessions.delete(kernel.kernelId);
      await shutdownKernel(kernel.kernelId).catch(() => {});
    }
  },

  /** The tabs open in `repoPath` now: every notebook of that repository that is no longer among
   *  them is closed. A repository the window has left keeps its notebooks — they are parked, not
   *  closed. */
  syncOpenNotebooks(repoPath: string, openPaths: string[]): void {
    const open = new Set(openPaths);
    for (const session of Object.values(get().sessions)) {
      if (session.repoPath === repoPath && !open.has(session.path)) void notebookActions.close(session.key);
    }
  },
};

/** The index of a cell in its notebook, or -1. */
export function indexOfCell(session: NotebookSession, cellKey: string | null): number {
  return cellIndex(session, cellKey);
}
