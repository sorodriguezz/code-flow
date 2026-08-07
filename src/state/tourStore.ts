import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { TOURS, type TourId, type TourStep } from "../lib/tour/steps";
import { applyStage, captureAppState, restoreAppState, type AppSnapshot } from "../lib/tour/stage";

/**
 * Where "the user has already been through this" is recorded.
 *
 * **The main tour opens by itself exactly once: the first time the app is launched after being
 * installed.** After that it is only ever reached on purpose, from the title bar or from
 * Settings → General. There is deliberately no mechanism for showing it again on its own — not on
 * an update, not on a new version, not after any length of time.
 *
 * The per-app tours are never opened automatically at all, and never write this flag: they are
 * offered by a button inside the app they describe, and taken by whoever wants one.
 *
 * That holds because this is a row in `codeflow.db`, which lives in `~/CodeFlow` (or
 * `C:\CodeFlow`) — **beside** the app rather than inside it. An update replaces the application
 * bundle and never touches that folder, so the flag survives every release. The only three things
 * that bring the tour back are all things the user did on purpose: installing on a fresh machine or
 * user account, choosing the installer's "wipe my data" option, and Settings → General → Reset
 * data.
 */
const SEEN_KEY = "tour_completed";

/** How long after launch the first-run tour opens itself. Long enough for the workspace and its
 * repositories to have loaded, so the sidebar the second step points at isn't still empty. */
const FIRST_RUN_DELAY_MS = 1100;

interface TourState {
  /** The overlay is up and driving the app. */
  active: boolean;
  /**
   * Which of the tours is on screen.
   *
   * Only `"main"` is ever opened by the app itself, and only `"main"` writes the flag that retires
   * that opening: an app tour is something the user went looking for, and finishing one must not be
   * mistaken for having been shown the app.
   */
  tourId: TourId;
  index: number;
  /** Confetti is flying. Outlives `active` — the celebration plays over the restored app, not over
   * the tour, which is the point of finishing it. */
  celebrating: boolean;
  /**
   * Whether the run on screen is the one that opened by itself after installing.
   *
   * Only that run ends in confetti. A celebration is for the first time through, and an app that
   * throws one every time somebody reopens the tour to check where a button was is an app that has
   * turned its own reward into noise. Replays walk the same steps and simply finish.
   */
  firstRun: boolean;
  /** Whether the tour has ever been finished or skipped. `null` until read from disk. */
  seen: boolean | null;
  /** Where the app was before the tour started rearranging it. */
  snapshot: AppSnapshot | null;
  init: () => Promise<void>;
  /** `firstRun` is set only by the post-install opening in `init`; every button that opens a
   * tour by hand leaves it false, and therefore ends without the confetti. `tour` defaults to the
   * main one, so the two callers that only ever want that one don't have to name it. */
  start: (options?: { firstRun?: boolean; tour?: TourId }) => void;
  next: () => void;
  back: () => void;
  goTo: (index: number) => void;
  /** Leaves without the confetti, and without walking the rest. */
  skip: () => void;
  endCelebration: () => void;
}

export function tourLength(tourId: TourId): number {
  return TOURS[tourId].length;
}

export function tourStep(tourId: TourId, index: number): TourStep {
  const steps = TOURS[tourId];
  return steps[Math.min(Math.max(index, 0), steps.length - 1)];
}

/** Retires the automatic opening for good. Fire-and-forget: a failed write means the tour offers
 * itself once more on the next launch, which is a far smaller problem than a rejected promise
 * taking down the click that finished it. */
function rememberSeen(): void {
  void setSetting(SEEN_KEY, "1").catch(() => {});
}

export const useTourStore = create<TourState>((set, get) => ({
  active: false,
  tourId: "main",
  index: 0,
  celebrating: false,
  firstRun: false,
  seen: null,
  snapshot: null,

  init: async () => {
    const seen = (await getSetting(SEEN_KEY).catch(() => null)) === "1";
    set({ seen });
    // The one automatic opening there is. Everything the app can do is behind a panel toggle or a
    // menu, and an app whose features are all one click away is also an app where none of them is
    // discoverable — being shown the map once beats finding it by accident. Whichever way it ends,
    // Skip or Finish, the flag is written and this never fires again on this installation.
    if (!seen) {
      setTimeout(() => {
        // Re-checked on the way in: the user may already have started it by hand from the title
        // bar while this timer was pending — in which case that run is theirs, not the automatic
        // one, and it keeps `firstRun` false.
        if (!get().active) get().start({ firstRun: true });
      }, FIRST_RUN_DELAY_MS);
    }
  },

  start: (options) => {
    const tourId = options?.tour ?? "main";
    // Captured *before* the first stage is applied, and only when a tour isn't already running.
    // Both launchers are spotlighted by a step near the end of the main tour, so starting a second
    // tour from inside the first has to keep the *original* snapshot — capturing again here would
    // record the tour's own arrangement as the thing to put back.
    const snapshot = get().snapshot ?? captureAppState();
    applyStage(TOURS[tourId][0]?.stage);
    set({
      active: true,
      tourId,
      index: 0,
      celebrating: false,
      firstRun: options?.firstRun ?? false,
      snapshot,
    });
  },

  goTo: (index) => {
    const steps = TOURS[get().tourId];
    const clamped = Math.min(Math.max(index, 0), steps.length - 1);
    applyStage(steps[clamped]?.stage);
    set({ index: clamped });
  },

  next: () => {
    const { index, snapshot, firstRun, tourId } = get();
    if (index < TOURS[tourId].length - 1) {
      get().goTo(index + 1);
      return;
    }
    // Walked to the end: put the app back the way it was, then — on the post-install run, and only
    // that one — celebrate over it.
    if (snapshot) restoreAppState(snapshot);
    if (tourId === "main") rememberSeen();
    set({
      active: false,
      celebrating: firstRun,
      firstRun: false,
      snapshot: null,
      ...(tourId === "main" ? { seen: true } : {}),
    });
  },

  back: () => {
    const { index } = get();
    if (index > 0) get().goTo(index - 1);
  },

  skip: () => {
    const { snapshot, tourId } = get();
    if (snapshot) restoreAppState(snapshot);
    // Leaving an app tour says nothing about whether the app has been introduced, so it must not
    // retire the first-run opening of the main one.
    if (tourId === "main") rememberSeen();
    set({
      active: false,
      celebrating: false,
      firstRun: false,
      snapshot: null,
      ...(tourId === "main" ? { seen: true } : {}),
    });
  },

  endCelebration: () => set({ celebrating: false }),
}));
