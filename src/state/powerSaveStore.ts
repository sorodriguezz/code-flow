import { create } from "zustand";
import { getSetting, powerSaveSet, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import type { PowerStatus } from "../types/domain";
import { capMotion } from "./motionStore";
import { setBatteryPollEvery, usePowerStore } from "./powerStore";

const KEY = "power_save_mode";

/**
 * Battery saving, picked in the status bar's battery panel (user, 2026-10-23: «modos de ahorro de
 * batería que se activen en el marcador de batería»). Three levels, each with everything the one
 * before it does:
 *
 * - `1` Ligero — how the app looks and how often it asks: animations capped at «Media», the
 *   looping decorations stopped, no backdrop blur, the panel's and the status bar's reads spaced out.
 *   Nothing answers any slower.
 * - `2` Fuerte — also pauses background work nobody asked for just now: animations off, git
 *   auto-fetch, vectorizing, Codi's listening, meeting detection, the local model's inline
 *   completion; idle local models are let go after 2 min.
 * - `3` Máximo — also stops what is still running: every model server and in-app model, none
 *   started on its own, language servers closed after 5 min idle, terminals without WebGL, CI read
 *   only while its tab is open.
 *
 * **Never what the user started.** A chat answering, a PR review, a scheduled flow, an agent in a
 * terminal run on whatever the level. And leaving a level puts everything back as it was: no level
 * writes the user's own settings — each place reads the level beside them.
 *
 * `auto`, the default, follows the battery: on the mains `0`; unplugged `1`; at 20% `2`; at 10% `3`.
 * A level picked by hand stays put, plug or no plug. A desktop has no battery panel to pick from, so
 * it is always `0`.
 */
export type SaveLevel = 0 | 1 | 2 | 3;
export type SaveChoice = "auto" | SaveLevel;

const CHOICES: readonly SaveChoice[] = ["auto", 0, 1, 2, 3];

/** The level the battery asks for, under `auto`. */
export function autoLevel(status: Pick<PowerStatus, "percent" | "plugged_in">): SaveLevel {
  if (status.plugged_in) return 0;
  if (status.percent <= 10) return 3;
  if (status.percent <= 20) return 2;
  return 1;
}

/** The level that applies: none without a battery, the battery's under `auto`, else the one picked. */
export function effectiveLevel(choice: SaveChoice, status: PowerStatus | null): SaveLevel {
  if (!status) return 0;
  return choice === "auto" ? autoLevel(status) : choice;
}

function parse(raw: string | null): SaveChoice {
  if (raw === null || raw === "" || raw === "auto") return "auto";
  const n = Number(raw);
  return CHOICES.includes(n as SaveLevel) ? (n as SaveLevel) : "auto";
}

interface PowerSaveState {
  choice: SaveChoice;
  /** What applies now — what everything that saves reads. */
  level: SaveLevel;
  init: () => Promise<void>;
  setChoice: (choice: SaveChoice) => Promise<void>;
}

let watching: (() => void) | null = null;

/** Stamps the level on the root for CSS (`data-power-save`, absent at 0) and tells the backend. */
function apply(level: SaveLevel) {
  if (typeof document !== "undefined") {
    if (level > 0) document.documentElement.dataset.powerSave = String(level);
    else delete document.documentElement.dataset.powerSave;
  }
  if (usePowerSaveStore.getState().level === level) return;
  usePowerSaveStore.setState({ level });
  capMotion(level >= 2 ? "off" : level === 1 ? "medium" : "full");
  setBatteryPollEvery(level >= 1 ? 15_000 : 5_000);
  void powerSaveSet(level).catch(() => undefined);
}

export const usePowerSaveStore = create<PowerSaveState>((set) => ({
  choice: "auto",
  level: 0,

  init: async () => {
    // The battery is read in every window, not only where the status bar draws it: a repository
    // window has to save too. Reference-counted, so this adds no second timer to the main window.
    if (!watching) watching = usePowerStore.getState().watch();
    const choice = parse(await getSetting(KEY).catch(() => null));
    set({ choice });
    apply(effectiveLevel(choice, usePowerStore.getState().status));
  },

  setChoice: async (choice) => {
    set({ choice });
    apply(effectiveLevel(choice, usePowerStore.getState().status));
    await setSetting(KEY, String(choice));
  },
}));

// Every battery reading may move an `auto` level: unplugging, or crossing 20% or 10%.
usePowerStore.subscribe((s) => apply(effectiveLevel(usePowerSaveStore.getState().choice, s.status)));
// Picked in one window; the others follow. See `lib/settingsSync`.
watchSettings([KEY], () => usePowerSaveStore.getState().init());

/** `useSaving(n)`: whether the level that applies is at least `n`. */
export function useSaving(at: SaveLevel): boolean {
  return usePowerSaveStore((s) => s.level >= at);
}

/** The same, outside React. */
export function saving(at: SaveLevel): boolean {
  return usePowerSaveStore.getState().level >= at;
}
