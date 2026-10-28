import { create } from "zustand";
import { azureFound, azureGroups, azureHealth, azureResources, azureSubscriptions, azureTopology } from "../lib/tauri/azureCommands";
import { getSetting, setSetting } from "../lib/tauri/commands";
import type { AzGroup, AzHealth, AzResource, AzSubscriptions, AzTopology } from "../types/containers";

/**
 * The Azure pages of the Contenedores panel: whether `az` is here, the subscription and group picked,
 * and what was read for them. Read-only — nothing here changes a resource.
 *
 * The pick is one setting, `azure_view_prefs`, which `cf azure` and the AI's `azure` tool read too:
 * "why does this fail?" is asked about what the user is looking at.
 */

const PREFS_KEY = "azure_view_prefs";

export interface AzurePrefs {
  subscription: string;
  /** `""` = every group of the subscription. */
  group: string;
}

/** One read for a scope: the answer, its error, and when (0 = never; a placeholder while it loads). */
export interface Read<T> {
  value: T | null;
  error: string | null;
  loading: boolean;
  at: number;
}

/** How long an answer stands before a visit asks Azure again. */
export const AZURE_FRESH_MS = 2 * 60_000;

export const scopeKey = (subscription: string, group: string) => `${subscription}|${group}`;

interface AzureState {
  /** `az` is installed; `null` until asked. */
  found: boolean | null;
  subscriptions: Read<AzSubscriptions>;
  groups: Record<string, Read<AzGroup[]>>;
  prefs: AzurePrefs;
  prefsLoaded: boolean;
  resources: Record<string, Read<AzResource[]>>;
  health: Record<string, Read<AzHealth[]>>;
  topology: Record<string, Read<AzTopology>>;
  /** The resource whose page is open over the list. */
  selected: AzResource | null;

  detect: () => Promise<void>;
  loadPrefs: () => Promise<void>;
  setSubscription: (subscription: string) => void;
  setGroup: (group: string) => void;
  loadSubscriptions: (force?: boolean) => Promise<void>;
  loadGroups: (subscription: string, force?: boolean) => Promise<void>;
  loadResources: (force?: boolean) => Promise<void>;
  loadHealth: (force?: boolean) => Promise<void>;
  loadTopology: (force?: boolean, group?: string) => Promise<void>;
  select: (resource: AzResource | null) => void;
}

const EMPTY: Read<never> = { value: null, error: null, loading: false, at: 0 };
const inflight = new Map<string, Promise<void>>();

function fresh(read: Read<unknown> | undefined, force?: boolean): boolean {
  return !force && !!read && (read.loading || (read.at > 0 && Date.now() - read.at < AZURE_FRESH_MS && !read.error));
}

/** Reads once per key at a time, writing a placeholder first so a page shows it is loading. */
async function load<T>(key: string, current: Read<T> | undefined, force: boolean | undefined, write: (read: Read<T>) => void, read: () => Promise<T>) {
  if (fresh(current, force)) return inflight.get(key);
  const running = inflight.get(key);
  if (running) return running;
  write({ value: current?.value ?? null, error: null, loading: true, at: current?.at ?? 0 });
  const task = read()
    .then((value) => write({ value, error: null, loading: false, at: Date.now() }))
    .catch((e: unknown) => write({ value: current?.value ?? null, error: String(e), loading: false, at: Date.now() }))
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export const useAzureStore = create<AzureState>((set, get) => {
  const savePrefs = (prefs: AzurePrefs) => void setSetting(PREFS_KEY, JSON.stringify(prefs)).catch(() => {});
  return {
    found: null,
    subscriptions: EMPTY,
    groups: {},
    prefs: { subscription: "", group: "" },
    prefsLoaded: false,
    resources: {},
    health: {},
    topology: {},
    selected: null,

    detect: async () => {
      const found = await azureFound().catch(() => false);
      set({ found });
    },
    loadPrefs: async () => {
      if (get().prefsLoaded) return;
      try {
        const raw = await getSetting(PREFS_KEY);
        const parsed = raw ? (JSON.parse(raw) as Partial<AzurePrefs>) : {};
        set({ prefs: { subscription: typeof parsed.subscription === "string" ? parsed.subscription : "", group: typeof parsed.group === "string" ? parsed.group : "" }, prefsLoaded: true });
      } catch {
        set({ prefsLoaded: true });
      }
    },
    setSubscription: (subscription) => {
      if (subscription === get().prefs.subscription) return;
      const prefs = { subscription, group: "" };
      set({ prefs, selected: null });
      savePrefs(prefs);
    },
    setGroup: (group) => {
      if (group === get().prefs.group) return;
      const prefs = { ...get().prefs, group };
      set({ prefs, selected: null });
      savePrefs(prefs);
    },
    loadSubscriptions: (force) =>
      load("subs", get().subscriptions, force, (read) => {
        set({ subscriptions: read });
        // Nothing picked yet (or the one picked is gone): az's default.
        const list = read.value?.contexts ?? [];
        const { subscription } = get().prefs;
        if (!read.loading && list.length && !list.some((c) => c.id === subscription)) {
          get().setSubscription((list.find((c) => c.default) ?? list[0]).id);
        }
      }, azureSubscriptions),
    loadGroups: (subscription, force) =>
      load(`groups|${subscription}`, get().groups[subscription], force, (read) => set({ groups: { ...get().groups, [subscription]: read } }), () => azureGroups(subscription)),
    loadResources: (force) => {
      const { subscription, group } = get().prefs;
      if (!subscription) return Promise.resolve();
      const key = scopeKey(subscription, group);
      return load(`res|${key}`, get().resources[key], force, (read) => set({ resources: { ...get().resources, [key]: read } }), () => azureResources(subscription, group || null));
    },
    loadHealth: (force) => {
      const { subscription, group } = get().prefs;
      if (!subscription) return Promise.resolve();
      const key = scopeKey(subscription, group);
      return load(`health|${key}`, get().health[key], force, (read) => set({ health: { ...get().health, [key]: read } }), () => azureHealth(subscription, group || null));
    },
    loadTopology: (force, group) => {
      const { subscription } = get().prefs;
      const scope = group ?? get().prefs.group;
      if (!subscription) return Promise.resolve();
      const key = scopeKey(subscription, scope);
      return load(`topo|${key}`, get().topology[key], force, (read) => set({ topology: { ...get().topology, [key]: read } }), () => azureTopology(subscription, scope || null));
    },
    select: (selected) => set({ selected }),
  };
});

/** Resource Health by resource id (lower-cased), for a scope's rows. */
export function healthById(list: AzHealth[] | null | undefined): Map<string, AzHealth> {
  return new Map((list ?? []).map((h) => [h.id.toLowerCase(), h]));
}
