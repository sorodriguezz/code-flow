import { WINDOW } from "./windowIdentity";

/**
 * What the main window does with its own copy of an app while that app lives in an island.
 *
 * Every webview has its own zustand stores, so detaching Notes leaves the main window holding the
 * tree it had loaded at that moment. Nothing told it about what the island wrote afterwards — the
 * workspace-scoped stores only re-read on a workspace switch — so the island coming back showed the
 * old tree, and detaching again (a fresh webview, a fresh read) showed the new one. Worse, the stale
 * copy could still *write*: the API client and the database persist their open tabs from memory, and
 * a workspace switch in the main window flushed the old tabs over the island's.
 *
 * So the main window lets go of the app while it is out and reads it again when it comes back:
 *
 * - **before it leaves** (`flushBeforeIsland`): what this window still owes the database is written,
 *   so the island boots onto it;
 * - **when it has left** (`islandOpened`): the copy is dropped — nothing stale on screen, nothing
 *   stale written back, and the store's workspace subscription goes quiet the way it does for a
 *   store that was never loaded;
 * - **when it is back** (`islandReturned`): read again from the database, which holds everything
 *   the island did.
 *
 * Stores register themselves at module scope; one that was never imported here has nothing to drop.
 * Main window only — an island never holds another island's app.
 */
export interface IslandApp {
  /** Writes what this window still holds and the database does not. */
  flush?: () => Promise<void>;
  /** Drops this window's copy. Only called when `isLoaded()`. */
  release?: () => void;
  /** Whether this window has loaded the app at all. */
  isLoaded: () => boolean;
  /** Reads it again from the database. */
  reload: () => Promise<void>;
}

const apps = new Map<string, IslandApp[]>();
/** Apps this window let go of, so they come back loaded even though `isLoaded()` now says no. */
const released = new Set<IslandApp>();

/** Registers a store under the rail ids (`appKey`) whose island holds it. */
export function registerIslandApp(refIds: string[], app: IslandApp): void {
  for (const refId of refIds) apps.set(refId, [...(apps.get(refId) ?? []), app]);
}

export async function flushBeforeIsland(refId: string): Promise<void> {
  if (!WINDOW.main) return;
  await Promise.all((apps.get(refId) ?? []).map((app) => (app.isLoaded() ? app.flush?.().catch(() => {}) : undefined)));
}

export function islandOpened(refId: string): void {
  if (!WINDOW.main) return;
  for (const app of apps.get(refId) ?? []) {
    if (!app.release || !app.isLoaded()) continue;
    // Flushed again rather than trusted: a tray restore reopens islands without passing the rail.
    void (app.flush?.() ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        app.release?.();
        released.add(app);
      });
  }
}

export function islandReturned(refId: string): void {
  if (!WINDOW.main) return;
  for (const app of apps.get(refId) ?? []) {
    const wasReleased = released.delete(app);
    if (wasReleased || app.isLoaded()) void app.reload().catch(() => {});
  }
}

/** Tests only. */
export function resetIslandSyncForTests(): void {
  apps.clear();
  released.clear();
}
