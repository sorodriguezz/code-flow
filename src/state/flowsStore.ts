import { create } from "zustand";
import {
  flowsCreateFlow,
  flowsCreateFolder,
  flowsDeleteFlow,
  flowsDeleteFolder,
  flowsDuplicateFlow,
  flowsGetFlow,
  flowsLoadTree,
  flowsMoveFlow,
  flowsMoveToWorkspace,
  flowsNodeCatalog,
  flowsRenameFlow,
  flowsRenameFolder,
  flowsSaveFlow,
  flowsSetActive,
  flowsSetScope,
  type FlowFolderRow,
  type FlowMetaRow,
  type FlowNodeDescriptor,
} from "../lib/tauri/flowsCommands";
import { parseSpec, serializeSpec, uniqueName, type Catalog, type FlowSpec } from "../lib/flows/spec";
import { notifyUnsavedChanged, registerUnsavedProvider } from "../lib/unsavedWork";
import { chooseAction } from "./confirmStore";
import { translate } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * The Flujos workspace: the tree of flows and folders, and the one flow open on the canvas.
 *
 * The shape is the Diagrams store's — a workspace-scoped tree, one open document, a debounced
 * autosave that a workspace switch, a close and the quit guard all flush — and the differences are
 * the two things a flow has that a drawing does not:
 *
 * - **The document is structured**, so edits arrive as whole new documents from the pure functions
 *   in `lib/flows/spec` rather than as text. That makes undo a list of documents (`past`/`future`),
 *   kept here so a keyboard shortcut and a toolbar button undo the same thing.
 * - **Saves are versioned.** Each save names the version it started from; the backend refuses one
 *   that is stale (`conflict`), and the user picks reload or overwrite — the same three answers the
 *   editor's changed-on-disk question gives.
 *
 * Workspace isolation follows `codeflow-run-isolation`: every action captures the workspace before
 * its first `await` and checks it is still the one on screen before writing what came back.
 */

const SAVE_DEBOUNCE_MS = 700;
/** How many steps back undo reaches. A document per step, and documents are kilobytes. */
const HISTORY_LIMIT = 100;

const collapsedKey = (workspaceId: string) => `flows_collapsed_folders:${workspaceId}`;
const lastOpenKey = (workspaceId: string) => `flows_last_open:${workspaceId}`;

/** A row as the explorer holds it — the one place `trigger_types` stops being JSON. */
export interface FlowItem extends FlowMetaRow {
  triggers: string[];
}

export interface FlowDraft {
  id: string;
  spec: FlowSpec;
  /** The version the open document was read at, or last saved as. */
  version: number;
  dirty: boolean;
}

interface FlowsState {
  workspaceId: string | null;
  loading: boolean;
  catalog: FlowNodeDescriptor[];
  catalogMap: Catalog;
  flows: FlowItem[];
  folders: FlowFolderRow[];
  /** Folder ids folded shut — stored per workspace, so a tree comes back the way it was left. */
  collapsed: string[];
  query: string;
  activeId: string | null;
  openingId: string | null;
  draft: FlowDraft | null;
  saving: boolean;
  savedAt: string | null;
  past: FlowSpec[];
  future: FlowSpec[];
  /** The node palette over the canvas, and where a node picked from it lands (`null` = decided by
   *  the selection or the middle of the view). Here rather than in the editor so the guided tour
   *  can open it for the step about it — a tour stage writes stores, never component state. */
  palette: { at: [number, number] | null } | null;

  setPalette: (palette: { at: [number, number] | null } | null) => void;
  setWorkspace: (workspaceId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  ensureCatalog: () => Promise<void>;
  setQuery: (query: string) => void;
  toggleFolder: (folderId: string) => void;

  openFlow: (id: string) => Promise<void>;
  closeFlow: () => Promise<void>;
  createFlow: (folderId: string | null) => Promise<string | null>;
  renameFlow: (id: string, name: string) => Promise<void>;
  duplicateFlow: (id: string) => Promise<string | null>;
  deleteFlow: (id: string) => Promise<void>;
  moveFlow: (id: string, folderId: string | null) => Promise<void>;
  setScope: (id: string, global: boolean) => Promise<void>;
  /** Switches a flow's automatic triggers on or off. The flow is saved first: what gets armed is
   *  what is on the canvas. */
  setActive: (id: string, active: boolean) => Promise<boolean>;
  moveToWorkspace: (id: string, workspaceId: string) => Promise<void>;

  createFolder: (name: string) => Promise<string | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  /** Replaces the open document. `history: false` is for the frames of a gesture whose start was
   *  already recorded by `checkpoint` — a drag is one undo step, not sixty. */
  edit: (next: FlowSpec, options?: { history?: boolean }) => void;
  /** Records the current document as an undo step without changing it — the start of a drag. */
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  /** Writes the open document if it has unsaved changes. `interactive: false` never asks — a stale
   *  save is then left dirty, which is what the quit guard wants. */
  flush: (options?: { interactive?: boolean }) => Promise<void>;
}

/** A trigger problem as a sentence: the one code the backend sends, translated; the rest as said. */
export function describeTriggerError(error: string): string {
  return error.includes("no-automatic-trigger") ? translate("flows.active.noTrigger") : error;
}

function toItem(row: FlowMetaRow): FlowItem {
  let triggers: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.trigger_types);
    if (Array.isArray(parsed)) triggers = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // A row from a hand-edited database draws without a trigger glyph rather than not at all.
  }
  return { ...row, triggers };
}

async function loadPref(key: string): Promise<string | null> {
  const { getSetting } = await import("../lib/tauri/commands");
  try {
    return (await getSetting(key)) ?? null;
  } catch {
    return null;
  }
}

async function savePref(key: string, value: string): Promise<void> {
  const { setSetting } = await import("../lib/tauri/commands");
  await setSetting(key, value).catch(() => {});
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFlush: Promise<void> | null = null;
let catalogLoad: Promise<void> | null = null;

function scheduleSave(get: () => FlowsState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void get().flush();
  }, SAVE_DEBOUNCE_MS);
}

function cancelSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
}

/** Everything on screen that belongs to the workspace being left — one definition for both of
 *  `setWorkspace`'s ways out, so neither can forget a field. The catalogue is absent on purpose:
 *  it belongs to the build, not to a workspace. */
function clearedWorkspaceState(): Partial<FlowsState> {
  return {
    flows: [],
    folders: [],
    collapsed: [],
    query: "",
    activeId: null,
    openingId: null,
    draft: null,
    savedAt: null,
    past: [],
    future: [],
    palette: null,
  };
}

export const useFlowsStore = create<FlowsState>((set, get) => {
  /** Swaps a row in the list, or drops it when the backend answered `null` (gone). */
  const replaceRow = (id: string, row: FlowMetaRow | null) =>
    set((state) => ({
      flows: row
        ? state.flows.map((flow) => (flow.id === id ? toItem(row) : flow))
        : state.flows.filter((flow) => flow.id !== id),
    }));

  /** Writes one save, answering whether the draft that was written is still the one on screen. */
  const saveOnce = async (force: boolean): Promise<void> => {
    const draft = get().draft;
    if (!draft || !draft.dirty) return;
    const workspaceId = get().workspaceId;
    const written = draft.spec;
    set({ saving: true });
    try {
      const result = await flowsSaveFlow(draft.id, serializeSpec(written), force ? null : draft.version);
      if (get().workspaceId !== workspaceId) return;
      const current = get().draft;
      if (!result.meta) {
        // Deleted from another window while it was open here. Nothing to save into.
        if (current?.id === draft.id) set({ draft: null, activeId: null, past: [], future: [] });
        set((state) => ({ flows: state.flows.filter((flow) => flow.id !== draft.id) }));
        pushErrorToast(translate("flows.deletedWhileOpen"));
        return;
      }
      if (result.conflict) {
        throw Object.assign(new Error("conflict"), { conflict: true });
      }
      replaceRow(draft.id, result.meta);
      if (result.trigger_error) {
        pushErrorToast(translate("flows.active.disarmed", { detail: describeTriggerError(result.trigger_error) }));
      }
      if (current?.id === draft.id) {
        set({
          draft: { ...current, version: result.meta.version, dirty: current.spec !== written },
          savedAt: new Date().toISOString(),
        });
      }
    } finally {
      set({ saving: false });
    }
  };

  return {
    workspaceId: null,
    loading: false,
    catalog: [],
    catalogMap: new Map(),
    flows: [],
    folders: [],
    collapsed: [],
    query: "",
    activeId: null,
    openingId: null,
    draft: null,
    saving: false,
    savedAt: null,
    past: [],
    future: [],
    palette: null,

    setPalette: (palette) => set({ palette }),

    setWorkspace: async (workspaceId) => {
      if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;
      if (get().workspaceId === workspaceId && !get().loading) return;
      // The outgoing workspace's unsaved edit, before anything is dropped.
      await get().flush({ interactive: false });
      cancelSave();
      if (!workspaceId) {
        pendingLoad = null;
        set({ workspaceId: null, loading: false, ...clearedWorkspaceState() });
        return;
      }
      const promise = (async () => {
        set({ workspaceId, loading: true, ...clearedWorkspaceState() });
        try {
          const [tree, collapsed, lastOpen] = await Promise.all([
            flowsLoadTree(workspaceId),
            loadPref(collapsedKey(workspaceId)),
            loadPref(lastOpenKey(workspaceId)),
            get().ensureCatalog(),
          ]);
          if (get().workspaceId !== workspaceId) return;
          set({ flows: tree.flows.map(toItem), folders: tree.folders, collapsed: parseList(collapsed) });
          // The flow that was open when this workspace was last left comes back with it.
          if (lastOpen && tree.flows.some((flow) => flow.id === lastOpen)) void get().openFlow(lastOpen);
        } catch (error) {
          pushErrorToast(String(error));
        } finally {
          if (get().workspaceId === workspaceId) set({ loading: false });
        }
      })();
      pendingLoad = { workspaceId, promise };
      try {
        await promise;
      } finally {
        if (pendingLoad?.workspaceId === workspaceId) pendingLoad = null;
      }
    },

    refresh: async () => {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return;
      try {
        const tree = await flowsLoadTree(workspaceId);
        if (get().workspaceId !== workspaceId) return;
        set({ flows: tree.flows.map(toItem), folders: tree.folders });
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    ensureCatalog: () => {
      if (get().catalog.length > 0) return Promise.resolve();
      catalogLoad ??= flowsNodeCatalog()
        .then((catalog) => set({ catalog, catalogMap: new Map(catalog.map((d) => [d.typeId, d])) }))
        .catch((error) => {
          catalogLoad = null;
          pushErrorToast(String(error));
        });
      return catalogLoad;
    },

    setQuery: (query) => set({ query }),

    toggleFolder: (folderId) => {
      const workspaceId = get().workspaceId;
      const collapsed = get().collapsed.includes(folderId)
        ? get().collapsed.filter((id) => id !== folderId)
        : [...get().collapsed, folderId];
      set({ collapsed });
      if (workspaceId) void savePref(collapsedKey(workspaceId), JSON.stringify(collapsed));
    },

    openFlow: async (id) => {
      if (get().activeId === id && get().draft) return;
      const workspaceId = get().workspaceId;
      await get().flush();
      cancelSave();
      set({ openingId: id });
      try {
        const row = await flowsGetFlow(id);
        if (get().workspaceId !== workspaceId || get().openingId !== id) return;
        if (!row) {
          set((state) => ({ flows: state.flows.filter((flow) => flow.id !== id) }));
          pushErrorToast(translate("flows.deletedWhileOpen"));
          return;
        }
        let spec: FlowSpec;
        try {
          spec = parseSpec(row.spec);
        } catch (error) {
          pushErrorToast(translate("flows.unreadable", { detail: String(error) }));
          return;
        }
        replaceRow(id, row);
        set({
          activeId: id,
          draft: { id, spec, version: row.version, dirty: false },
          past: [],
          future: [],
          savedAt: null,
          palette: null,
        });
        if (workspaceId) void savePref(lastOpenKey(workspaceId), id);
      } catch (error) {
        pushErrorToast(String(error));
      } finally {
        if (get().openingId === id) set({ openingId: null });
      }
    },

    closeFlow: async () => {
      await get().flush();
      cancelSave();
      const workspaceId = get().workspaceId;
      set({ activeId: null, draft: null, past: [], future: [], palette: null });
      if (workspaceId) void savePref(lastOpenKey(workspaceId), "");
    },

    createFlow: async (folderId) => {
      const workspaceId = get().workspaceId;
      if (!workspaceId) return null;
      const name = uniqueName(translate("flows.untitled"), get().flows.map((flow) => flow.name));
      try {
        const row = await flowsCreateFlow(workspaceId, folderId, name);
        if (get().workspaceId !== workspaceId) return null;
        set((state) => ({ flows: [...state.flows, toItem(row)] }));
        await get().openFlow(row.id);
        return row.id;
      } catch (error) {
        pushErrorToast(String(error));
        return null;
      }
    },

    renameFlow: async (id, name) => {
      if (!name.trim()) return;
      try {
        replaceRow(id, await flowsRenameFlow(id, name));
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    duplicateFlow: async (id) => {
      const workspaceId = get().workspaceId;
      const original = get().flows.find((flow) => flow.id === id);
      if (!original || !workspaceId) return null;
      // The copy is of what is saved, so the open edit is saved first.
      if (get().activeId === id) await get().flush();
      try {
        const name = uniqueName(
          translate("flows.copyName", { name: original.name }),
          get().flows.map((flow) => flow.name),
        );
        const row = await flowsDuplicateFlow(id, name);
        if (!row || get().workspaceId !== workspaceId) return null;
        set((state) => ({ flows: [...state.flows, toItem(row)] }));
        return row.id;
      } catch (error) {
        pushErrorToast(String(error));
        return null;
      }
    },

    deleteFlow: async (id) => {
      if (get().activeId === id) {
        // Nothing left to save into: the pending write is dropped, not flushed.
        cancelSave();
        set({ activeId: null, draft: null, past: [], future: [] });
      }
      try {
        await flowsDeleteFlow(id);
        set((state) => ({ flows: state.flows.filter((flow) => flow.id !== id) }));
      } catch (error) {
        pushErrorToast(String(error));
        void get().refresh();
      }
    },

    moveFlow: async (id, folderId) => {
      try {
        const row = await flowsMoveFlow(id, folderId);
        if (row) replaceRow(id, row);
        else void get().refresh();
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    setActive: async (id, active) => {
      if (get().activeId === id) await get().flush();
      try {
        const row = await flowsSetActive(id, active);
        if (row) replaceRow(id, row);
        return true;
      } catch (error) {
        pushErrorToast(describeTriggerError(String(error)));
        return false;
      }
    },

    setScope: async (id, global) => {
      try {
        replaceRow(id, await flowsSetScope(id, global));
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    moveToWorkspace: async (id, workspaceId) => {
      if (get().activeId === id) await get().closeFlow();
      try {
        await flowsMoveToWorkspace(id, workspaceId);
        // It is local to the other workspace now, so it leaves this shelf whatever it was.
        set((state) => ({ flows: state.flows.filter((flow) => flow.id !== id) }));
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    createFolder: async (name) => {
      const workspaceId = get().workspaceId;
      if (!workspaceId || !name.trim()) return null;
      try {
        const folder = await flowsCreateFolder(workspaceId, name);
        if (get().workspaceId !== workspaceId) return null;
        set((state) => ({ folders: [...state.folders, folder] }));
        return folder.id;
      } catch (error) {
        pushErrorToast(String(error));
        return null;
      }
    },

    renameFolder: async (id, name) => {
      if (!name.trim()) return;
      try {
        const folder = await flowsRenameFolder(id, name);
        set((state) => ({
          folders: folder
            ? state.folders.map((f) => (f.id === id ? folder : f))
            : state.folders.filter((f) => f.id !== id),
        }));
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    deleteFolder: async (id) => {
      try {
        await flowsDeleteFolder(id);
        set((state) => ({
          folders: state.folders.filter((f) => f.id !== id),
          flows: state.flows.map((flow) => (flow.folder_id === id ? { ...flow, folder_id: null } : flow)),
        }));
      } catch (error) {
        pushErrorToast(String(error));
      }
    },

    edit: (next, options) => {
      const draft = get().draft;
      if (!draft || next === draft.spec) return;
      if (options?.history ?? true) {
        set((state) => ({ past: [...state.past, draft.spec].slice(-HISTORY_LIMIT), future: [] }));
      }
      set({ draft: { ...draft, spec: next, dirty: true } });
      scheduleSave(get);
    },

    checkpoint: () => {
      const draft = get().draft;
      if (!draft) return;
      set((state) => ({ past: [...state.past, draft.spec].slice(-HISTORY_LIMIT), future: [] }));
    },

    undo: () => {
      const { draft, past } = get();
      if (!draft || past.length === 0) return;
      const previous = past[past.length - 1];
      set((state) => ({
        past: state.past.slice(0, -1),
        future: [draft.spec, ...state.future].slice(0, HISTORY_LIMIT),
        draft: { ...draft, spec: previous, dirty: true },
      }));
      scheduleSave(get);
    },

    redo: () => {
      const { draft, future } = get();
      if (!draft || future.length === 0) return;
      const [next, ...rest] = future;
      set((state) => ({
        future: rest,
        past: [...state.past, draft.spec].slice(-HISTORY_LIMIT),
        draft: { ...draft, spec: next, dirty: true },
      }));
      scheduleSave(get);
    },

    flush: async (options) => {
      cancelSave();
      if (pendingFlush) await pendingFlush;
      if (!get().draft?.dirty) return;
      const interactive = options?.interactive ?? true;
      pendingFlush = (async () => {
        try {
          await saveOnce(false);
        } catch (error) {
          const conflict = (error as { conflict?: boolean }).conflict === true;
          if (!conflict) {
            pushErrorToast(translate("flows.saveFailed", { detail: String(error) }));
            return;
          }
          if (!interactive) return;
          const id = get().draft?.id;
          const answer = await chooseAction({
            message: translate("flows.conflict"),
            danger: true,
            choices: [
              { id: "reload", label: translate("flows.conflictReload") },
              { id: "overwrite", label: translate("flows.conflictOverwrite"), variant: "danger" },
            ],
          });
          if (!id || get().draft?.id !== id) return;
          if (answer === "overwrite") {
            await saveOnce(true).catch((e) => pushErrorToast(translate("flows.saveFailed", { detail: String(e) })));
          } else if (answer === "reload") {
            set({ draft: null, activeId: null });
            await get().openFlow(id);
          }
        }
      })();
      try {
        await pendingFlush;
      } finally {
        pendingFlush = null;
      }
    },
  };
});

/** Loads the active workspace's tree, if there is one. Called from the view's mount. */
export function ensureFlowsStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useFlowsStore.getState().setWorkspace(workspaceId);
}

/**
 * A flow belongs to the workspace it was made in, so switching workspace swaps the shelf. Here and
 * not in `App`, for the rule `codeflow-satellite-windows` states: a workspace-scoped store's switch
 * belongs to the store, or a detached Flujos window would keep showing the old workspace's flows.
 * Lazy like its siblings: a store that never loaded has nothing to show from the wrong workspace.
 */
useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  const { workspaceId, loading } = useFlowsStore.getState();
  if (workspaceId === null && !loading) return;
  void useFlowsStore.getState().setWorkspace(state.activeWorkspaceId);
});

function unsavedFlow(state: FlowsState): { id: string; label: string } | null {
  const { draft } = state;
  if (!draft || !(draft.dirty || state.saving)) return null;
  const name = state.flows.find((flow) => flow.id === draft.id)?.name;
  return { id: draft.id, label: name?.trim() || translate("flows.untitled") };
}

registerUnsavedProvider({
  id: "flows",
  unsaved: () => {
    const item = unsavedFlow(useFlowsStore.getState());
    return item ? [{ label: item.label, detail: translate("tabbar.flows") }] : [];
  },
  saveAll: async () => {
    for (let pass = 0; pass < 3; pass++) {
      await useFlowsStore.getState().flush({ interactive: false });
      if (!unsavedFlow(useFlowsStore.getState())) return [];
    }
    const left = unsavedFlow(useFlowsStore.getState());
    return left ? [left.label] : [];
  },
  discard: () => cancelSave(),
});

useFlowsStore.subscribe((state, previous) => {
  if (unsavedFlow(state)?.id !== unsavedFlow(previous)?.id) notifyUnsavedChanged();
});
