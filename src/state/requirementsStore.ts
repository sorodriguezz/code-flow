import { create } from "zustand";
import { checkRequirements, getSetting, setSetting } from "../lib/tauri/commands";
import type { Requirement } from "../types/domain";
import { useToolSetupStore } from "./toolSetupStore";
import { useTourStore } from "./tourStore";

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
 * The first-launch check: is `git` there, and can the data directory be written — and, since
 * 2026-10-29, the «Preparar CodeFlow» screen that offers to install `git` and the AI CLIs.
 *
 * **Silent when there is nothing to say or offer.** On a machine that already has `git`, every CLI
 * and writable directories, a screen saying so would train people to dismiss screens, and it would
 * land on top of the guided tour — so a clean result shows nothing, writes the flag and gets out of
 * the way.
 *
 * **Two checks, and a choice.** `git` and the data directories are checked because failing them is
 * the app looking fine and being wrong (see `requirements.rs`). The AI CLIs are not requirements —
 * the user asked (2026-10-29) to pick which to install when the app is first opened, rather than
 * from an installer that cannot ask (a DMG has no pages; NSIS would need its own template). Nothing
 * is ticked but a missing `git`; the same one-click install is in Settings for later.
 *
 * **Checked at most once per installation.** After the flag is set nothing is probed at all — the
 * store's `init` is one settings read and returns. That is what makes putting it on the startup
 * path affordable.
 */
interface RequirementsState {
  /** What failed. Empty when nothing did, which is also the state on every launch after the first. */
  problems: Requirement[];
  /** The «Preparar CodeFlow» screen is up. Only ever true on a first launch. */
  open: boolean;
  /**
   * Runs the check if this installation has never been checked.
   *
   * Resolves to whether the app is clear to carry on with its own first-launch behaviour — which
   * today means the guided tour. A tour of an app that cannot fetch is beside the point, and two
   * things claiming the screen at once is worse than either: `App` awaits this before arming the
   * tour, so the ordering is stated rather than left to a timer to win. When the setup screen opens
   * instead, the tour is started by `dismiss`, once the person is done with it.
   */
  init: () => Promise<boolean>;
  /** Closes the screen, records that it has been seen, and lets the tour have its turn. */
  dismiss: () => void;
}

export const useRequirementsStore = create<RequirementsState>((set, get) => ({
  problems: [],
  open: false,

  init: async () => {
    const seen = (await getSetting(SEEN_KEY).catch(() => null)) === "1";
    if (seen) return true;

    // A check that cannot run is not a check that failed. The IPC call itself going wrong says
    // nothing about the user's machine, and refusing to start the tour over it — or worse, showing
    // a dialog listing nothing — would turn our own bug into their problem. Treated as clean, and
    // the flag is left unwritten so the next launch tries again.
    const [found] = await Promise.all([
      checkRequirements().catch(() => null),
      // What «Preparar CodeFlow» offers to install: git and the AI CLIs (`tool_setup.rs`).
      useToolSetupStore.getState().load(),
    ]);
    if (!found) return true;

    const problems = found.filter((requirement) => !requirement.ok);
    const tools = useToolSetupStore.getState().tools ?? [];
    // Something to offer: a tool that is missing and has a way to be installed or a page to go to.
    const missing = tools.some((tool) => !tool.installed);
    if (problems.length === 0 && !missing) {
      // Nothing to say or offer. Recorded as done all the same — the question has been answered for
      // this installation, and answering it again on every launch is a subprocess nobody asked for.
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
    const blocking = get().problems.some((problem) => problem.id === "dataDir");
    set({ open: false });
    // The tour held back for this screen. Not over a data directory that cannot be written: that
    // launch's tour would walk an app that is about to lose what it shows.
    if (!blocking) void useTourStore.getState().init({ autoOpen: true });
  },
}));
