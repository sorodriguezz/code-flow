/**
 * «Herramientas»: which tool is open, and what each tool was holding.
 *
 * The open tool is a settings row, so they survive a restart and — through
 * `settings:changed` — a tool picked from the command palette in the main window opens in a
 * toolbox that lives in a window of its own. What was typed into a tool is deliberately **not**
 * persisted: people paste tokens, secrets and certificates here precisely because nothing leaves
 * the machine, and writing them to the settings database would make that half-true. The inputs
 * stay in memory for the session, so switching tools and coming back finds them as they were.
 */
import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import { TOOL_INPUT, toolById, TOOLS } from "../lib/toolbox/catalog";

const LAST_KEY = "toolbox_last_tool";
/** Tool ids only — never what was typed into them (see the file comment). */
const RECENT_KEY = "toolbox_recent_tools";
const FAVORITES_KEY = "toolbox_favorite_tools";
/** How many recently opened tools the list keeps on top. */
const RECENT_MAX = 5;

/** A stored id list, minus ids the catalog no longer has. */
function idList(raw: string | null): string[] {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && Boolean(toolById(id))) : [];
  } catch {
    return [];
  }
}

interface ToolboxState {
  activeId: string;
  /** Per tool, per field — in memory only (see the file comment). */
  inputs: Record<string, Record<string, unknown>>;
  loaded: boolean;
  /** Most recent first. */
  recent: string[];
  favorites: string[];
  load: () => Promise<void>;
  open: (id: string) => void;
  setInput: (tool: string, field: string, value: unknown) => void;
  toggleFavorite: (id: string) => void;
  /**
   * Opens `id` with `text` in its input — «Enviar a» and the clipboard detection. `extra` sets
   * other fields of that tool alongside, such as a two-way tool's `direction`.
   */
  sendTo: (id: string, text: string, extra?: Record<string, unknown>) => void;
}

export const useToolboxStore = create<ToolboxState>((set, get) => ({
  activeId: TOOLS[0].id,
  inputs: {},
  loaded: false,
  recent: [],
  favorites: [],
  load: async () => {
    const [last, recent, favorites] = await Promise.all(
      [LAST_KEY, RECENT_KEY, FAVORITES_KEY].map((key) => getSetting(key).catch(() => null)),
    );
    set({
      activeId: last && toolById(last) ? last : get().activeId,
      recent: idList(recent),
      favorites: idList(favorites),
      loaded: true,
    });
  },
  open: (id) => {
    if (!toolById(id)) return;
    const recent = [id, ...get().recent.filter((other) => other !== id)].slice(0, RECENT_MAX);
    set({ activeId: id, recent });
    void setSetting(LAST_KEY, id).catch(() => {});
    void setSetting(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
  },
  setInput: (tool, field, value) =>
    set((s) => ({ inputs: { ...s.inputs, [tool]: { ...s.inputs[tool], [field]: value } } })),
  toggleFavorite: (id) => {
    const has = get().favorites.includes(id);
    const favorites = has ? get().favorites.filter((other) => other !== id) : [...get().favorites, id];
    set({ favorites });
    void setSetting(FAVORITES_KEY, JSON.stringify(favorites)).catch(() => {});
  },
  sendTo: (id, text, extra = {}) => {
    const input = TOOL_INPUT[id];
    if (!input) return;
    set((s) => ({ inputs: { ...s.inputs, [id]: { ...s.inputs[id], ...extra, [input.field]: text } } }));
    get().open(id);
  },
}));

export function ensureToolboxLoaded(): void {
  if (!useToolboxStore.getState().loaded) void useToolboxStore.getState().load();
}

/**
 * A tool field's value and setter, kept across tool switches for the session.
 *
 * The tool's id is the namespace, so two tools may both call a field `input`.
 */
export function useToolField<T>(tool: string, field: string, initial: T): [T, (value: T) => void] {
  const value = useToolboxStore((s) => s.inputs[tool]?.[field]) as T | undefined;
  const setInput = useToolboxStore((s) => s.setInput);
  return [value === undefined ? initial : value, (v: T) => setInput(tool, field, v)];
}

// A tool opened from another window's palette (the toolbox may be detached into its own).
watchSettings([LAST_KEY, FAVORITES_KEY], () => useToolboxStore.getState().load());
