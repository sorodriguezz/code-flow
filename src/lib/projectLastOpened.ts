import { getSetting, setSetting } from "./tauri/commands";

/**
 * When each repository was last opened, for the palette's «most recent first» order.
 *
 * One small JSON map `id -> epoch ms` in app settings. It is read once, merged into (never replaced
 * by) what the app records meanwhile, and written back debounced and only after that read landed — a
 * record made before the read returns must not overwrite the stored history with a one-entry map.
 */
export const PROJECT_LAST_OPENED_KEY = "project_last_opened";
export const PROJECT_LAST_OPENED_CAP = 200;
const WRITE_DEBOUNCE_MS = 1500;

export type LastOpened = Record<string, number>;

export function parseLastOpened(raw: string | null | undefined): LastOpened {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: LastOpened = {};
    for (const [id, at] of Object.entries(value)) {
      if (typeof at === "number" && Number.isFinite(at) && at > 0) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** The newer stamp per id, trimmed to the `cap` most recent. */
export function mergeLastOpened(a: LastOpened, b: LastOpened, cap = PROJECT_LAST_OPENED_CAP): LastOpened {
  const merged: LastOpened = { ...a };
  for (const [id, at] of Object.entries(b)) merged[id] = Math.max(merged[id] ?? 0, at);
  return Object.fromEntries(
    Object.entries(merged)
      .sort((x, y) => y[1] - x[1])
      .slice(0, cap),
  );
}

/**
 * Most recently opened first; never-opened ones keep their given (sidebar) order after them, and
 * `currentId` — already open, so the least useful jump — goes last.
 */
export function sortByLastOpened<T extends { id: string }>(
  rows: readonly T[],
  opened: LastOpened,
  currentId?: string | null,
): T[] {
  const rank = (row: T) => (row.id === currentId ? -1 : (opened[row.id] ?? 0));
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => rank(y.row) - rank(x.row) || x.index - y.index)
    .map(({ row }) => row);
}

let memory: LastOpened = {};
let loaded: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

export function ensureLastOpenedLoaded(): Promise<void> {
  loaded ??= (async () => {
    try {
      memory = mergeLastOpened(parseLastOpened(await getSetting(PROJECT_LAST_OPENED_KEY)), memory);
    } catch {
      /* unreadable: start from what this session records */
    }
  })();
  return loaded;
}

/** The map as it is now — a snapshot, `{}` until the first read lands. */
export const lastOpenedNow = (): LastOpened => memory;

export function recordProjectOpened(id: string, now = Date.now()): void {
  memory = mergeLastOpened(memory, { [id]: now });
  void ensureLastOpenedLoaded().then(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      void Promise.resolve()
        .then(() => setSetting(PROJECT_LAST_OPENED_KEY, JSON.stringify(memory)))
        .catch(() => {});
    }, WRITE_DEBOUNCE_MS);
  });
}

/** Test seam. */
export function resetLastOpenedForTests(): void {
  memory = {};
  loaded = null;
  clearTimeout(timer);
}
