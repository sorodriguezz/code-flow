import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { SHORTCUT_COMMANDS, type ShortcutId } from "../lib/shortcuts";
import type { Chord } from "../lib/keys";

const KEY = "keybindings";

const VALID_IDS = new Set<string>(SHORTCUT_COMMANDS.map((c) => c.id));

/** `null` is a real value: the user cleared the binding, which is different from never having
 * touched it (absent → the shipped default applies). */
export type BindingOverrides = Partial<Record<ShortcutId, Chord | null>>;

interface ShortcutsState {
  /** Only the deltas from the defaults are persisted, so improved defaults in a later release
   * reach users who never customized that particular action. */
  overrides: BindingOverrides;
  /** The command whose row is currently capturing keystrokes, if any. While this is set the
   * global handler stands down so the recorder can see chords that are already bound. */
  recordingId: ShortcutId | null;
  init: () => Promise<void>;
  setBinding: (id: ShortcutId, chord: Chord | null) => Promise<void>;
  resetBinding: (id: ShortcutId) => Promise<void>;
  resetAll: () => Promise<void>;
  setRecording: (id: ShortcutId | null) => void;
}

function parse(raw: string | null): BindingOverrides {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BindingOverrides = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Ignore ids from a newer/older build rather than letting one stale entry throw away the
      // whole file.
      if (!VALID_IDS.has(id)) continue;
      if (value === null) out[id as ShortcutId] = null;
      else if (typeof value === "string" && value.length > 0) out[id as ShortcutId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

async function persist(overrides: BindingOverrides): Promise<void> {
  await setSetting(KEY, JSON.stringify(overrides));
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  overrides: {},
  recordingId: null,

  init: async () => {
    const raw = await getSetting(KEY).catch(() => null);
    set({ overrides: parse(raw) });
  },

  setBinding: async (id, chord) => {
    const overrides = { ...get().overrides, [id]: chord };
    set({ overrides });
    await persist(overrides);
  },

  resetBinding: async (id) => {
    const { [id]: _removed, ...rest } = get().overrides;
    set({ overrides: rest });
    await persist(rest);
  },

  resetAll: async () => {
    set({ overrides: {} });
    await persist({});
  },

  setRecording: (id) => set({ recordingId: id }),
}));

/** The chord in effect for a command: the user's override when there is one, the shipped default
 * otherwise, and `null` when the user cleared it. */
export function bindingFor(id: ShortcutId, overrides: BindingOverrides): Chord | null {
  if (id in overrides) return overrides[id] ?? null;
  return SHORTCUT_COMMANDS.find((c) => c.id === id)?.defaultChord ?? null;
}

/** Every active binding, keyed by chord. Later commands lose a duplicate chord to earlier ones,
 * matching the order shown in settings — the conflict is surfaced there rather than hidden. */
export function activeChords(overrides: BindingOverrides): Map<Chord, ShortcutId> {
  const map = new Map<Chord, ShortcutId>();
  for (const command of SHORTCUT_COMMANDS) {
    const chord = bindingFor(command.id, overrides);
    if (chord && !map.has(chord)) map.set(chord, command.id);
  }
  return map;
}
