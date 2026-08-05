import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/** How often a running app looks for a newer release. Releases are cut by hand, so anything
 * tighter than this is just traffic against GitHub for no gain. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The updater's way of saying the published manifest has no build for this OS and architecture.
 *
 * Both spellings come from `tauri-plugin-updater`'s `TargetNotFound` / `TargetsNotFound`: the
 * release exists, it just has no `darwin-aarch64` entry because only the Windows job has finished
 * — or ever runs. That is a fact about the release, not a failure of the check, and it used to be
 * painted as a red error with a Rust message under it on every macOS launch.
 */
const NO_BUILD_FOR_PLATFORM = /(?:was not found|were found) in the response `platforms` object/;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "ready"
  | "error";

interface UpdateState {
  /** The running build's version — read once from the bundle, so it's the real installed one. */
  currentVersion: string;
  status: UpdateStatus;
  /** The pending release, kept whole because installing it needs the handle, not just its
   * version string. */
  update: Update | null;
  /** Download progress 0–100. Only meaningful while `status === "downloading"`. */
  progress: number;
  /** Last failure message. Shown only for checks the user asked for — see `checkNow`. */
  error: string;
  /** Whether the last check found a release that simply has nothing built for this platform. Kept
   * apart from `error` because it is not one: the answer is "nothing to install", which is what
   * `status: "uptodate"` already says — this only lets the panel say *why* without claiming the
   * running build is the latest one. */
  noBuildForPlatform: boolean;
  /** A download/install that failed, kept apart from `error` so the corner notice can offer a
   * retry for *this* — a check that couldn't reach GitHub is not something to interrupt anyone
   * with, and `status: "error"` alone can't tell the two apart. */
  installError: string;
  lastCheckedAt: number | null;
  /** Whether the "what's new" window is up. */
  notesOpen: boolean;
  /**
   * The version whose corner notice the user closed, or `""`.
   *
   * Held against the version rather than as a plain flag so that closing v1.7.4 says nothing
   * about v1.7.5 — the next release has news of its own. Deliberately not persisted: an update
   * you put off is one you should be reminded of next launch, and Settings › Updates is where
   * "leave me alone about this for good" would belong if it ever exists.
   */
  dismissedVersion: string;

  loadCurrentVersion: () => Promise<void>;
  checkNow: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  openNotes: () => void;
  closeNotes: () => void;
  dismiss: () => void;
}

/**
 * One owner for "is there a newer CodeFlow?", shared by the automatic hourly check, the corner
 * notice, the what's-new window and the Settings panel — so a check started in any of them is
 * the same check, and none of them can show a stale answer the others have moved past.
 *
 * Nothing here works in `tauri dev`: the updater replaces an installed binary and there isn't
 * one, so `check()` throws. That's expected and deliberately silent — see `checkNow`.
 */
export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: "",
  status: "idle",
  update: null,
  progress: 0,
  error: "",
  noBuildForPlatform: false,
  installError: "",
  lastCheckedAt: null,
  notesOpen: false,
  dismissedVersion: "",

  loadCurrentVersion: async () => {
    const version = await getVersion().catch(() => "");
    if (version) set({ currentVersion: version });
  },

  /**
   * @param manual `true` when a person pressed a button. Automatic checks fail for entirely
   * ordinary reasons — no network, a laptop that just woke up, the dev build — and painting an
   * error banner over the app for those would be noise about something nobody asked for. So an
   * automatic failure is remembered but stays invisible; only a manual check reports back.
   */
  checkNow: async (manual = false) => {
    const { status } = get();
    // A download in flight (or already installed) makes a new check pointless, and restarting
    // one would throw away the progress the user is watching. StrictMode's double-invoke and
    // an impatient double-click both land on the "checking" guard.
    if (status === "checking" || status === "downloading" || status === "ready") return;

    set({ status: "checking", error: manual ? "" : get().error });
    try {
      const found = await check();
      set({
        update: found,
        status: found ? "available" : "uptodate",
        lastCheckedAt: Date.now(),
        error: "",
        noBuildForPlatform: false,
        // Whatever went wrong last time is stale news now: this is a fresh answer about a
        // release that's there to be installed again.
        installError: "",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // "There is no build for you" is an answer, not a failure — it reached GitHub and read the
      // manifest. Reported the same way "you are on the latest" is, so a platform the release
      // pipeline hasn't built for stops looking like something the user has to fix.
      if (NO_BUILD_FOR_PLATFORM.test(message)) {
        set({ status: "uptodate", lastCheckedAt: Date.now(), error: "", noBuildForPlatform: true });
        return;
      }
      // A failed re-check must not retract an update already found: the release didn't stop
      // existing because this one request didn't get through.
      set({ status: manual ? "error" : get().update ? "available" : "idle", error: message });
    }
  },

  install: async () => {
    const { update } = get();
    if (!update) return;
    set({ status: "downloading", progress: 0, error: "", installError: "" });
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(100, Math.round((downloaded / total) * 100)) });
        } else if (event.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ status: "ready" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      set({ status: "error", error: message, installError: message });
    }
  },

  restart: async () => {
    await relaunch();
  },

  openNotes: () => set({ notesOpen: true }),
  closeNotes: () => set({ notesOpen: false }),

  dismiss: () => {
    const { update } = get();
    if (update) set({ dismissedVersion: update.version });
  },
}));
