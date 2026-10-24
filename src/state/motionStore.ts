import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const KEY = "motion_level";

/**
 * How much the app moves — Apariencia › Modo y color › Animaciones (user, 2026-10-10: "sin
 * animaciones, media, y full para que en computadoras muy pro se vea muy animada").
 *
 * - `off`: nothing arrives, slides or fades; what moves is what reports progress (spinners, the
 *   hold ring).
 * - `medium`, the default: light arrivals — fades, the dialogs' settle — on the compositor, and the
 *   side panels sliding by their width (`useEdgeSlide`), the one thing laid out per frame.
 * - `full`: the same moments, longer and with travel — views rise, dialogs pop, menus unfold. Still
 *   transform and opacity, but more of them and for longer.
 *
 * Stamped on the root as `data-motion` so CSS can branch on it (`index.css`, "Motion levels"), and
 * read back from there by the animations driven from script (`motionLevel` in `lib/motion.ts`).
 * The system's reduce-motion setting wins over the choice: it reads as `off` whatever is picked.
 */
export type MotionLevel = "off" | "medium" | "full";

const LEVELS: readonly MotionLevel[] = ["off", "medium", "full"];

const reduceQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

/** The most battery saving lets through — `full` while it is not saving (see `powerSaveStore`). */
let cap: MotionLevel = "full";

/** The level that applies: the chosen one, unless the system asks for reduced motion or battery
 *  saving caps it. The choice itself is never rewritten — leaving the saving brings it back. */
function effectiveOf(level: MotionLevel): MotionLevel {
  if (reduceQuery?.matches) return "off";
  return LEVELS[Math.min(LEVELS.indexOf(level), LEVELS.indexOf(cap))];
}

/** Battery saving's ceiling on the level: `medium` at Ligero, `off` from Fuerte, `full` for none. */
export function capMotion(next: MotionLevel): void {
  if (cap === next) return;
  cap = next;
  stamp(useMotionStore.getState().level);
}

function stamp(level: MotionLevel) {
  const effective = effectiveOf(level);
  if (typeof document !== "undefined") document.documentElement.dataset.motion = effective;
  if (useMotionStore.getState().effective !== effective) useMotionStore.setState({ effective });
}

interface MotionState {
  /** What was chosen in Settings. */
  level: MotionLevel;
  /** What applies — `level`, or `off` while the system asks for reduced motion. What every
   *  animation reads. */
  effective: MotionLevel;
  init: () => Promise<void>;
  setLevel: (level: MotionLevel) => Promise<void>;
}

export const useMotionStore = create<MotionState>((set) => ({
  level: "medium",
  effective: effectiveOf("medium"),

  init: async () => {
    const stored = await getSetting(KEY).catch(() => null);
    const level = LEVELS.includes(stored as MotionLevel) ? (stored as MotionLevel) : "medium";
    set({ level });
    stamp(level);
  },

  setLevel: async (level) => {
    set({ level });
    stamp(level);
    await setSetting(KEY, level);
  },
}));

// Before the setting is read the root carries the default, so the first frames already behave.
stamp("medium");
// The system's switch, flipped while the app runs.
reduceQuery?.addEventListener("change", () => stamp(useMotionStore.getState().level));
// Chosen in the main window's Settings; a repository window follows. See `lib/settingsSync`.
watchSettings([KEY], () => useMotionStore.getState().init());
