import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  focusSatellite,
  listSatellites,
  openSatellite,
  type SatelliteInfo,
} from "../lib/tauri/windows";
import { WINDOW, type DetachableKind } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";
import { translate } from "./languageStore";
import { useWorkspaceStore } from "./workspaceStore";

/**
 * Which apps and repositories are open in windows of their own.
 *
 * # What reads it
 *
 * The rail and the sidebar, to draw the one piece of state that makes "detaching moves, it never
 * duplicates" legible: an icon whose app is elsewhere is marked, and pressing it focuses that
 * window instead of opening a tab. Without this the rule would still hold — the backend refuses to
 * build a second window for the same thing — but the user would find out by pressing a button and
 * watching a different window come forward, which is a rule you learn by being surprised.
 *
 * # Why the list comes from the backend
 *
 * `windows.rs` owns it, because "already open?" has to be answerable from every window and each
 * webview only knows itself. This store is a mirror: seeded once at boot and then pushed to on
 * every change (`windows:satellites`). No polling — the answer changes only when a window is built
 * or destroyed, and both of those are moments the backend is already in.
 */
/**
 * An island that has just come back — closed, or sent back with its "return" button — kept for the
 * few seconds the main window spends pointing at where it landed (`ReturnBurst`). `id` is unique per
 * return, so the same app coming back twice in a row plays its animation twice.
 */
export interface WindowReturn {
  id: number;
  kind: DetachableKind;
  refId: string;
}

/** How long a return stays in `returns`: the longest of its animations, plus a margin. */
const RETURN_MS = 2400;

interface WindowState {
  /** Every satellite open right now, this window included if it is one. */
  satellites: SatelliteInfo[];
  /** Islands that came back in the last couple of seconds. Main window only — see `init`. */
  returns: WindowReturn[];
  /** How many are allowed, from settings. Mirrored here so the rail can say the number in the
   *  message it shows when the answer is "no". */
  limit: number;
  init: () => Promise<void>;
  setLimit: (limit: number) => void;
  /**
   * Opens — or focuses — the window for one app or one repository.
   *
   * Returns `false` when it refused, so the caller can leave the app where it is rather than
   * marking an icon for a window that was never built.
   */
  detach: (kind: DetachableKind, refId: string, title: string) => Promise<boolean>;
  focus: (label: string) => Promise<void>;
  /** Whether this app or repository is showing in a window of its own. */
  detachedLabel: (kind: DetachableKind, refId: string) => string | null;
}

/** What Settings offers, and what a fresh install gets. Four covers the case this feature was asked
 *  for — API client, database, frontend, backend — with nothing left over. */
export const DEFAULT_SATELLITE_LIMIT = 4;

let nextReturnId = 0;

/**
 * Runs `play` now if this window can be seen, or as soon as it can — within a moment.
 *
 * The moment is for the "return" button: it brings the main window forward and closes itself in
 * the same breath, so the list can change a beat before a minimized main window is visible again.
 * Anything later is not a return the user is watching for. The case that matters is quitting to
 * the tray: every island is closed then (`close_all` parks them) while the main window hides, and
 * a burst of "it came back" animations queued for whenever the window is next shown would announce
 * returns that never happened — the tray restore opens those same islands again.
 */
function whenVisible(play: () => void) {
  if (document.visibilityState === "visible") {
    play();
    return;
  }
  const onChange = () => {
    if (document.visibilityState !== "visible") return;
    stop();
    play();
  };
  const timer = window.setTimeout(() => stop(), 1500);
  function stop() {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
  }
  document.addEventListener("visibilitychange", onChange);
}

export const useWindowStore = create<WindowState>((set, get) => ({
  satellites: [],
  returns: [],
  limit: DEFAULT_SATELLITE_LIMIT,

  init: async () => {
    const satellites = await listSatellites().catch(() => []);
    set({ satellites });
    // Never torn down, and it does not need to be: the store lives as long as the window does, and
    // so does the subscription. One listener for the whole window.
    void listen<SatelliteInfo[]>("windows:satellites", (event) => {
      const before = get().satellites;
      set({ satellites: event.payload });
      // An island that is in the old list and not in the new one has come back: whichever way it
      // was closed, it lands on the main window's rail or projects panel, and that is where the
      // eye is sent. Only the main window keeps these — it is the one those icons live in.
      if (!WINDOW.main) return;
      const back = before.filter(
        (s): s is SatelliteInfo & { kind: DetachableKind } =>
          (s.kind === "app" || s.kind === "repo") && !event.payload.some((now) => now.label === s.label),
      );
      if (back.length === 0) return;
      whenVisible(() => {
        const landed = back.map((s) => ({ id: ++nextReturnId, kind: s.kind, refId: s.ref_id }));
        set({ returns: [...get().returns, ...landed] });
        window.setTimeout(() => {
          const done = new Set(landed.map((r) => r.id));
          set({ returns: get().returns.filter((r) => !done.has(r.id)) });
        }, RETURN_MS);
      });
    });
  },

  setLimit: (limit) => set({ limit: Math.max(0, Math.min(8, Math.round(limit))) }),

  detach: async (kind, refId, title) => {
    const { satellites, limit } = get();
    const already = satellites.some((s) => s.kind === kind && s.ref_id === refId);
    // Focusing what is already open is never refused, however full the desk is — it opens nothing.
    if (!already && satellites.length >= limit) {
      pushErrorToast(translate("windows.limitReached", { limit: String(limit) }));
      return false;
    }
    try {
      // Opened where it was asked for: an app detached while this window sits on "Tienda" shows
      // "Tienda", whatever that window was switched to the last time it was open.
      await openSatellite(kind, refId, title, useWorkspaceStore.getState().activeWorkspaceId);
      return true;
    } catch (err) {
      pushErrorToast(String(err));
      return false;
    }
  },

  focus: async (label) => {
    await focusSatellite(label).catch((err: unknown) => pushErrorToast(String(err)));
  },

  detachedLabel: (kind, refId) =>
    get().satellites.find((s) => s.kind === kind && s.ref_id === refId)?.label ?? null,
}));

/**
 * Whether this app or repository is in a window of its own — the selector every icon and row uses.
 *
 * A hook returning the label rather than the whole list, so a row re-renders only when *its own*
 * answer changes. In a satellite it always answers `null` for the thing that satellite is showing:
 * a window must not draw itself as "open somewhere else".
 */
export function useDetachedLabel(kind: DetachableKind, refId: string): string | null {
  return useWindowStore((s) => {
    const found = s.satellites.find((sat) => sat.kind === kind && sat.ref_id === refId);
    if (!found || found.label === WINDOW.label) return null;
    return found.label;
  });
}
