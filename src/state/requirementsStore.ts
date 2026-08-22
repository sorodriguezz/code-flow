import { create } from "zustand";
import { checkRequirements, getSetting, setSetting } from "../lib/tauri/commands";
import type { Requirement } from "../types/domain";

/**
 * Where "this installation has already been checked" is recorded.
 *
 * The same mechanism as the tour's own flag, and for the same reason: it is a row in `codeflow.db`,
 * which lives in the app-data directory the OS sets aside for CodeFlow (see `paths::state_dir`) —
 * **beside** the application rather than inside it. An update replaces the bundle and never touches
 * that directory, so an upgrade is not a fresh install and does not bring the screen back. The only
 * things that do are all deliberate: a new machine or user account, the installer's "wipe my data"
 * option, and Settings → General → Reset data.
 *
 * One exception, and it is on purpose: the v1.19 layout migration deletes this row. The check it
 * gates is the only warning anyone gets that a data directory cannot be written, and the launch
 * right after the directories move is precisely the launch where that can newly be true — so
 * carrying the row across would have disarmed the alarm on the one night it was needed. See
 * `migrate::rewrite_rows`.
 */
const SEEN_KEY = "requirements_checked";

/**
 * The first-launch check: is `git` there, and can the data directory be written.
 *
 * **Silent when everything passes, which is almost always.** A dialog on first launch saying
 * "nothing is wrong" is a dialog that trains people to dismiss dialogs, and it would land on top of
 * the guided tour that opens on that same launch. So a clean result shows nothing at all, writes
 * the flag, and gets out of the way.
 *
 * **Two checks and not ten**, deliberately. Everything else the app shells out to — the AI engines,
 * `ssh`, `npx`, `code` — is feature-scoped and already reports itself where it is used, with a
 * badge and an install command beside it. Listing them here would be a launch screen full of things
 * the user has not tried to do yet. These two are different: failing them is not a feature missing,
 * it is the app looking fine and being wrong. See `requirements.rs`.
 *
 * **Checked at most once per installation.** After the flag is set nothing is probed at all — the
 * store's `init` is one settings read and returns. That is what makes putting it on the startup
 * path affordable.
 */
interface RequirementsState {
  /** What failed. Empty when nothing did, which is also the state on every launch after the first. */
  problems: Requirement[];
  /** The dialog is up. Only ever true on a first launch that found something. */
  open: boolean;
  /**
   * Runs the check if this installation has never been checked.
   *
   * Resolves to whether the app is clear to carry on with its own first-launch behaviour — which
   * today means the guided tour. A tour of an app that cannot fetch is beside the point, and two
   * things claiming the screen at once is worse than either: `App` awaits this before arming the
   * tour, so the ordering is stated rather than left to a timer to win.
   */
  init: () => Promise<boolean>;
  /** Dismisses it, and records that it has been seen. */
  dismiss: () => void;
}

export const useRequirementsStore = create<RequirementsState>((set) => ({
  problems: [],
  open: false,

  init: async () => {
    const seen = (await getSetting(SEEN_KEY).catch(() => null)) === "1";
    if (seen) return true;

    // A check that cannot run is not a check that failed. The IPC call itself going wrong says
    // nothing about the user's machine, and refusing to start the tour over it — or worse, showing
    // a dialog listing nothing — would turn our own bug into their problem. Treated as clean, and
    // the flag is left unwritten so the next launch tries again.
    const found = await checkRequirements().catch(() => null);
    if (!found) return true;

    const problems = found.filter((requirement) => !requirement.ok);
    if (problems.length === 0) {
      // Nothing to say. Recorded as done all the same — the question has been answered for this
      // installation, and answering it again on every launch is a subprocess nobody asked for.
      void setSetting(SEEN_KEY, "1").catch(() => {});
      return true;
    }

    set({ problems, open: true });
    return false;
  },

  dismiss: () => {
    // Written on dismissal rather than when the dialog opened, so a launch the user never got to
    // acknowledge — a crash, a force quit — asks again. "Shown once" means once *seen*.
    void setSetting(SEEN_KEY, "1").catch(() => {});
    set({ open: false });
  },
}));
