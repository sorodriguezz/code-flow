/**
 * Arquitectura's documents — the rail app's list, the open document and its autosave.
 *
 * The documents live in the `diagrams` table with `format = "arch"`, so they get the diagrams'
 * version history, repository bridge, search and backups for nothing; Diagramas simply hides them
 * (`diagramsStore` filters the format out) and this store shows only them. Workspace-scoped like
 * every authored document: the subscription at the bottom follows the active workspace, here and
 * not in `App`, for the reason `diagramsStore` gives.
 *
 * The store holds text, not a parsed document. The text is the document — comments, ordering and
 * formatting included — and every view parses it itself, keeping the last good parse when the
 * user is mid-edit and the JSON is broken.
 */
import { create } from "zustand";
import {
  diagramsCreateDiagram,
  diagramsCreateFolder,
  diagramsDeleteDiagram,
  diagramsDeleteFolder,
  diagramsMoveDiagram,
  diagramsMoveFolder,
  diagramsRenameFolder,
  diagramsDuplicateDiagram,
  diagramsGetDiagram,
  diagramsLoadTree,
  diagramsPullFile,
  diagramsRenameDiagram,
  diagramsSaveDiagram,
  diagramsSaveToRepo,
  diagramsSetPinned,
  diagramsUnlinkFile,
} from "../lib/tauri/diagramsCommands";
import type { DiagramFileVersion, DiagramFolderRow, DiagramMetaRow } from "../types/diagrams";
import { formatDoc } from "../lib/architecture/jsonEdit";
import { parseArchText } from "../lib/architecture/parse";
import { blankDoc } from "../lib/architecture/templates";
import type { ArchDoc } from "../lib/architecture/types";
import { registerIslandApp } from "../lib/islandSync";
import { notifyUnsavedChanged, registerUnsavedProvider } from "../lib/unsavedWork";
import { translate, useLanguageStore } from "./languageStore";
import { pushErrorToast } from "./toastStore";
import { useWorkspaceStore } from "./workspaceStore";

export const FORMAT_ARCH = "arch";
const SAVE_DEBOUNCE_MS = 700;

export interface ArchItem {
  id: string;
  title: string;
  /** The folder it is filed in, or `null` at the top of the list. */
  folderId: string | null;
  pinned: boolean;
  /** Repo-relative path of the `.arch.json` it mirrors, or "". */
  originPath: string;
  originProjectId: string;
  components: number;
  updatedAt: string;
}

/** A folder of this section's own — the diagrams' `diagram_folders`, marked `app = "arch"` so
 *  Diagramas never lists it (nor this section Diagramas' folders). */
export interface ArchFolder {
  id: string;
  name: string;
  parentId: string | null;
}

interface Draft {
  id: string;
  text: string;
  dirty: boolean;
  /** The linked file's version at the last read or write — what the next save is checked against. */
  fileVersion: DiagramFileVersion | null;
  fileError: string;
}

interface ArchitectureState {
  workspaceId: string | null;
  loading: boolean;
  items: ArchItem[];
  folders: ArchFolder[];
  /** Folders shown folded, by id — kept per workspace in this webview. */
  folded: string[];
  activeId: string | null;
  draft: Draft | null;
  saving: boolean;
  lastSavedAt: number | null;
  /** The linked file changed on disk under an unsaved edit. */
  fileConflict: boolean;
  /** Parsed documents named by the open document's `includes`, by title. */
  included: Array<{ title: string; doc: ArchDoc }>;
  /** Earlier texts of the open document, newest last — the canvas's undo. */
  past: string[];
  /** Texts undone, newest last — redo. */
  future: string[];

  setWorkspace: (workspaceId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  open: (id: string | null) => Promise<void>;
  editText: (text: string) => void;
  undo: () => void;
  redo: () => void;
  flush: (opts?: { interactive?: boolean; force?: boolean }) => Promise<void>;
  /** A new, empty document — in `folderId` when given. */
  create: (title?: string, folderId?: string | null) => Promise<string | null>;
  createFolder: (name: string, parentId?: string | null) => Promise<string | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /** Deletes the folder, its subfolders **and every diagram in them**. Confirm before calling. */
  deleteFolder: (id: string) => Promise<void>;
  /** Files a diagram in a folder, or at the top of the list with `null`. */
  moveToFolder: (id: string, folderId: string | null) => Promise<void>;
  /** Puts a folder inside another (or at the top). Refused when it would go inside itself. */
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  toggleFolder: (id: string) => void;
  /** A new document from one the assistant designed. */
  createFrom: (doc: ArchDoc, title?: string) => Promise<string | null>;
  /** A new document holding an imported file's text as it is — comments and order kept. */
  importText: (text: string, title: string) => Promise<string | null>;
  unlink: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  duplicate: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  saveToRepo: (projectId: string) => Promise<boolean>;
  reloadIncluded: () => Promise<void>;
}

const toItem = (m: DiagramMetaRow): ArchItem => ({
  id: m.id,
  title: m.title,
  folderId: m.folder_id ?? null,
  pinned: m.pinned,
  originPath: m.origin_path,
  originProjectId: m.origin_project_id,
  components: m.shape_count,
  updatedAt: m.updated_at,
});

const HISTORY = 100;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFlush: Promise<void> | null = null;

function scheduleSave(get: () => ArchitectureState) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void get().flush();
  }, SAVE_DEBOUNCE_MS);
}

/** Whose folders are this section's — the rest of the table belongs to Diagramas. */
export const ARCH_FOLDER_APP = "arch";
const toFolder = (f: DiagramFolderRow): ArchFolder => ({ id: f.id, name: f.name, parentId: f.parent_id });
const ownFolders = (rows: DiagramFolderRow[]) =>
  rows.filter((f) => f.app === ARCH_FOLDER_APP).map(toFolder).sort((a, b) => a.name.localeCompare(b.name));

const foldedKey = (workspaceId: string) => `cf.arch.folded:${workspaceId}`;
const readFolded = (workspaceId: string): string[] => {
  try {
    const raw = localStorage.getItem(foldedKey(workspaceId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
};
const writeFolded = (workspaceId: string, ids: string[]) => {
  try {
    localStorage.setItem(foldedKey(workspaceId), JSON.stringify(ids));
  } catch {
    // Without storage the folding lasts for the session.
  }
};

/** Every folder under `id`, and `id` itself. */
export function folderSubtree(folders: ArchFolder[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

const sortItems = (items: ArchItem[]) =>
  [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));

export const useArchitectureStore = create<ArchitectureState>((set, get) => ({
  workspaceId: null,
  loading: false,
  items: [],
  folders: [],
  folded: [],
  activeId: null,
  draft: null,
  saving: false,
  lastSavedAt: null,
  fileConflict: false,
  included: [],
  past: [],
  future: [],

  setWorkspace: async (workspaceId) => {
    if (get().workspaceId === workspaceId && !get().loading) return;
    await get().flush({ interactive: false });
    if (!workspaceId) {
      set({ workspaceId: null, loading: false, items: [], activeId: null, draft: null, included: [] });
      return;
    }
    set({ workspaceId, loading: true, items: [], folders: [], folded: readFolded(workspaceId), activeId: null, draft: null, included: [] });
    try {
      const tree = await diagramsLoadTree(workspaceId);
      if (get().workspaceId !== workspaceId) return;
      set({ items: sortItems(tree.diagrams.filter((d) => d.format === FORMAT_ARCH).map(toItem)), folders: ownFolders(tree.folders), loading: false });
    } catch (error) {
      set({ loading: false });
      pushErrorToast(String(error));
    }
  },

  refresh: async () => {
    const { workspaceId } = get();
    if (!workspaceId) return;
    try {
      const tree = await diagramsLoadTree(workspaceId);
      if (get().workspaceId !== workspaceId) return;
      set({ items: sortItems(tree.diagrams.filter((d) => d.format === FORMAT_ARCH).map(toItem)), folders: ownFolders(tree.folders) });
    } catch {
      // A failed refresh keeps the list it had; the next edit or reload tries again.
    }
  },

  open: async (id) => {
    await get().flush({ interactive: false });
    if (!id) {
      set({ activeId: null, draft: null, included: [], fileConflict: false });
      return;
    }
    set({ activeId: id, fileConflict: false });
    try {
      const sync = await diagramsPullFile(id);
      if (get().activeId !== id) return;
      if (!sync.row) {
        set({ activeId: null, draft: null });
        void get().refresh();
        return;
      }
      set({ draft: { id, text: sync.row.doc, dirty: false, fileVersion: sync.version, fileError: sync.file_error }, lastSavedAt: null, past: [], future: [] });
      await get().reloadIncluded();
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  editText: (text) => {
    const { draft, past } = get();
    if (!draft || draft.text === text) return;
    set({ draft: { ...draft, text, dirty: true }, past: [...past, draft.text].slice(-HISTORY), future: [] });
    if (!draft.dirty) notifyUnsavedChanged();
    scheduleSave(get);
  },

  undo: () => {
    const { draft, past, future } = get();
    if (!draft || !past.length) return;
    const text = past[past.length - 1];
    set({ draft: { ...draft, text, dirty: true }, past: past.slice(0, -1), future: [...future, draft.text].slice(-HISTORY) });
    if (!draft.dirty) notifyUnsavedChanged();
    scheduleSave(get);
  },

  redo: () => {
    const { draft, past, future } = get();
    if (!draft || !future.length) return;
    const text = future[future.length - 1];
    set({ draft: { ...draft, text, dirty: true }, future: future.slice(0, -1), past: [...past, draft.text].slice(-HISTORY) });
    if (!draft.dirty) notifyUnsavedChanged();
    scheduleSave(get);
  },

  flush: async (opts = {}) => {
    if (pendingFlush) return pendingFlush;
    const { draft } = get();
    if (!draft || (!draft.dirty && !opts.force)) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
    const sent = draft.text;
    pendingFlush = (async () => {
      set({ saving: true });
      try {
        const saved = await diagramsSaveDiagram(draft.id, sent, FORMAT_ARCH, "", draft.fileVersion, !!opts.force);
        const now = get().draft;
        if (now && now.id === draft.id) set({ draft: { ...now, dirty: now.text !== sent, fileVersion: saved.version ?? now.fileVersion }, lastSavedAt: Date.now(), fileConflict: false });
        if (saved.meta) {
          const item = toItem(saved.meta);
          set({ items: sortItems(get().items.map((i) => (i.id === item.id ? item : i))) });
        }
      } catch (error) {
        const message = String(error);
        if (message.includes("changed-on-disk")) set({ fileConflict: true });
        else if (opts.interactive !== false) pushErrorToast(message);
      } finally {
        set({ saving: false });
        pendingFlush = null;
        notifyUnsavedChanged();
      }
      if (get().draft?.dirty) scheduleSave(get);
    })();
    return pendingFlush;
  },

  create: async (title, folderId = null) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    const lang = useLanguageStore.getState().language;
    const name = title?.trim() || translate("arch.untitled");
    try {
      const meta = await diagramsCreateDiagram(workspaceId, folderId, name, formatDoc(blankDoc(name, lang)), FORMAT_ARCH, "[]");
      // Unfolded, so the new document is seen where it was made.
      if (folderId && get().folded.includes(folderId)) get().toggleFolder(folderId);
      set({ items: sortItems([toItem(meta), ...get().items]) });
      await get().open(meta.id);
      return meta.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  createFrom: async (doc, title) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    const name = title?.trim() || doc.meta?.title || translate("arch.untitled");
    try {
      const meta = await diagramsCreateDiagram(workspaceId, null, name, formatDoc(doc), FORMAT_ARCH, "[]");
      set({ items: sortItems([toItem(meta), ...get().items]) });
      await get().open(meta.id);
      return meta.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  importText: async (text, title) => {
    const { workspaceId } = get();
    if (!workspaceId) return null;
    try {
      const meta = await diagramsCreateDiagram(workspaceId, null, title.trim() || translate("arch.untitled"), text, FORMAT_ARCH, "[]");
      set({ items: sortItems([toItem(meta), ...get().items]) });
      await get().open(meta.id);
      return meta.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  unlink: async (id) => {
    try {
      const meta = await diagramsUnlinkFile(id);
      if (meta) set({ items: get().items.map((i) => (i.id === id ? toItem(meta) : i)) });
      const now = get().draft;
      if (now?.id === id) set({ draft: { ...now, fileVersion: null, fileError: "" } });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  rename: async (id, title) => {
    const clean = title.trim();
    if (!clean) return;
    try {
      const meta = await diagramsRenameDiagram(id, clean);
      if (meta) set({ items: get().items.map((i) => (i.id === id ? toItem(meta) : i)) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  duplicate: async (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    await get().flush({ interactive: false });
    try {
      const meta = await diagramsDuplicateDiagram(id, translate("arch.copyOf", { title: item.title }));
      if (meta) set({ items: sortItems([toItem(meta), ...get().items]) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  remove: async (id) => {
    if (get().activeId === id) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      set({ activeId: null, draft: null, included: [] });
    }
    try {
      await diagramsDeleteDiagram(id);
      set({ items: get().items.filter((i) => i.id !== id) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  createFolder: async (name, parentId = null) => {
    const { workspaceId } = get();
    const clean = name.trim();
    if (!workspaceId || !clean) return null;
    try {
      const row = await diagramsCreateFolder(workspaceId, parentId, clean, "", ARCH_FOLDER_APP);
      set({ folders: [...get().folders, toFolder(row)].sort((a, b) => a.name.localeCompare(b.name)) });
      return row.id;
    } catch (error) {
      pushErrorToast(String(error));
      return null;
    }
  },

  renameFolder: async (id, name) => {
    const clean = name.trim();
    if (!clean) return;
    try {
      await diagramsRenameFolder(id, clean);
      set({ folders: get().folders.map((f) => (f.id === id ? { ...f, name: clean } : f)).sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  deleteFolder: async (id) => {
    const gone = folderSubtree(get().folders, id);
    const active = get().items.find((i) => i.id === get().activeId);
    if (active?.folderId && gone.has(active.folderId)) {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      set({ activeId: null, draft: null, included: [] });
    }
    try {
      await diagramsDeleteFolder(id);
      set({ folders: get().folders.filter((f) => !gone.has(f.id)), items: get().items.filter((i) => !i.folderId || !gone.has(i.folderId)) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  moveToFolder: async (id, folderId) => {
    const before = get().items.find((i) => i.id === id)?.folderId ?? null;
    if (before === folderId) return;
    set({ items: get().items.map((i) => (i.id === id ? { ...i, folderId } : i)) });
    if (folderId && get().folded.includes(folderId)) get().toggleFolder(folderId);
    try {
      await diagramsMoveDiagram(id, folderId);
    } catch (error) {
      set({ items: get().items.map((i) => (i.id === id ? { ...i, folderId: before } : i)) });
      pushErrorToast(String(error));
    }
  },

  moveFolder: async (id, parentId) => {
    const folder = get().folders.find((f) => f.id === id);
    if (!folder || folder.parentId === parentId || (parentId && folderSubtree(get().folders, id).has(parentId))) return;
    set({ folders: get().folders.map((f) => (f.id === id ? { ...f, parentId } : f)) });
    try {
      const ok = await diagramsMoveFolder(id, parentId);
      if (!ok) set({ folders: get().folders.map((f) => (f.id === id ? { ...f, parentId: folder.parentId } : f)) });
    } catch (error) {
      set({ folders: get().folders.map((f) => (f.id === id ? { ...f, parentId: folder.parentId } : f)) });
      pushErrorToast(String(error));
    }
  },

  toggleFolder: (id) => {
    const { workspaceId, folded } = get();
    const next = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    set({ folded: next });
    if (workspaceId) writeFolded(workspaceId, next);
  },

  setPinned: async (id, pinned) => {
    try {
      await diagramsSetPinned(id, pinned);
      set({ items: sortItems(get().items.map((i) => (i.id === id ? { ...i, pinned } : i))) });
    } catch (error) {
      pushErrorToast(String(error));
    }
  },

  saveToRepo: async (projectId) => {
    const { draft } = get();
    if (!draft) return false;
    await get().flush({ interactive: false });
    try {
      const saved = await diagramsSaveToRepo(draft.id, projectId);
      if (saved.meta) {
        const item = toItem(saved.meta);
        set({ items: get().items.map((i) => (i.id === item.id ? item : i)) });
      }
      const now = get().draft;
      if (now) set({ draft: { ...now, fileVersion: saved.version } });
      return true;
    } catch (error) {
      pushErrorToast(String(error));
      return false;
    }
  },

  reloadIncluded: async () => {
    const { draft, items } = get();
    if (!draft) return;
    const parsed = parseArchText(draft.text);
    const names = parsed.ok ? (parsed.doc.includes ?? []) : [];
    const out: Array<{ title: string; doc: ArchDoc }> = [];
    for (const title of names) {
      const item = items.find((i) => i.title === title && i.id !== draft.id);
      if (!item) continue;
      try {
        const row = await diagramsGetDiagram(item.id);
        const r = row ? parseArchText(row.doc) : null;
        if (r?.ok) out.push({ title, doc: r.doc });
      } catch {
        // An include that cannot be read draws as missing cards; the warning names it.
      }
    }
    if (get().draft?.id === draft.id) set({ included: out });
  },
}));

export function ensureArchitectureStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  if (workspaceId === null) return Promise.resolve();
  return useArchitectureStore.getState().setWorkspace(workspaceId);
}

useWorkspaceStore.subscribe((state, previous) => {
  if (state.activeWorkspaceId === previous.activeWorkspaceId) return;
  const { workspaceId, loading } = useArchitectureStore.getState();
  if (workspaceId === null && !loading) return;
  void useArchitectureStore.getState().setWorkspace(state.activeWorkspaceId);
});

registerIslandApp(["architecture"], {
  isLoaded: () => useArchitectureStore.getState().workspaceId !== null || useArchitectureStore.getState().loading,
  flush: () => useArchitectureStore.getState().flush({ interactive: false }),
  release: () => {
    useArchitectureStore.setState({ workspaceId: null, loading: false, items: [], activeId: null, draft: null, included: [] });
  },
  reload: () => {
    useArchitectureStore.setState({ workspaceId: null, loading: false });
    return ensureArchitectureStoreLoaded();
  },
});

function unsavedDoc(state: ArchitectureState): { label: string } | null {
  const { draft } = state;
  if (!draft || !(draft.dirty || state.saving)) return null;
  const title = state.items.find((i) => i.id === draft.id)?.title;
  return { label: title?.trim() || translate("arch.untitled") };
}

registerUnsavedProvider({
  id: "architecture",
  unsaved: () => {
    const item = unsavedDoc(useArchitectureStore.getState());
    return item ? [{ label: item.label, detail: translate("tabbar.architecture") }] : [];
  },
  saveAll: async () => {
    for (let pass = 0; pass < 3; pass++) {
      await useArchitectureStore.getState().flush({ interactive: false });
      if (!unsavedDoc(useArchitectureStore.getState())) return [];
    }
    const left = unsavedDoc(useArchitectureStore.getState());
    return left ? [left.label] : [];
  },
  discard: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
  },
});
