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
  apiListHistory,
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
import { translations, type TranslationKey } from "../lib/i18n/translations";
import { pushErrorToast } from "./toastStore";
import { useLanguageStore } from "./languageStore";
import { useApiRuntimeStore } from "./apiRuntimeStore";
import { useApiModalStore } from "./apiModalStore";
import { useWorkspaceStore } from "./workspaceStore";
import { defaultApiSettings, defaultRequestSpec } from "../types/api";
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
}

/** Persisted shape of `api_open_tabs`. Versioned so a later change can be migrated, not guessed. */
interface PersistedTabs {
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
      const settings = { ...defaultApiSettings(), ...parseJson<Partial<ApiSettings>>(rawSettings, {}) };

      const [tree, environments, history, cookies] = await Promise.all([
        apiLoadTree(workspaceId),
        apiListEnvironments(workspaceId),
        apiListHistory(workspaceId, settings.historyLimit),
        apiListCookies(workspaceId),
      ]);

      // Two switches in quick succession leave two loads in flight; the one whose workspace is
      // no longer selected must not be the one that gets to publish its data.
      if (get().workspaceId !== workspaceId) return;

      const restored = parseJson<PersistedTabs | null>(rawTabs, null);
      const openTabs = restored?.version === 1 ? restored.tabs.map(rehydrateTab) : [];
      const activeTabId =
        openTabs.find((tab) => tab.id === restored?.activeTabId)?.id ?? openTabs[0]?.id ?? null;

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
        activeTabId,
      });
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
      activeTabId: null,
    });

    const promise = get().init(workspaceId);
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
  },

  reloadEnvironments: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    set({ environments: await apiListEnvironments(workspaceId) });
  },

  reloadHistory: async () => {
    const workspaceId = get().workspaceId;
    if (workspaceId === null) return;
    set({ history: await apiListHistory(workspaceId, get().settings.historyLimit) });
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
    await guarded(async () => {
      await apiUpdateCollection(collection);
      set((s) => ({
        collections: s.collections.map((c) => (c.id === collection.id ? collection : c)),
      }));
    });
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
      await apiUpdateRequest(request);
      set((s) => ({ requests: s.requests.map((r) => (r.id === request.id ? request : r)) }));
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
      set((s) => ({ history: [entry, ...s.history].slice(0, s.settings.historyLimit) }));
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
    };
    set((s) => ({ openTabs: [...s.openTabs, tab], activeTabId: tab.id }));
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
    set((s) => ({ openTabs: [...s.openTabs, tab], activeTabId: tab.id }));
    persistTabs(get);
    return tab.id;
  },

  closeTab: (tabId) => {
    const index = get().openTabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const openTabs = get().openTabs.filter((tab) => tab.id !== tabId);
    // Focus the neighbour that visually takes the closed tab's place, browser-style.
    const successor = openTabs[Math.min(index, openTabs.length - 1)];
    set({
      openTabs,
      activeTabId: get().activeTabId === tabId ? (successor?.id ?? null) : get().activeTabId,
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
        await apiUpdateRequest(updated);
        set((s) => ({
          requests: s.requests.map((r) => (r.id === updated.id ? updated : r)),
          openTabs: s.openTabs.map((t) => (t.id === tabId ? { ...t, dirty: false } : t)),
        }));
        persistTabs(get);
        return updated;
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
            ? { ...t, requestId: created.id, name: created.name, dirty: false, collectionId, folderId }
            : t,
        ),
      }));
      persistTabs(get);
      return created;
    });
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
  const { workspaceId, openTabs, activeTabId } = get();
  if (workspaceId === null) return;
  const payload: PersistedTabs = { version: 1, tabs: openTabs, activeTabId };
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
 * Everything a tab owns outside this store: its live socket and its runtime buffers.
 *
 * A tab is the last owner of both; whether it goes away because the user closed it or because
 * the workspace it belonged to was left behind, skipping this keeps the connection open and the
 * response body in memory for the rest of the session.
 */
function releaseTab(tabId: string) {
  const runtime = useApiRuntimeStore.getState();
  const connection = runtime.connections[tabId];
  if (connection) void apiStreamDisconnect(connection.id).catch(() => {});
  runtime.disposeTab(tabId);
}

/** A tab written by an older version can be missing spec fields the editor now reads. */
function rehydrateTab(tab: ApiTab): ApiTab {
  return { ...tab, draft: { ...defaultRequestSpec(tab.draft?.protocol ?? "http"), ...tab.draft } };
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
