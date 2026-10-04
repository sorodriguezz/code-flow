import { useMemo } from "react";
import { create } from "zustand";
import {
  dbDriverDeleteFiles,
  dbDriverDeleteRuntime,
  dbDriverDeleteSettings,
  dbDriverDownload,
  dbDriverSaveSettings,
  dbDriverSettings,
  dbDriversOverview,
} from "../lib/tauri/dbCommands";
import { onDbDriverDownload } from "../lib/tauri/events";
import {
  DRIVER_CATALOG,
  customDriverDef,
  driverEngineInfo,
  driverFilesError,
  effectiveDriver,
  isJvmDriver,
  rowDriverId,
  type DriverDef,
  type DriverFilesError,
  type DriverPaging,
} from "../lib/db/drivers";
import { useDbModalStore } from "./dbModalStore";
import type {
  DbConnectionRow,
  DbDriverProgress,
  DbDriverSettings,
  DbDriverStatus,
  DbDriversOverview,
  DbEngineInfo,
  DbKind,
} from "../types/database";

/**
 * The database drivers: which files are on disk, what the user changed, and the download in flight.
 *
 * Its own store rather than part of `dbStore`, because none of it belongs to a workspace — a driver
 * downloaded for one workspace's Snowflake connection serves every workspace's — and because the
 * "Incomplete configuration" question it asks is raised from wherever a connect happens: the
 * connection dialog's Test, the explorer's Connect, a tree expansion, a console run. Each of those
 * calls `ask` (or `offerDriverDownload`) and retries once it resolves `true`.
 */

/** The question on screen: a driver's files aren't here. */
export interface DriverPrompt {
  driverId: string;
  /** `missing`: a download fixes it. `manual`: the vendor's files have to be added by hand. */
  kind: "missing" | "manual";
  message: string;
  /** When it was asked — what an overview has to be newer than to answer it. */
  askedAt: number;
}

interface DriverState {
  overview: DbDriversOverview | null;
  /** When `overview` was read. */
  overviewAt: number;
  settings: DbDriverSettings[];
  /** Every step reported by the downloads of this session, the latest per driver and item. */
  progress: DbDriverProgress[];
  /** The drivers being downloaded. The backend runs one download at a time and queues the rest. */
  downloading: string[];
  /** Why each driver's last download failed. Cleared when the next one starts. */
  errors: Record<string, string>;
  prompt: DriverPrompt | null;
  /**
   * A request for the connection dialog to show a driver's settings — from the prompt's "Open
   * driver settings", when the dialog is already open. `nonce` makes asking twice a change.
   */
  focus: { driverId: string; nonce: number } | null;

  /** Reads everything once, and listens for download progress from then on. */
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Downloads what a driver lacks. `true` once it is all there. */
  download: (driverId: string) => Promise<boolean>;
  deleteFiles: (driverId: string) => Promise<void>;
  deleteRuntime: () => Promise<void>;
  saveSettings: (settings: DbDriverSettings) => Promise<boolean>;
  deleteSettings: (id: string) => Promise<boolean>;
  /** Asks to download a driver's files. Resolves `true` once they are downloaded, `false` when the
   *  user declined or the files can only be added by hand. */
  ask: (error: DriverFilesError) => Promise<boolean>;
  /** Closes the question with its answer. */
  answer: (downloaded: boolean) => void;
  /** Shows a driver's settings in the connection dialog, opening the dialog when it is closed. */
  showDriver: (driverId: string) => void;
}

/** The downloads in flight, so a second ask for the same driver waits on the first. */
const inflight = new Map<string, Promise<boolean>>();
/** Whoever is waiting on the open question. */
let waiting: ((downloaded: boolean) => void)[] = [];
let listening: Promise<void> | null = null;

export const useDriverStore = create<DriverState>((set, get) => ({
  overview: null,
  overviewAt: 0,
  settings: [],
  progress: [],
  downloading: [],
  errors: {},
  prompt: null,
  focus: null,

  load: async () => {
    if (!listening) {
      listening = onDbDriverDownload((event) => {
        set((s) => ({
          progress: [
            ...s.progress.filter((entry) => !(entry.driverId === event.driverId && entry.item === event.item)),
            event,
          ],
        }));
      })
        .then(() => undefined)
        .catch(() => undefined);
    }
    await get().refresh();
  },

  refresh: async () => {
    try {
      const [overview, settings] = await Promise.all([dbDriversOverview(), dbDriverSettings()]);
      set({ overview, settings, overviewAt: Date.now() });
    } catch {
      // Outside the Tauri shell, or a backend without drivers: the list still draws from the
      // catalogue, just without "downloaded" marks.
    }
  },

  download: (driverId) => {
    const running = inflight.get(driverId);
    if (running) return running;
    const run = (async () => {
      set((s) => ({
        downloading: [...s.downloading, driverId],
        errors: withoutKey(s.errors, driverId),
        progress: s.progress.filter((entry) => entry.driverId !== driverId),
      }));
      try {
        await dbDriverDownload(driverId);
        return true;
      } catch (e) {
        set((s) => ({ errors: { ...s.errors, [driverId]: String(e) } }));
        return false;
      } finally {
        inflight.delete(driverId);
        set((s) => ({ downloading: s.downloading.filter((id) => id !== driverId) }));
        // The runtime may have arrived with it, which changes every other driver's readiness too.
        await get().refresh();
      }
    })();
    inflight.set(driverId, run);
    return run;
  },

  deleteFiles: async (driverId) => {
    await dbDriverDeleteFiles(driverId);
    await get().refresh();
  },

  deleteRuntime: async () => {
    await dbDriverDeleteRuntime();
    await get().refresh();
  },

  saveSettings: async (settings) => {
    try {
      await dbDriverSaveSettings(settings);
      await get().refresh();
      return true;
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [settings.id]: String(e) } }));
      return false;
    }
  },

  deleteSettings: async (id) => {
    try {
      await dbDriverDeleteSettings(id);
      await get().refresh();
      return true;
    } catch (e) {
      set((s) => ({ errors: { ...s.errors, [id]: String(e) } }));
      return false;
    }
  },

  ask: (error) => {
    const current = get().prompt;
    // A second failure for the driver already being asked about joins the question on screen
    // rather than stacking another one over it — a tree expanding three schemas fails three times.
    if (current && current.driverId !== error.driverId) {
      get().answer(false);
    }
    set({ prompt: { driverId: error.driverId, kind: error.kind, message: error.message, askedAt: Date.now() } });
    void get().refresh();
    return new Promise<boolean>((resolve) => {
      waiting.push(resolve);
    });
  },

  answer: (downloaded) => {
    const resolvers = waiting;
    waiting = [];
    set({ prompt: null });
    for (const resolve of resolvers) resolve(downloaded);
  },

  showDriver: (driverId) => {
    const modal = useDbModalStore.getState().modal;
    const dialogOpen =
      modal?.kind === "connection" ||
      modal?.kind === "connections" ||
      modal?.kind === "newConnection" ||
      modal?.kind === "drivers";
    if (dialogOpen) set({ focus: { driverId, nonce: Date.now() } });
    else useDbModalStore.getState().openDbModal({ kind: "drivers", driverId });
  },
}));

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/**
 * Offers to download a driver when `error` says its files are missing, and runs `retry` once they
 * are. `true` when it did — the caller then has nothing more to say about the error.
 */
export function offerDriverDownload(error: unknown, retry?: () => void): boolean {
  const missing = driverFilesError(error);
  if (!missing) return false;
  void useDriverStore
    .getState()
    .ask(missing)
    .then((downloaded) => {
      if (downloaded) retry?.();
    });
  return true;
}

/** Every driver the user can pick: the catalogue's with their changes, then the ones they added. */
export function allDrivers(settings: readonly DbDriverSettings[]): DriverDef[] {
  return [
    ...DRIVER_CATALOG.map((def) => effectiveDriver(def.id, settings) ?? def),
    ...settings.filter((entry) => entry.custom).map(customDriverDef),
  ];
}

/** `allDrivers`, kept in step with the store. */
export function useAllDrivers(): DriverDef[] {
  const settings = useDriverStore((s) => s.settings);
  return useMemo(() => allDrivers(settings), [settings]);
}

/**
 * A saved connection's driver, and its engine's metadata dressed for that driver — the name a tab
 * or a toolbar shows ("Snowflake", not "JDBC"), its tile, its default port.
 */
export function useConnectionDriver(
  row: Pick<DbConnectionRow, "kind" | "spec"> | null | undefined,
): { driver: DriverDef | null; engine: DbEngineInfo | null } {
  const settings = useDriverStore((s) => s.settings);
  const kind = row?.kind;
  const spec = row?.spec;
  return useMemo(() => {
    if (!kind || spec === undefined) return { driver: null, engine: null };
    const driver = effectiveDriver(rowDriverId({ kind, spec }), settings);
    return { driver, engine: driverEngineInfo(driver, kind) };
  }, [kind, spec, settings]);
}

/** A driver as the user has it, or `null` for an id nobody knows. */
export function useDriverDef(id: string): DriverDef | null {
  const settings = useDriverStore((s) => s.settings);
  return useMemo(() => (id ? effectiveDriver(id, settings) : null), [id, settings]);
}

/** The settings a driver has, or an empty set to start editing from. */
export function settingsFor(id: string, settings: readonly DbDriverSettings[]): DbDriverSettings {
  return (
    settings.find((entry) => entry.id === id) ?? {
      id,
      custom: false,
      name: "",
      basedOn: "",
      class: "",
      files: [],
      urls: [],
      properties: [],
      vmOptions: "",
      vmEnv: [],
      javaHome: "",
    }
  );
}

export interface DriverReadiness {
  /** Whether it runs in the bridge at all. A native driver is always ready. */
  jvm: boolean;
  /** Its files are on disk (or it has none to fetch). */
  files: boolean;
  /** The runtime it runs on is there — downloaded, or a Java home of the user's own. */
  runtime: boolean;
  /** Its files can only be added by hand, and none have been. */
  manual: boolean;
  status: DbDriverStatus | null;
}

/** What a driver still lacks before a connection can use it. */
export function driverReadiness(
  def: DriverDef,
  overview: DbDriversOverview | null,
  settings: readonly DbDriverSettings[],
): DriverReadiness {
  if (!isJvmDriver(def)) return { jvm: false, files: true, runtime: true, manual: false, status: null };
  const status = overview?.drivers.find((entry) => entry.id === def.id) ?? null;
  const own = settings.find((entry) => entry.id === def.id);
  const hasCatalogFiles = (def.files ?? []).length > 0;
  const hasUserFiles = (own?.files ?? []).length > 0;
  return {
    jvm: true,
    // Unknown until the overview is read: assume missing, so the form offers the download rather
    // than promising a connect that would fail.
    files: status ? status.ready : false,
    runtime: Boolean(own?.javaHome.trim()) || Boolean(overview?.runtime.ready),
    manual: !hasCatalogFiles && !hasUserFiles,
    status,
  };
}

/**
 * The kind whose SQL a connection's generated statements are written in — the drafts, the drops,
 * the filter a foreign key opens with.
 *
 * Its own kind, except for a JDBC connection, which writes like the engine its driver's dialect
 * matches: backticks and backslash escapes for Hive, Spark, BigQuery and ClickHouse (MySQL's
 * rules), T-SQL for jTDS and Sybase, Oracle's for the legacy Oracle driver. The rest stay `jdbc`,
 * which is standard SQL with double-quoted names. Only for writing SQL: what the tree looks like is
 * still the connection's own kind.
 */
export function sqlKindOf(row: Pick<DbConnectionRow, "kind" | "spec">): DbKind {
  if (row.kind !== "jdbc") return row.kind;
  switch (effectiveDriver(rowDriverId(row), useDriverStore.getState().settings)?.sql?.dialect) {
    case "backtick":
      return "mysql";
    case "tsql":
      return "sqlserver";
    case "oracle":
      return "oracle";
    default:
      return "jdbc";
  }
}

/** How a JDBC connection's engine pages rows, for the drafts that cap a `SELECT`. */
export function sqlPagingOf(row: Pick<DbConnectionRow, "kind" | "spec">): DriverPaging | undefined {
  if (row.kind !== "jdbc") return undefined;
  return effectiveDriver(rowDriverId(row), useDriverStore.getState().settings)?.sql?.paging;
}
