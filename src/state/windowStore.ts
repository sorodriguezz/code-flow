import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  focusSatellite,
  listSatellites,
  openSatellite,
  type SatelliteInfo,
} from "../lib/tauri/windows";
import { WINDOW, type SatelliteKind } from "../lib/windowIdentity";
import { pushErrorToast } from "./toastStore";
import { translate } from "./languageStore";

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
interface WindowState {
  /** Every satellite open right now, this window included if it is one. */
  satellites: SatelliteInfo[];
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
  detach: (kind: SatelliteKind, refId: string, title: string) => Promise<boolean>;
  focus: (label: string) => Promise<void>;
  /** Whether this app or repository is showing in a window of its own. */
  detachedLabel: (kind: SatelliteKind, refId: string) => string | null;
}

/** What Settings offers, and what a fresh install gets. Four covers the case this feature was asked
 *  for — API client, database, frontend, backend — with nothing left over. */
export const DEFAULT_SATELLITE_LIMIT = 4;

export const useWindowStore = create<WindowState>((set, get) => ({
  satellites: [],
  limit: DEFAULT_SATELLITE_LIMIT,

  init: async () => {
    const satellites = await listSatellites().catch(() => []);
    set({ satellites });
    // Never torn down, and it does not need to be: the store lives as long as the window does, and
    // so does the subscription. One listener for the whole window.
    void listen<SatelliteInfo[]>("windows:satellites", (event) => {
      set({ satellites: event.payload });
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
      await openSatellite(kind, refId, title);
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
export function useDetachedLabel(kind: SatelliteKind, refId: string): string | null {
  return useWindowStore((s) => {
    const found = s.satellites.find((sat) => sat.kind === kind && sat.ref_id === refId);
    if (!found || found.label === WINDOW.label) return null;
    return found.label;
  });
}
