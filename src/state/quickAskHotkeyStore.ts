import { create } from "zustand";
import { setSetting } from "../lib/tauri/commands";
import {
  getQuickAskShortcut,
  registerQuickAskShortcut,
  unregisterQuickAskShortcut,
} from "../lib/tauri/windows";

/** `QUICK_ASK_ACCELERATOR_KEY` and `QUICK_ASK_OFF` in `windows.rs`. Empty (or no row) means "never
 *  chosen" and gets the platform's default; `off` means no hotkey at all — two different answers,
 *  which is why "off" is a value of its own. */
const KEY = "quick_ask_accelerator";
const OFF = "off";

interface QuickAskHotkeyState {
  /** The chord bound right now; `null` when switched off. */
  accelerator: string | null;
  /** This platform's default (⌥Space on macOS, Ctrl+Alt+Space elsewhere). */
  defaultAccelerator: string;
  loaded: boolean;
  /** The system's last refusal — another application owns the chord, or it does not parse. Shown
   *  under the row until the next attempt. */
  error: string | null;
  load: () => Promise<void>;
  /** Binds `accelerator` and records it; `false` when the system refused it, in which case the
   *  previous chord is bound again and nothing is recorded. */
  set: (accelerator: string) => Promise<boolean>;
  turnOff: () => Promise<void>;
  reset: () => Promise<void>;
  /** Frees the chord while a new one is being recorded: bound, it fires the ask box instead of
   *  reaching the recorder. `resume` binds it again. */
  suspend: () => Promise<void>;
  resume: () => Promise<void>;
}

/**
 * The system-wide quick-ask hotkey, as Settings, the shortcuts sheet and the palette show it.
 *
 * It was bound at every launch from a setting nothing in the app could write: no field, no way to
 * turn it off, and on Windows its default (Alt+Space) took the system's window menu away from
 * every application. The binding itself stays in Rust (`register_quick_ask_shortcut`); this is the
 * one place that changes it.
 */
export const useQuickAskHotkeyStore = create<QuickAskHotkeyState>((set, get) => ({
  accelerator: null,
  defaultAccelerator: "",
  loaded: false,
  error: null,

  load: async () => {
    const current = await getQuickAskShortcut().catch(() => null);
    if (!current) return;
    set({ accelerator: current.accelerator, defaultAccelerator: current.defaultAccelerator, loaded: true });
  },

  set: async (accelerator) => {
    const previous = get().accelerator;
    try {
      await registerQuickAskShortcut(accelerator);
    } catch (e) {
      set({ error: String(e) });
      // Binding drops every chord first, so a refused one leaves nothing bound — put the old one
      // back rather than switching the feature off as a side effect of a failed attempt.
      if (previous) await registerQuickAskShortcut(previous).catch(() => {});
      return false;
    }
    await setSetting(KEY, accelerator);
    set({ accelerator, error: null });
    return true;
  },

  turnOff: async () => {
    await unregisterQuickAskShortcut().catch(() => {});
    await setSetting(KEY, OFF);
    set({ accelerator: null, error: null });
  },

  reset: async () => {
    const fallback = get().defaultAccelerator;
    if (!fallback) return;
    try {
      await registerQuickAskShortcut(fallback);
    } catch (e) {
      set({ error: String(e) });
      return;
    }
    // Unset rather than written out, so a later default change reaches this install too.
    await setSetting(KEY, "");
    set({ accelerator: fallback, error: null });
  },

  suspend: async () => {
    if (get().accelerator) await unregisterQuickAskShortcut().catch(() => {});
  },

  resume: async () => {
    const accelerator = get().accelerator;
    if (accelerator) await registerQuickAskShortcut(accelerator).catch((e: unknown) => set({ error: String(e) }));
  },
}));
