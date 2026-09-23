import { listen } from "@tauri-apps/api/event";
import { WINDOW } from "./windowIdentity";

/**
 * Settings written in one window, re-read in every other.
 *
 * # Why this exists
 *
 * Settings is a screen of the main window, and every store reads its rows once, at boot. So an
 * accent picked there — or light/dark, an editor scheme, the language — used to reach a detached
 * window ("isla") only when that window was next opened: the main window repainted behind a
 * satellite still wearing the old colours. Nothing was wrong with any store; nobody told them.
 *
 * `set_setting` now announces every write as `settings:changed` (see `commands/settings.rs`), and
 * this is the listening half. It is a separate channel from `lib/windowBus` on purpose: the bus is
 * for what was never a row, and a setting is a row — the announcement names the key and each store
 * re-reads it through the loader it already has, the same shape `state:invalidate` uses.
 *
 * # The rule for a store
 *
 * **A store that holds a setting another window can change registers here, in its own file** — the
 * same rule as its workspace subscription. Registering from `App` would cover the main window only,
 * which is exactly how this went unnoticed; registering from the store covers every window that
 * loads it, and only those.
 *
 * The window that wrote the row hears its own echo too, and drops it: it already has the value, and
 * re-reading on top of an optimistic `set` is how two fast clicks would flicker back to the first.
 */

/** Mirrors `SettingChanged` in `src-tauri/src/commands/settings.rs`. */
interface SettingChanged {
  key: string;
  /** The label of the window whose `set_setting` wrote the row. */
  origin: string;
}

type KeyMatch = readonly string[] | ((key: string) => boolean);

interface Watch {
  matches: (key: string) => boolean;
  run: () => unknown;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * How long a burst of writes is given to finish before the re-read.
 *
 * Several rows often move for one gesture — routing a task writes its provider and its model — and
 * each of them is its own frame. Waiting for the last one turns that into one read instead of two,
 * and the read then sees every row the gesture wrote rather than half of them.
 */
const SETTLE_MS = 40;

const watches: Watch[] = [];
let listening = false;

function start(): void {
  if (listening) return;
  listening = true;
  // Never torn down: a store lives as long as its window, and so does this. Outside Tauri (unit
  // tests, the mobile bundle) `listen` rejects, and there is nothing to listen to anyway.
  void listen<SettingChanged>("settings:changed", (event) => {
    const { key, origin } = event.payload;
    if (origin === WINDOW.label) return;
    for (const watch of watches) {
      if (!watch.matches(key)) continue;
      if (watch.timer !== null) clearTimeout(watch.timer);
      watch.timer = setTimeout(() => {
        watch.timer = null;
        void Promise.resolve()
          .then(watch.run)
          .catch(() => {});
      }, SETTLE_MS);
    }
  }).catch(() => {});
}

/**
 * Runs `reload` whenever another window writes one of `keys`.
 *
 * `keys` is a list, or a predicate for the settings that are a family rather than a name — one row
 * per repository, one per AI task. `reload` should read the rows back rather than trust anything it
 * was told, and should be cheap to call when nothing it cares about actually changed.
 */
export function watchSettings(keys: KeyMatch, reload: () => unknown): void {
  const matches = typeof keys === "function" ? keys : (key: string) => keys.includes(key);
  watches.push({ matches, run: reload, timer: null });
  start();
}
