import { create } from "zustand";
import {
  apiAddHistory,
  apiClearCookies,
  apiClearHistory,
  apiCreateCollection,
  apiCreateEnvironment,
  apiCreateFolder,
  apiCreateRequest,
  apiDeleteCollection,
  apiDeleteCookie,
  apiDeleteEnvironment,
  apiDeleteFolder,
  apiDeleteHistory,
  apiDeleteRequest,
  apiDuplicateCollection,
  apiDuplicateEnvironment,
  apiDuplicateRequest,
  apiListCookies,
  apiListEnvironments,
  apiListHistoryMeta,
  apiLoadTree,
  apiMoveNode,
  apiReorderCollections,
  apiStreamDisconnect,
  apiUpdateCollection,
  apiUpdateEnvironment,
  apiUpdateFolder,
  apiUpdateRequest,
  apiUpsertCookie,
} from "../lib/tauri/apiCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
// Deliberately NOT a static import of `lib/monacoSetup`. This store is reached from `App.tsx`, so
// anything it imports is in the entry chunk — and monaco-editor is 4 MB of it. The one place that
// needs the namespace is `disposeTabModels`, which resolves it with a dynamic `import()`; see the
// note there for why that costs nothing.
import { translations, type TranslationKey } from "../lib/i18n/translations";
import { pushErrorToast } from "./toastStore";
import { useLanguageStore } from "./languageStore";
import { useApiRuntimeStore } from "./apiRuntimeStore";
import { useApiModalStore } from "./apiModalStore";
import { useWorkspaceStore } from "./workspaceStore";
import { defaultApiSettings, defaultAuth, defaultRequestSpec } from "../types/api";
import type {
  ApiCollection,
  ApiCookie,
  ApiEnvironment,
  ApiFolder,
  ApiHistoryEntry,
  ApiProtocol,
  ApiRequestRow,
  ApiRequestSpec,
  ApiSettings,
  ApiVariable,
  AuthConfig,
  SavedExample,
  VariableScope,
} from "../types/api";
import type { VariableContext } from "../lib/api/variables";

/** Global on purpose: timeouts, proxy and certificates are transport configuration, not content. */
const SETTINGS_KEY = "api_settings";

/**
 * Which environment is selected and which requests are open *are* content, so they are stored
 * per workspace — a shared key would put another workspace's tabs back on screen right after
 * the switch that was supposed to leave them behind.
 */
const activeEnvironmentKey = (workspaceId: string) => `api_active_environment:${workspaceId}`;
const openTabsKey = (workspaceId: string) => `api_open_tabs:${workspaceId}`;

/**
 * One editor tab in the builder. `requestId: null` is a scratch request — it exists only here
 * and in the persisted tab list until the user saves it into a collection, which is what makes
 * "type a URL, hit Send" work without creating anything.
 */
export interface ApiTab {
  id: string;
  requestId: string | null;
  draft: ApiRequestSpec;
  name: string;
  dirty: boolean;
  /** Where `saveTab` files a scratch request; carried so the save needs no extra argument. */
  collectionId: string | null;
  folderId: string | null;
  /**
   * The row's `updated_at` at the moment this tab last agreed with it — on open, and on every
   * save. What makes "the row changed underneath me" answerable at all: the draft has been edited,
   * so it cannot be compared against anything, but this can.
   */
  rowUpdatedAt?: string;
  /**
   * A teammate's change landed on this request while the tab held unsaved edits.
   *
   * Not the same thing as the conflicts in `collabStore`, which are two *saved* versions the sync
   * layer froze. This one is a draft that only exists here, so no amount of backend bookkeeping
   * could have seen it — and without the flag the next save would quietly overwrite the change
   * that arrived, which is the one outcome collaboration must never produce silently.
   */
  staleAgainst?: string;
}

/**
 * The editable state of a collection or folder open in a tab.
 *
 * Not the `ApiCollection`/`ApiFolder` row itself: those also carry ids, timestamps and tree
 * position, none of which this screen edits, and a draft holding them would have to be reconciled
 * field by field on save. What is here is exactly what the settings view writes back.
 */
export interface EntityDraft {
  description: string;
  auth: AuthConfig;
  preScript: string;
  postScript: string;
  /** Collections only — a folder has no variable scope of its own, so it stays empty there. */
  variables: ApiVariable[];
}

/**
 * A collection or folder open for editing, alongside the request tabs.
 *
 * Kept in its own list rather than as a variant of `ApiTab`: most of the API client reads
 * `tab.draft` as a request spec, and a union would force every one of those call sites to narrow
 * for a case it has nothing to say about. The two lists share one id space, one `tabOrder` and one
 * `activeTabId` — so a component that looks the active id up in `openTabs` simply finds nothing
 * while a settings tab is focused, which is the state it already renders for.
 */
export interface ApiEntityTab {
  id: string;
  kind: "collection" | "folder";
  /** The row this tab edits. */
  entityId: string;
  /** The collection it lives in — itself, for a collection. Scopes the variable context. */
  collectionId: string;
  /**
   * The row's name. Deliberately outside `draft`: renaming happens in the tree, not here, so the
   * tab label follows the row even while the settings below it hold unsaved edits.
   */
  name: string;
  dirty: boolean;
  draft: EntityDraft;
}

/** Persisted shape of `api_open_tabs`. Versioned so a later change can be migrated, not guessed. */
interface PersistedTabs {
  version: 2;
  tabs: ApiTab[];
  entityTabs: ApiEntityTab[];
  /** Both kinds, in the order they sit in the strip. */
  order: string[];
  activeTabId: string | null;
}

/** What version 1 wrote, before collections and folders could be opened: request tabs only. */
interface PersistedTabsV1 {
  version: 1;
  tabs: ApiTab[];
  activeTabId: string | null;
}

interface ApiState {
  /** Whose data is in the store right now; `null` until the first load. */
  workspaceId: string | null;
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequestRow[];
  environments: ApiEnvironment[];
  /** `null` = "No environment"; the Globals row is always in scope and is never this id. */
  activeEnvironmentId: string | null;
  history: ApiHistoryEntry[];
  cookies: ApiCookie[];
  settings: ApiSettings;
  openTabs: ApiTab[];
  /** Collections and folders open for editing; see `ApiEntityTab` for why they are a second list. */
  entityTabs: ApiEntityTab[];
  /** Every open tab's id, both kinds, in strip order — the only place that order lives. */
  tabOrder: string[];
  activeTabId: string | null;
  loading: boolean;

  init: (workspaceId: string) => Promise<void>;
  /**
   * Points the whole API client at another workspace: tears the current one down (live
   * connections included), then loads the new one. A no-op when the workspace is unchanged.
   */
  setWorkspace: (workspaceId: string) => Promise<void>;

  reloadTree: () => Promise<void>;
  reloadEnvironments: () => Promise<void>;
  reloadHistory: () => Promise<void>;
  reloadCookies: () => Promise<void>;

  createCollection: (name: string) => Promise<ApiCollection | null>;
  updateCollection: (collection: ApiCollection) => Promise<void>;
  /** Flips a collection's pin, which is what floats it to the top of the explorer. */
  toggleCollectionPinned: (id: string) => Promise<void>;
  deleteCollection: (id: string) => Promise<void>;
  duplicateCollection: (id: string) => Promise<void>;
  reorderCollections: (ids: string[]) => Promise<void>;

  createFolder: (collectionId: string, parentId: string | null, name: string) => Promise<ApiFolder | null>;
  updateFolder: (folder: ApiFolder) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  createRequest: (
    collectionId: string,
    folderId: string | null,
    name: string,
    spec: ApiRequestSpec,
  ) => Promise<ApiRequestRow | null>;
  updateRequest: (request: ApiRequestRow) => Promise<void>;
  deleteRequest: (id: string) => Promise<void>;
  duplicateRequest: (id: string) => Promise<void>;
  moveNode: (
    kind: "folder" | "request",
    id: string,
    collectionId: string,
    parentId: string | null,
    index: number,
  ) => Promise<void>;

  createEnvironment: (name: string) => Promise<ApiEnvironment | null>;
  updateEnvironment: (environment: ApiEnvironment) => Promise<void>;
  deleteEnvironment: (id: string) => Promise<void>;
  duplicateEnvironment: (id: string) => Promise<void>;
  setActiveEnvironment: (id: string | null) => void;
  /** Writes one variable's `currentValue`, creating the row if the scope doesn't define it yet. */
  setVariable: (scope: VariableScope, key: string, value: string, collectionId?: string | null) => Promise<void>;

  addHistory: (entry: ApiHistoryEntry) => Promise<void>;
  deleteHistory: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;

  upsertCookie: (cookie: ApiCookie) => Promise<void>;
  deleteCookie: (id: string) => Promise<void>;
  clearCookies: () => Promise<void>;

  updateSettings: (patch: Partial<ApiSettings>) => Promise<void>;

  openRequest: (requestId: string) => void;
  openScratchTab: (protocol?: ApiProtocol, target?: { collectionId: string; folderId: string | null }) => string;
  /**
   * Opens a collection or folder's settings, or focuses the tab already showing them.
   *
   * Returns the tab id, or `null` when the row is gone — the tree can race a delete from a
   * teammate's pull.
   */
  openEntityTab: (kind: "collection" | "folder", entityId: string) => string | null;
  updateEntityDraft: (tabId: string, patch: Partial<EntityDraft>) => void;
  /** Writes the draft back to the row. The only way auth, scripts or variables reach a parent. */
  saveEntityTab: (tabId: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, name: string) => void;
  updateDraft: (tabId: string, patch: Partial<ApiRequestSpec>) => void;
  /**
   * Replaces a saved request's example list, in the row and in any tab that has it open.
   *
   * Examples aren't an edit in progress the way the URL or the body are — the tree reads them
   * off the row, so an example that only existed in a draft would be saved into a request the
   * user can't see it under. Capturing or dropping one is therefore its own little save, and it
   * deliberately leaves the tab's other unsaved edits exactly as unsaved as they were.
   *
   * Scratch tabs have no row to write to; their examples ride along in the draft until `saveTab`
   * files the request.
   */
  setRequestExamples: (requestId: string, examples: SavedExample[]) => Promise<void>;
  saveTab: (
    tabId: string,
    target?: { collectionId: string; folderId: string | null },
  ) => Promise<ApiRequestRow | null>;

  /**
   * Brings the open tabs back in line with the tree after a pull.
   *
   * A tab holds its own copy of a request; nothing about reloading the tree touches it. Left alone,
   * an open tab shows the version it was opened with for as long as it stays open — and saving it
   * writes that stale copy back over whatever arrived, with no conflict raised, because the sync
   * layer compares saved rows and the divergence here was never saved.
   *
   * So: a clean tab simply follows its row, because a clean tab *is* a view of that row and has
   * nothing of its own to lose. A dirty one is never touched — it is flagged, and the choice is
   * the user's.
   */
  adoptRemoteChanges: () => void;
  /** Drops this tab's unsaved edits and shows the version that arrived. */
  takeRemoteVersion: (tabId: string) => void;
  /** Keeps the unsaved edits; the next save deliberately overwrites what arrived. */
  keepLocalVersion: (tabId: string) => void;

  variableContext: (collectionId: string | null) => VariableContext;
  effectiveAuthChain: (requestId: string) => (AuthConfig | null)[];
  /** Same walk as `effectiveAuthChain` but rooted in the tab's unsaved draft. */
  authChainForTab: (tabId: string) => (AuthConfig | null)[];
}

/**
 * The load in flight, and the workspace it belongs to.
 *
 * `init()` reloads the entire tree, so it must run once per workspace — but four entry points
 * can be the first to need the data (the API view, the API section of Settings, a
 * command-palette action that opens a request, and the workspace effect in `App`), and none of
 * them can know whether it got there first. Handing every caller the same promise is what keeps
 * that from becoming two concurrent loads; keying it by workspace is what keeps a *switch* from
 * being mistaken for one of those duplicate calls and ignored. A module-level latch is the only
 * place that outlives all four; a ref in any component would be re-created by StrictMode.
 */
let pendingLoad: { workspaceId: string; promise: Promise<void> } | null = null;

/** Resolves once the active workspace's tree, environments, history and cookies are in the store. */
export function ensureApiStoreLoaded(): Promise<void> {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
  // Nothing to scope the data to yet — `App` calls `setWorkspace` as soon as there is one.
  if (workspaceId === null) return Promise.resolve();
  useApiRuntimeStore.getState().init();
  // Imported lazily to keep the cycle (watcher → store → watcher) out of module evaluation: the
  // watcher only touches the store from inside its own functions, all of which run after this.
  void import("../lib/api/sync").then((m) => m.startSyncWatcher());
  return useApiStore.getState().setWorkspace(workspaceId);
}

export const useApiStore = create<ApiState>((set, get) => ({
  workspaceId: null,
  collections: [],
  folders: [],
  requests: [],
  environments: [],
  activeEnvironmentId: null,
  history: [],
  cookies: [],
  settings: defaultApiSettings(),
  openTabs: [],
  entityTabs: [],
  tabOrder: [],
  activeTabId: null,
  loading: false,

  init: async (workspaceId) => {
    // Set before the first await: everything that persists (the open tabs, the active
    // environment) keys off it, and those writes can land while the load is still running.
    set({ workspaceId, loading: true });
    try {
      const [rawSettings, rawEnvironment, rawTabs] = await Promise.all([
        getSetting(SETTINGS_KEY).catch(() => null),
        getSetting(activeEnvironmentKey(workspaceId)).catch(() => null),
        getSetting(openTabsKey(workspaceId)).catch(() => null),
      ]);

      // Merged over the defaults rather than used as-is, so a field added in a later version
      // arrives populated on an install whose stored blob predates it.
      const stored = parseJson<StoredSettings>(rawSettings, {});
      const migrated = migrateSettings(stored);
      const settings = migrated ?? { ...defaultApiSettings(), ...stored };
      // A migration that only lived in memory would run again on every launch — and would be undone
      // the moment any other setting was written back over it.
      if (migrated !== null) void setSetting(SETTINGS_KEY, JSON.stringify(migrated)).catch(() => {});

      const [tree, environments, history, cookies] = await Promise.all([
        apiLoadTree(workspaceId),
        apiListEnvironments(workspaceId),
        apiListHistoryMeta(workspaceId, settings.historyLimit),
        apiListCookies(workspaceId),
      ]);

      // Two switches in quick succession leave two loads in flight; the one whose workspace is
      // no longer selected must not be the one that gets to publish its data.
      if (get().workspaceId !== workspaceId) return;

      const restored = parseJson<PersistedTabs | PersistedTabsV1 | null>(rawTabs, null);
      const openTabs =
        restored?.version === 1 || restored?.version === 2 ? restored.tabs.map(rehydrateTab) : [];
      // A collection or folder that was deleted while this workspace was closed leaves a tab with
      // nothing to edit, so the restore drops it rather than waiting for the first save to fail.
      const entityTabs =
        restored?.version === 2
          ? restored.entityTabs.filter(
              (tab) =>
                (tab.kind === "collection" ? tree.collections : tree.folders).some(
                  (row) => row.id === tab.entityId,
                ),
            )
          : [];
      const tabOrder = orderedTabIds(restored?.version === 2 ? restored.order : [], openTabs, entityTabs);
      const activeTabId =
        tabOrder.find((id) => id === restored?.activeTabId) ?? tabOrder[0] ?? null;

      set({
        collections: tree.collections,
        folders: tree.folders,
        requests: tree.requests,
        environments,
        activeEnvironmentId:
          rawEnvironment && environments.some((e) => e.id === rawEnvironment) ? rawEnvironment : null,
        history,
        cookies,
        settings,
        openTabs,
        entityTabs,
        tabOrder,
        activeTabId,
      });
      // The tabs were restored from disk and the tree was just read: a request one of them points
      // at may well have moved on since it was persisted.
      get().adoptRemoteChanges();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      if (get().workspaceId === workspaceId) set({ loading: false });
    }
  },

  setWorkspace: async (workspaceId) => {
    if (pendingLoad?.workspaceId === workspaceId) return pendingLoad.promise;

    // Flush what the debounce still owes the outgoing workspace — and cancel it, because from
    // here on `persistTabs` writes under the incoming workspace's key.
    persistTabs(get);
    for (const tab of get().openTabs) releaseTab(tab.id);
    // The runner and the export sheet are opened against one collection id, and that collection
    // belongs to the workspace being left — staying open would leave them pointed at a row the
    // store is about to drop.
    useApiModalStore.getState().closeApiModal();
    // Cleared rather than left to be overwritten by `init`: for the length of the load the view
    // would otherwise still be showing the workspace the user just left.
    set({
      collections: [],
      folders: [],
      requests: [],
      environments: [],
      activeEnvironmentId: null,
      history: [],
      cookies: [],
      openTabs: [],
      entityTabs: [],
      tabOrder: [],
      activeTabId: null,
    });

    const promise = get().init(workspaceId).then(async () => {
      // Conflicts are scoped to a workspace and paint its tabs; carrying the old workspace's list
      // across a switch would mark requests that aren't even on screen.
      const { useCollabStore } = await import("./collabStore");
      await useCollabStore.getState().refresh();
    });
    pendingLoad = { workspaceId, promise };
    return promise;
  },

  // ---------- refreshes ----------

  // Every call below is scoped to `workspaceId`; before the first `init` there is none, and no
  // workspace to file a write under, so each one is a no-op rather than a guess.
  reloadTree: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    const tree = await apiLoadTree(workspaceId);
    set({ collections: tree.collections, folders: tree.folders, requests: tree.requests });
    // The rows an open settings tab edits were just replaced wholesale — including, on an import
    // or a deep duplicate, by rows that no longer exist.
    syncEntityTabs(set, get);
  },

  reloadEnvironments: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    set({ environments: await apiListEnvironments(workspaceId) });
  },

  reloadHistory: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    set({ history: await apiListHistoryMeta(workspaceId, get().settings.historyLimit) });
  },

  reloadCookies: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    set({ cookies: await apiListCookies(workspaceId) });
  },

  // ---------- collections ----------

  createCollection: async (name) => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return null;
    return guarded(async () => {
      const collection = await apiCreateCollection(workspaceId, name);
      set((s) => ({ collections: [...s.collections, collection] }));
      return collection;
    });
  },

  toggleCollectionPinned: async (id) => {
    const collection = get().collections.find((c) => c.id === id);
    if (!collection) return;
    await get().updateCollection({ ...collection, pinned: !collection.pinned });
  },

  updateCollection: async (collection) => {
    const previousName = get().collections.find((c) => c.id === collection.id)?.name;
    await guarded(async () => {
      await apiUpdateCollection(collection);
      set((s) => ({
        collections: s.collections.map((c) => (c.id === collection.id ? collection : c)),
      }));
    });
    // Catches the rename done in the tree and the collection variables a script wrote, both of
    // which land here and would otherwise leave an open settings tab showing the old row.
    syncEntityTabs(set, get);
    // The share carries its own display name — it is what a guest sees while accepting an
    // invitation, before the collection exists on their machine. Best-effort: a rename is not worth
    // failing over a project that happens to be unreachable, and the next round corrects it.
    if (previousName !== undefined && previousName !== collection.name) {
      void renameShareIfShared(collection.id, collection.name);
    }
  },

  deleteCollection: async (id) => {
    await guarded(async () => {
      await apiDeleteCollection(id);
      // The cascade is in SQLite; mirroring it here avoids a full tree reload for a delete.
      const orphaned = get()
        .requests.filter((r) => r.collection_id === id)
        .map((r) => r.id);
      set((s) => ({
        collections: s.collections.filter((c) => c.id !== id),
        folders: s.folders.filter((f) => f.collection_id !== id),
        requests: s.requests.filter((r) => r.collection_id !== id),
      }));
      detachTabs(set, get, orphaned);
      // The cascade took the collection's folders too, so their settings tabs go as well.
      syncEntityTabs(set, get);
    });
  },

  duplicateCollection: async (id) => {
    await guarded(async () => {
      await apiDuplicateCollection(id);
      // A deep copy creates folders and requests too, so only a full reload is truthful.
      await get().reloadTree();
    });
  },

  reorderCollections: async (ids) => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    const previous = get().collections;
    set({ collections: sortByIds(previous, ids) });
    try {
      await apiReorderCollections(workspaceId, ids);
    } catch (e) {
      set({ collections: previous });
      pushErrorToast(String(e));
    }
  },

  // ---------- folders ----------

  createFolder: async (collectionId, parentId, name) =>
    guarded(async () => {
      const folder = await apiCreateFolder(collectionId, parentId, name);
      set((s) => ({ folders: [...s.folders, folder] }));
      return folder;
    }),

  updateFolder: async (folder) => {
    await guarded(async () => {
      await apiUpdateFolder(folder);
      set((s) => ({ folders: s.folders.map((f) => (f.id === folder.id ? folder : f)) }));
    });
    syncEntityTabs(set, get);
  },

  deleteFolder: async (id) => {
    await guarded(async () => {
      await apiDeleteFolder(id);
      const removed = descendantFolderIds(get().folders, id);
      const orphaned = get()
        .requests.filter((r) => r.folder_id !== null && removed.has(r.folder_id))
        .map((r) => r.id);
      set((s) => ({
        folders: s.folders.filter((f) => !removed.has(f.id)),
        requests: s.requests.filter((r) => r.folder_id === null || !removed.has(r.folder_id)),
      }));
      detachTabs(set, get, orphaned);
      syncEntityTabs(set, get);
    });
  },

  // ---------- requests ----------

  createRequest: async (collectionId, folderId, name, spec) =>
    guarded(async () => {
      const request = await apiCreateRequest(
        collectionId,
        folderId,
        name,
        spec.protocol,
        JSON.stringify(spec),
      );
      set((s) => ({ requests: [...s.requests, request] }));
      return request;
    }),

  updateRequest: async (request) => {
    await guarded(async () => {
      const stampedAt = await apiUpdateRequest(request);
      const saved: ApiRequestRow = { ...request, updated_at: stampedAt };
      set((s) => ({
        requests: s.requests.map((r) => (r.id === saved.id ? saved : r)),
        // A rename or an example captured from the tree is still this machine writing the row, so
        // every tab showing it moves to the new version rather than reporting a remote change.
        openTabs: s.openTabs.map((t) =>
          t.requestId === saved.id ? { ...t, rowUpdatedAt: stampedAt } : t,
        ),
      }));
    });
  },

  deleteRequest: async (id) => {
    await guarded(async () => {
      await apiDeleteRequest(id);
      set((s) => ({ requests: s.requests.filter((r) => r.id !== id) }));
      detachTabs(set, get, [id]);
    });
  },

  duplicateRequest: async (id) => {
    await guarded(async () => {
      const copy = await apiDuplicateRequest(id);
      set((s) => ({ requests: [...s.requests, copy] }));
    });
  },

  moveNode: async (kind, id, collectionId, parentId, index) => {
    const previous = { folders: get().folders, requests: get().requests };
    // Applied before the round trip on purpose: a drop that snaps back for 40ms and then lands
    // reads as a bug, so the tree commits immediately and only rolls back on a real failure.
    set(
      kind === "folder"
        ? moveFolderLocally(previous, id, collectionId, parentId, index)
        : { requests: moveRequestLocally(previous.requests, id, collectionId, parentId, index) },
    );
    try {
      await apiMoveNode(kind, id, collectionId, parentId, index);
    } catch (e) {
      set(previous);
      pushErrorToast(String(e));
      await get().reloadTree().catch(() => {});
    }
  },

  // ---------- environments ----------

  createEnvironment: async (name) => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return null;
    return guarded(async () => {
      const environment = await apiCreateEnvironment(workspaceId, name);
      set((s) => ({ environments: [...s.environments, environment] }));
      return environment;
    });
  },

  updateEnvironment: async (environment) => {
    await guarded(async () => {
      await apiUpdateEnvironment(environment);
      set((s) => ({
        environments: s.environments.map((e) => (e.id === environment.id ? environment : e)),
      }));
    });
  },

  deleteEnvironment: async (id) => {
    await guarded(async () => {
      await apiDeleteEnvironment(id);
      set((s) => ({ environments: s.environments.filter((e) => e.id !== id) }));
      if (get().activeEnvironmentId === id) get().setActiveEnvironment(null);
    });
  },

  duplicateEnvironment: async (id) => {
    await guarded(async () => {
      const copy = await apiDuplicateEnvironment(id);
      set((s) => ({ environments: [...s.environments, copy] }));
    });
  },

  setActiveEnvironment: (id) => {
    const workspaceId = get().workspaceId;
    set({ activeEnvironmentId: id });
    if (workspaceId === null) return;
    void setSetting(activeEnvironmentKey(workspaceId), id ?? "").catch(() => {});
  },

  setVariable: async (scope, key, value, collectionId) => {
    if (scope === "collection") {
      const collection = get().collections.find((c) => c.id === collectionId);
      if (!collection) return;
      const variables = upsertVariable(parseVariables(collection.variables), key, value);
      await get().updateCollection({ ...collection, variables: JSON.stringify(variables) });
      return;
    }
    const { environments, activeEnvironmentId } = get();
    const target =
      scope === "global"
        ? environments.find((e) => e.is_global)
        : environments.find((e) => e.id === activeEnvironmentId);
    if (!target) return;
    const variables = upsertVariable(parseVariables(target.variables), key, value);
    await get().updateEnvironment({ ...target, variables: JSON.stringify(variables) });
  },

  // ---------- history ----------

  addHistory: async (entry) => {
    await guarded(async () => {
      await apiAddHistory(entry);
      // Only the newest three rows keep their snapshot in memory; older ones are stripped down to
      // the metadata the list actually draws (name, method, url, status, duration, size).
      //
      // A snapshot is `JSON.stringify({ request, response })` with the response body clipped at
      // `HISTORY_BODY_LIMIT` — up to ~200 KB of text, ~400 KB of V8 heap, plus every saved example
      // of the request it was sent from. `historyLimit` defaults to 500, so a session spent
      // hammering a chatty endpoint accumulated up to a hundred megabytes of response text that
      // nothing on screen renders. `apiListHistoryMeta` was written specifically to avoid loading
      // these, and this put them straight back for every send made this session.
      //
      // Three rather than none because `HistoryList.restore` documents a real property: reopening
      // a send you just made costs no round trip. Nothing is lost past the third — the blob was
      // written to disk by `apiAddHistory` on the line above, and `restore` already falls back to
      // `apiGetHistorySnapshot` for any row whose in-memory copy is empty, which is how every row
      // from a previous session is reopened today.
      set((s) => ({
        history: [
          entry,
          ...s.history.map((h, i) => (i < 2 || h.snapshot === "" ? h : { ...h, snapshot: "" })),
        ].slice(0, s.settings.historyLimit),
      }));
    });
  },

  deleteHistory: async (id) => {
    await guarded(async () => {
      await apiDeleteHistory(id);
      set((s) => ({ history: s.history.filter((h) => h.id !== id) }));
    });
  },

  clearHistory: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    await guarded(async () => {
      await apiClearHistory(workspaceId);
      set({ history: [] });
    });
  },

  // ---------- cookies ----------

  upsertCookie: async (cookie) => {
    await guarded(async () => {
      await apiUpsertCookie(cookie);
      set((s) => {
        const index = s.cookies.findIndex(
          (c) => c.domain === cookie.domain && c.path === cookie.path && c.name === cookie.name,
        );
        if (index < 0) return { cookies: [...s.cookies, cookie] };
        const cookies = [...s.cookies];
        cookies[index] = cookie;
        return { cookies };
      });
    });
  },

  deleteCookie: async (id) => {
    await guarded(async () => {
      await apiDeleteCookie(id);
      set((s) => ({ cookies: s.cookies.filter((c) => c.id !== id) }));
    });
  },

  clearCookies: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    await guarded(async () => {
      await apiClearCookies(workspaceId);
      set({ cookies: [] });
    });
  },

  // ---------- settings ----------

  updateSettings: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await setSetting(SETTINGS_KEY, JSON.stringify(settings)).catch((e) => pushErrorToast(String(e)));
  },

  // ---------- tabs ----------

  openRequest: (requestId) => {
    const existing = get().openTabs.find((tab) => tab.requestId === requestId);
    if (existing) {
      get().setActiveTab(existing.id);
      return;
    }
    const row = get().requests.find((r) => r.id === requestId);
    if (!row) return;
    const tab: ApiTab = {
      id: newId(),
      requestId,
      draft: parseSpec(row),
      name: row.name,
      dirty: false,
      collectionId: row.collection_id,
      folderId: row.folder_id,
      rowUpdatedAt: row.updated_at,
    };
    set((s) => ({ openTabs: [...s.openTabs, tab], tabOrder: [...s.tabOrder, tab.id], activeTabId: tab.id }));
    persistTabs(get);
  },

  openScratchTab: (protocol = "http", target) => {
    const tab: ApiTab = {
      id: newId(),
      requestId: null,
      draft: defaultRequestSpec(protocol),
      name: "",
      dirty: false,
      collectionId: target?.collectionId ?? null,
      folderId: target?.folderId ?? null,
    };
    set((s) => ({ openTabs: [...s.openTabs, tab], tabOrder: [...s.tabOrder, tab.id], activeTabId: tab.id }));
    persistTabs(get);
    return tab.id;
  },

  openEntityTab: (kind, entityId) => {
    const existing = get().entityTabs.find((tab) => tab.kind === kind && tab.entityId === entityId);
    if (existing) {
      get().setActiveTab(existing.id);
      return existing.id;
    }
    const fresh = readEntity(get(), kind, entityId);
    if (fresh === null) return null;
    const tab: ApiEntityTab = { id: newId(), kind, entityId, dirty: false, ...fresh };
    set((s) => ({
      entityTabs: [...s.entityTabs, tab],
      tabOrder: [...s.tabOrder, tab.id],
      activeTabId: tab.id,
    }));
    persistTabs(get);
    return tab.id;
  },

  updateEntityDraft: (tabId, patch) => {
    set((s) => ({
      entityTabs: s.entityTabs.map((tab) =>
        tab.id === tabId ? { ...tab, draft: { ...tab.draft, ...patch }, dirty: true } : tab,
      ),
    }));
    schedulePersistTabs(get);
  },

  saveEntityTab: async (tabId) => {
    const tab = get().entityTabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    const { description, auth, preScript, postScript, variables } = tab.draft;
    // An `inherit` at this level configures nothing, which is exactly what the empty string means
    // in the column — writing the config out would make the level a decision the chain stops at.
    const authJson = auth.type === "inherit" ? "" : JSON.stringify(auth);

    if (tab.kind === "collection") {
      const collection = get().collections.find((c) => c.id === tab.entityId);
      if (!collection) return;
      await get().updateCollection({
        ...collection,
        description,
        auth: authJson,
        pre_script: preScript,
        post_script: postScript,
        variables: JSON.stringify(variables),
      });
    } else {
      const folder = get().folders.find((f) => f.id === tab.entityId);
      if (!folder) return;
      await get().updateFolder({
        ...folder,
        description,
        auth: authJson,
        pre_script: preScript,
        post_script: postScript,
      });
    }

    set((s) => ({
      entityTabs: s.entityTabs.map((entry) =>
        // Identity, not `id` alone: anything typed while the write was in flight replaced the
        // draft object, and clearing the flag then would mark those keystrokes saved without
        // them ever having been written.
        entry.id === tabId && entry.draft === tab.draft ? { ...entry, dirty: false } : entry,
      ),
    }));
    persistTabs(get);
  },

  closeTab: (tabId) => {
    const index = get().tabOrder.indexOf(tabId);
    if (index < 0) return;
    const tabOrder = get().tabOrder.filter((id) => id !== tabId);
    // Focus the neighbour that visually takes the closed tab's place, browser-style.
    const successor = tabOrder[Math.min(index, tabOrder.length - 1)];
    set({
      openTabs: get().openTabs.filter((tab) => tab.id !== tabId),
      entityTabs: get().entityTabs.filter((tab) => tab.id !== tabId),
      tabOrder,
      activeTabId: get().activeTabId === tabId ? (successor ?? null) : get().activeTabId,
    });
    persistTabs(get);
    releaseTab(tabId);
  },

  setActiveTab: (tabId) => {
    if (get().activeTabId === tabId) return;
    set({ activeTabId: tabId });
    persistTabs(get);
  },

  renameTab: (tabId, name) => {
    set((s) => ({
      openTabs: s.openTabs.map((tab) => (tab.id === tabId ? { ...tab, name, dirty: true } : tab)),
    }));
    schedulePersistTabs(get);
  },

  updateDraft: (tabId, patch) => {
    set((s) => ({
      openTabs: s.openTabs.map((tab) =>
        tab.id === tabId ? { ...tab, draft: { ...tab.draft, ...patch }, dirty: true } : tab,
      ),
    }));
    schedulePersistTabs(get);
  },

  setRequestExamples: async (requestId, examples) => {
    const row = get().requests.find((r) => r.id === requestId);
    if (!row) return;
    // Patched onto the *stored* spec, not the draft: whatever the user is editing in the tab
    // stays out of the row until they actually save it.
    const updated: ApiRequestRow = {
      ...row,
      spec: JSON.stringify({ ...parseSpec(row), examples }),
    };
    await get().updateRequest(updated);
    set((s) => ({
      openTabs: s.openTabs.map((tab) =>
        tab.requestId === requestId ? { ...tab, draft: { ...tab.draft, examples } } : tab,
      ),
    }));
    persistTabs(get);
  },

  saveTab: async (tabId, target) => {
    const tab = get().openTabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const spec = JSON.stringify(tab.draft);

    return guarded(async () => {
      if (tab.requestId) {
        const row = get().requests.find((r) => r.id === tab.requestId);
        if (!row) return null;
        const updated: ApiRequestRow = {
          ...row,
          name: tab.name || row.name,
          protocol: tab.draft.protocol,
          method: tab.draft.method,
          url: tab.draft.url,
          spec,
        };
        // The stamp comes back from the write: keeping the tab on a timestamp the row does not
        // actually have would make its own save look like somebody else's change one tick later.
        const stampedAt = await apiUpdateRequest(updated);
        const saved: ApiRequestRow = { ...updated, updated_at: stampedAt };
        set((s) => ({
          requests: s.requests.map((r) => (r.id === saved.id ? saved : r)),
          openTabs: s.openTabs.map((t) =>
            t.id === tabId
              ? { ...t, dirty: false, rowUpdatedAt: stampedAt, staleAgainst: undefined }
              : t,
          ),
        }));
        persistTabs(get);
        return saved;
      }

      const collectionId = target?.collectionId ?? tab.collectionId;
      // A scratch tab with nowhere to go isn't an error: it's the UI's cue to open the
      // "Save to collection" picker and call back with a target.
      if (!collectionId) return null;
      const folderId = target ? target.folderId : tab.folderId;
      const created = await apiCreateRequest(
        collectionId,
        folderId,
        tab.name || translate("api.untitledRequest"),
        tab.draft.protocol,
        spec,
      );
      set((s) => ({
        requests: [...s.requests, created],
        openTabs: s.openTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                requestId: created.id,
                name: created.name,
                dirty: false,
                collectionId,
                folderId,
                rowUpdatedAt: created.updated_at,
                staleAgainst: undefined,
              }
            : t,
        ),
      }));
      persistTabs(get);
      return created;
    });
  },

  adoptRemoteChanges: () => {
    const { openTabs, requests } = get();
    let touched = false;

    const next = openTabs.map((tab) => {
      if (tab.requestId === null) return tab;
      const row = requests.find((r) => r.id === tab.requestId);

      // Deleted by whoever else has it. The draft is the user's only copy now, so the tab becomes
      // a scratch one rather than closing — the same trade `detachTabs` makes for a local delete.
      if (!row) {
        touched = true;
        return { ...tab, requestId: null, collectionId: null, folderId: null, dirty: true };
      }

      // Nothing moved, or this machine is the one that moved it.
      if (tab.rowUpdatedAt === undefined || row.updated_at === tab.rowUpdatedAt) return tab;

      if (tab.dirty) {
        // Already flagged against this exact version — re-flagging would only churn the render.
        if (tab.staleAgainst === row.updated_at) return tab;
        touched = true;
        return { ...tab, staleAgainst: row.updated_at };
      }

      // Clean: the tab is a view of the row, so it follows it. Compared before replacing, because
      // an identical draft swapped for an identical draft is a re-render of the whole builder for
      // nothing — and that is what a heartbeat would turn into a flicker.
      const incoming = parseSpec(row);
      if (JSON.stringify(incoming) === JSON.stringify(tab.draft) && row.name === tab.name) {
        return { ...tab, rowUpdatedAt: row.updated_at };
      }
      touched = true;
      return {
        ...tab,
        draft: incoming,
        name: row.name,
        collectionId: row.collection_id,
        folderId: row.folder_id,
        rowUpdatedAt: row.updated_at,
        staleAgainst: undefined,
      };
    });

    if (touched) {
      set({ openTabs: next });
      persistTabs(get);
    }
    // Outside the guard: the settings tabs have their own idea of what changed, and a pull that
    // only touched a collection's auth leaves `touched` false here.
    syncEntityTabs(set, get);
  },

  takeRemoteVersion: (tabId) => {
    const tab = get().openTabs.find((t) => t.id === tabId);
    const row = tab?.requestId ? get().requests.find((r) => r.id === tab.requestId) : undefined;
    if (!tab || !row) return;
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              draft: parseSpec(row),
              name: row.name,
              dirty: false,
              rowUpdatedAt: row.updated_at,
              staleAgainst: undefined,
            }
          : t,
      ),
    }));
    persistTabs(get);
  },

  keepLocalVersion: (tabId) => {
    const row = (() => {
      const tab = get().openTabs.find((t) => t.id === tabId);
      return tab?.requestId ? get().requests.find((r) => r.id === tab.requestId) : undefined;
    })();
    if (!row) return;
    // Moving to the incoming version *without* taking its content is the whole point: the tab keeps
    // its edits, and the next save is understood as deliberately replacing what arrived rather than
    // as a fresh collision to ask about again.
    set((s) => ({
      openTabs: s.openTabs.map((t) =>
        t.id === tabId ? { ...t, rowUpdatedAt: row.updated_at, staleAgainst: undefined } : t,
      ),
    }));
    persistTabs(get);
  },

  // ---------- scope assembly ----------

  variableContext: (collectionId) => {
    const { environments, activeEnvironmentId, collections } = get();
    const environment = environments.find((e) => e.id === activeEnvironmentId && !e.is_global);
    const globals = environments.find((e) => e.is_global);
    const collection = collections.find((c) => c.id === collectionId);
    return {
      local: {},
      data: {},
      environment: parseVariables(environment?.variables),
      collection: parseVariables(collection?.variables),
      global: parseVariables(globals?.variables),
      collectionId,
    };
  },

  effectiveAuthChain: (requestId) => {
    const row = get().requests.find((r) => r.id === requestId);
    if (!row) return [];
    return [parseSpec(row).auth, ...ancestorAuth(get, row.collection_id, row.folder_id)];
  },

  authChainForTab: (tabId) => {
    const tab = get().openTabs.find((t) => t.id === tabId);
    if (!tab) return [];
    return [tab.draft.auth, ...ancestorAuth(get, tab.collectionId, tab.folderId)];
  },
}));

/** Keeps a shared collection's remote label in step with a local rename, silently. */
async function renameShareIfShared(collectionId: string, name: string) {
  const { useCollabStore } = await import("./collabStore");
  const share = useCollabStore.getState().shareFor(collectionId);
  if (share === null) return;
  // The share's own project, not the settings default. A guest has no default — so this used to
  // return here and leave the label everyone else reads stuck on the name it was shared under.
  const url = share.project_url.trim();
  if (url === "") return;
  const { supabaseRenameShare } = await import("../lib/tauri/apiCommands");
  await supabaseRenameShare(url, collectionId, name).catch(() => {});
  await useCollabStore.getState().refresh();
}

// ---------------------------------------------------------------------------
// Tab persistence
// ---------------------------------------------------------------------------

/**
 * Draft edits arrive per keystroke, and `api_open_tabs` carries the whole workbench — writing it
 * on every one would mean a SQLite round trip per character. Structural changes (open, close,
 * focus, save) write straight through; edits coalesce into a trailing write.
 */
const PERSIST_DEBOUNCE_MS = 600;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistTabs(get: () => ApiState) {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const { workspaceId, openTabs, entityTabs, tabOrder, activeTabId } = get();
  if (workspaceId === null) return;
  const payload: PersistedTabs = {
    version: 2,
    tabs: openTabs,
    entityTabs,
    order: tabOrder,
    activeTabId,
  };
  void setSetting(openTabsKey(workspaceId), JSON.stringify(payload)).catch(() => {});
}

function schedulePersistTabs(get: () => ApiState) {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistTabs(get);
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * Everything a tab owns outside this store: its live socket, its runtime buffers and its Monaco
 * models.
 *
 * A tab is the last owner of all three; whether it goes away because the user closed it or because
 * the workspace it belonged to was left behind, skipping this keeps the connection open and the
 * response body in memory for the rest of the session.
 */
function releaseTab(tabId: string) {
  const runtime = useApiRuntimeStore.getState();
  const connection = runtime.connections[tabId];
  if (connection) void apiStreamDisconnect(connection.id).catch(() => {});
  runtime.disposeTab(tabId);
  disposeTabModels(tabId);
}

/**
 * The URI schemes whose models an API tab owns. Every one of these paths is built from a tab id by
 * one of the request panels:
 *
 *   `cf-api:/body/<tab>`                        BodyPanel
 *   `cf-api:/graphql/<tab>.graphql`             GraphqlPanel (and `<tab>.variables.json`)
 *   `cf-api-auth:/<tab>/jwt-<kind>.json`        AuthPanel / EntitySettingsView
 *   `cf-api-script:/<tab>/<kind>.js`            ScriptsPanel
 *   `inmemory://api-response/<tab>/pretty|raw`  ResponsePanel
 *   `inmemory://api-snippet/<tab>`              CodeSnippetPanel
 *
 * `cf-editor:` is deliberately absent, and so is `cf-db:`: the file editor sweeps its own models
 * against the set of files *it* has open, and under the keep-mounted policy it and the DB explorer
 * are alive at the same time as this view. Disposing another owner's live model does not fail
 * here — it fails the next time that owner touches it, somewhere else entirely.
 */
const TAB_MODEL_SCHEMES = new Set(["cf-api", "cf-api-auth", "cf-api-script", "inmemory"]);

/**
 * Disposes the models a closed tab left behind.
 *
 * They are not collected on their own. `@monaco-editor/react` creates a model per `path` and only
 * ever disposes the one an editor is still holding when it unmounts — so of a tab's six-odd
 * buffers, the panel that happened to be on screen at close is the only one that goes away, and
 * everything the user tabbed *through* (the body, the two GraphQL buffers, both script buffers,
 * the other body rendering) stays live for the rest of the session.
 *
 * Two guards, and both are load-bearing:
 *
 *  1. **Deferred a turn.** `closeTab` calls this straight after `set()`, and React has not
 *     re-rendered yet — the panels are still mounted, still holding these models. Disposing one
 *     under a live editor throws on its next layout, not here.
 *  2. **Never an attached model.** Whatever is still on screen after that turn belongs to an
 *     editor that outlived the close (a tab strip mid-animation, a panel React kept), and the
 *     library disposes its own current model at unmount anyway.
 */
function disposeTabModels(tabId: string) {
  setTimeout(() => {
    // Resolved here rather than imported at the top of the file, which is what keeps monaco-editor
    // out of the entry chunk (see the note where that import used to be). It costs nothing at
    // runtime: reaching this line means an API tab existed, which means `ApiView`'s chunk — and
    // monaco with it — is already resolved, so this is a module-cache hit. The `await` adds one
    // microtask to a callback that is already a turn late by design.
    void import("../lib/monacoSetup").then(({ monaco }) => {
      const attached = new Set(
        monaco.editor.getEditors().map((editor) => editor.getModel()?.uri.toString() ?? ""),
      );
      for (const model of monaco.editor.getModels()) {
        if (!TAB_MODEL_SCHEMES.has(model.uri.scheme)) continue;
        if (!pathOwnedBy(model.uri.path, tabId)) continue;
        if (attached.has(model.uri.toString())) continue;
        model.dispose();
      }
    });
  }, 0);
}

/**
 * Whether a model URI's path was built from this tab id.
 *
 * Segment-wise rather than `includes`, so one tab id can never match another's path, and with the
 * `<tab>.graphql` / `<tab>.variables.json` stems allowed as a prefix. Tab ids are `tab-<base36>-
 * <base36>` (see `newId`), so they contain neither `/` nor `.` and the split is unambiguous.
 */
function pathOwnedBy(path: string, tabId: string): boolean {
  return path
    .split("/")
    .some((segment) => segment === tabId || segment.startsWith(`${tabId}.`));
}

/**
 * The stored settings blob, which is whatever shape the version that wrote it used — including
 * fields this one has since dropped.
 */
type StoredSettings = Partial<ApiSettings> & {
  syncCursors?: unknown;
  supabaseUrl?: string;
  supabaseReady?: boolean;
  supabaseCheckedAt?: string;
};

/**
 * Brings a settings blob written by an earlier version up to the current shape, or returns `null`
 * when there is nothing to do.
 *
 * Two migrations, applied in order, because an install that has been here since before the
 * collaboration rework needs both.
 *
 * 1. `syncCursors` — a per-workspace cursor map that the collection-shaped sync replaced with a
 *    column in `api_shared_collections`. Its presence means the blob predates the rework, and
 *    therefore that its `syncAuto: false` is the *old default*, not a choice anyone made. Merged
 *    over the new defaults it silently left background sync off, which for a collaboration feature
 *    means edits that never reach anyone, with nothing on screen to say why.
 * 2. `supabaseUrl` — the single project, from before this machine could be on several. It becomes
 *    the first entry of the list, carrying its verdict with it, so the connection every existing
 *    share points at is still named on screen after the upgrade. An empty one migrates to an empty
 *    list rather than to a nameless entry: never having set a project up is the normal state for
 *    someone who only ever accepted invitations.
 */
function migrateSettings(stored: StoredSettings): ApiSettings | null {
  let blob = stored;
  let migrated = false;

  if ("syncCursors" in blob) {
    const { syncCursors: _retired, ...rest } = blob;
    blob = { ...rest, syncAuto: defaultApiSettings().syncAuto };
    migrated = true;
  }

  if ("supabaseUrl" in blob) {
    const { supabaseUrl, supabaseReady, supabaseCheckedAt, ...rest } = blob;
    const url = (supabaseUrl ?? "").trim();
    blob = {
      ...rest,
      supabaseProjects:
        url === ""
          ? []
          : [{ url, ready: supabaseReady ?? false, checkedAt: supabaseCheckedAt ?? "" }],
    };
    migrated = true;
  }

  return migrated ? { ...defaultApiSettings(), ...blob } : null;
}

/** A tab written by an older version can be missing spec fields the editor now reads. */
function rehydrateTab(tab: ApiTab): ApiTab {
  return { ...tab, draft: { ...defaultRequestSpec(tab.draft?.protocol ?? "http"), ...tab.draft } };
}

/**
 * The strip order, repaired against the tabs that actually survived the restore.
 *
 * The stored order is authoritative for the tabs it still names; anything it has lost (a v1 blob,
 * which has no order at all) falls in behind it. Without the second half a tab would exist in the
 * store and render nowhere, which reads as data loss.
 */
function orderedTabIds(stored: string[], tabs: ApiTab[], entityTabs: ApiEntityTab[]): string[] {
  const live = new Set<string>([...tabs.map((t) => t.id), ...entityTabs.map((t) => t.id)]);
  const order = stored.filter((id) => live.has(id));
  const placed = new Set(order);
  for (const id of live) if (!placed.has(id)) order.push(id);
  return order;
}

/**
 * The current settings of a collection or folder, in the shape a tab edits them in.
 *
 * The auth default differs by kind on purpose. A folder sits under something, so "nothing
 * configured here" is `inherit` — keep looking upwards. A collection is the top of the chain, so
 * the same empty column means `none`: there is nothing above it to inherit from, and offering the
 * word would promise a lookup that cannot happen.
 */
function readEntity(
  state: ApiState,
  kind: "collection" | "folder",
  entityId: string,
): { name: string; collectionId: string; draft: EntityDraft } | null {
  if (kind === "collection") {
    const row = state.collections.find((c) => c.id === entityId);
    if (!row) return null;
    const stored = parseAuth(row.auth);
    return {
      name: row.name,
      collectionId: row.id,
      draft: {
        description: row.description,
        // An `inherit` here can only have come from an import that carried one; folded into
        // `none` so the type picker never shows a value it doesn't offer.
        auth: stored === null || stored.type === "inherit" ? defaultAuth("none") : stored,
        preScript: row.pre_script,
        postScript: row.post_script,
        variables: parseVariables(row.variables),
      },
    };
  }
  const row = state.folders.find((f) => f.id === entityId);
  if (!row) return null;
  return {
    name: row.name,
    collectionId: row.collection_id,
    draft: {
      description: row.description,
      auth: parseAuth(row.auth) ?? defaultAuth("inherit"),
      preScript: row.pre_script,
      postScript: row.post_script,
      // A folder has no variable scope of its own; the tab never shows the panel.
      variables: [],
    },
  };
}

/**
 * Brings the open settings tabs back in line with the tree.
 *
 * Same contract as `adoptRemoteChanges` has for requests, with one difference: the name is not
 * part of the draft, so it follows the row even on a dirty tab — renaming happens in the tree, and
 * a tab still labelled with the old name after a rename looks like a second, stale copy.
 *
 * A tab whose row is gone is closed rather than detached. There is no scratch equivalent of a
 * collection to fall back to, and a draft with nothing to save into is not worth keeping on screen.
 */
function syncEntityTabs(set: (partial: Partial<ApiState>) => void, get: () => ApiState) {
  if (get().entityTabs.length === 0) return;

  // Removal first, and through `closeTab`, so the strip order and the focused tab are picked by
  // the one function that knows how — then the refresh below only sees survivors.
  for (const tab of get().entityTabs) {
    if (readEntity(get(), tab.kind, tab.entityId) === null) get().closeTab(tab.id);
  }

  let touched = false;
  const next = get().entityTabs.map((tab) => {
    const fresh = readEntity(get(), tab.kind, tab.entityId);
    if (fresh === null) return tab;
    if (tab.dirty) {
      if (tab.name === fresh.name) return tab;
      touched = true;
      return { ...tab, name: fresh.name };
    }
    // Compared before replacing: an identical draft swapped for an identical draft re-renders the
    // whole settings view for nothing, which a sync heartbeat would turn into a flicker.
    if (tab.name === fresh.name && JSON.stringify(tab.draft) === JSON.stringify(fresh.draft)) {
      return tab;
    }
    touched = true;
    return { ...tab, name: fresh.name, collectionId: fresh.collectionId, draft: fresh.draft };
  });

  if (!touched) return;
  set({ entityTabs: next });
  persistTabs(get);
}

/**
 * Turns the tabs of deleted requests back into scratch tabs instead of closing them: the user's
 * unsaved edits are in the draft, and silently discarding them on a delete elsewhere in the tree
 * is the kind of data loss nobody forgives.
 */
function detachTabs(
  set: (partial: Partial<ApiState>) => void,
  get: () => ApiState,
  deletedRequestIds: string[],
) {
  const gone = new Set(deletedRequestIds);
  const affected = get().openTabs.some((tab) => tab.requestId !== null && gone.has(tab.requestId));
  if (!affected) return;
  set({
    openTabs: get().openTabs.map((tab) =>
      tab.requestId !== null && gone.has(tab.requestId)
        ? { ...tab, requestId: null, collectionId: null, folderId: null, dirty: true }
        : tab,
    ),
  });
  persistTabs(get);
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function moveRequestLocally(
  requests: ApiRequestRow[],
  id: string,
  collectionId: string,
  parentId: string | null,
  index: number,
): ApiRequestRow[] {
  const moving = requests.find((r) => r.id === id);
  if (!moving) return requests;
  const others = requests.filter((r) => r.id !== id);
  const moved: ApiRequestRow = { ...moving, collection_id: collectionId, folder_id: parentId };
  const siblings = others
    .filter((r) => r.collection_id === collectionId && r.folder_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order);
  siblings.splice(clamp(index, siblings.length), 0, moved);
  return renumber([...others, moved], siblings);
}

function moveFolderLocally(
  tree: { folders: ApiFolder[]; requests: ApiRequestRow[] },
  id: string,
  collectionId: string,
  parentId: string | null,
  index: number,
): { folders: ApiFolder[]; requests: ApiRequestRow[] } {
  const moving = tree.folders.find((f) => f.id === id);
  if (!moving) return tree;
  const others = tree.folders.filter((f) => f.id !== id);
  const moved: ApiFolder = { ...moving, collection_id: collectionId, parent_id: parentId };
  const siblings = others
    .filter((f) => f.collection_id === collectionId && f.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order);
  siblings.splice(clamp(index, siblings.length), 0, moved);

  let folders = renumber([...others, moved], siblings);
  let requests = tree.requests;
  // Dragging a folder across collections takes its whole subtree with it; without this the
  // moved children would keep pointing at the old collection until the next reload.
  if (moving.collection_id !== collectionId) {
    const subtree = descendantFolderIds(folders, id);
    folders = folders.map((f) => (subtree.has(f.id) ? { ...f, collection_id: collectionId } : f));
    requests = requests.map((r) =>
      r.folder_id !== null && subtree.has(r.folder_id) ? { ...r, collection_id: collectionId } : r,
    );
  }
  return { folders, requests };
}

/** Rewrites `sort_order` for the destination's children only; everything else keeps its own. */
function renumber<T extends { id: string; sort_order: number }>(all: T[], ordered: T[]): T[] {
  const positions = new Map(ordered.map((item, position) => [item.id, position]));
  return all.map((item) => {
    const position = positions.get(item.id);
    return position === undefined ? item : { ...item, sort_order: position };
  });
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

/** `id` itself plus every folder beneath it. */
function descendantFolderIds(folders: ApiFolder[], id: string): Set<string> {
  const found = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parent_id !== null && found.has(folder.parent_id) && !found.has(folder.id)) {
        found.add(folder.id);
        grew = true;
      }
    }
  }
  return found;
}

/** Anything `ids` doesn't mention keeps its relative order at the end, as the backend does. */
function sortByIds<T extends { id: string; sort_order: number }>(items: T[], ids: string[]): T[] {
  const position = new Map(ids.map((id, index) => [id, index]));
  const rank = (item: T) => position.get(item.id) ?? Number.MAX_SAFE_INTEGER;
  return [...items]
    .sort((a, b) => rank(a) - rank(b))
    .map((item, index) => ({ ...item, sort_order: index }));
}

/** Request auth first, then each folder up to the root, then the collection. */
function ancestorAuth(
  get: () => ApiState,
  collectionId: string | null,
  folderId: string | null,
): (AuthConfig | null)[] {
  const { folders, collections } = get();
  const chain: (AuthConfig | null)[] = [];
  const seen = new Set<string>();
  let current = folderId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    chain.push(parseAuth(folder.auth));
    current = folder.parent_id;
  }
  const collection = collections.find((c) => c.id === collectionId);
  chain.push(collection ? parseAuth(collection.auth) : null);
  return chain;
}

// ---------------------------------------------------------------------------
// JSON blobs
// ---------------------------------------------------------------------------

/** A row whose `spec` is corrupt still opens, as an empty request of its protocol. */
function parseSpec(row: ApiRequestRow): ApiRequestSpec {
  const fallback = defaultRequestSpec(row.protocol);
  return { ...fallback, ...parseJson<Partial<ApiRequestSpec>>(row.spec, {}) };
}

function parseAuth(json: string): AuthConfig | null {
  return parseJson<AuthConfig | null>(json, null);
}

function parseVariables(json: string | undefined): ApiVariable[] {
  const parsed = parseJson<ApiVariable[]>(json ?? null, []);
  return Array.isArray(parsed) ? parsed : [];
}

function upsertVariable(variables: ApiVariable[], key: string, value: string): ApiVariable[] {
  const index = variables.findIndex((variable) => variable.key === key);
  if (index < 0) {
    return [
      ...variables,
      {
        id: newId(),
        key,
        initialValue: "",
        currentValue: value,
        secret: false,
        enabled: true,
        description: "",
      },
    ];
  }
  const next = [...variables];
  next[index] = { ...next[index], currentValue: value, enabled: true };
  return next;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Same lookup `useT()` does, minus the hook — a store isn't a component. */
function translate(key: TranslationKey): string {
  const language = useLanguageStore.getState().language;
  return translations[language][key] ?? translations.en[key] ?? key;
}

/** Every store action funnels its failure into one toast; nothing here is worth a modal. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    pushErrorToast(String(e));
    return null;
  }
}

function newId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
