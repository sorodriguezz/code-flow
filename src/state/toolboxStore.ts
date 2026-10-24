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
import { toolById, TOOLS } from "../lib/toolbox/catalog";

const LAST_KEY = "toolbox_last_tool";

interface ToolboxState {
  activeId: string;
  /** Per tool, per field — in memory only (see the file comment). */
  inputs: Record<string, Record<string, unknown>>;
  loaded: boolean;
  load: () => Promise<void>;
  open: (id: string) => void;
  setInput: (tool: string, field: string, value: unknown) => void;
}

export const useToolboxStore = create<ToolboxState>((set, get) => ({
  activeId: TOOLS[0].id,
  inputs: {},
  loaded: false,
  load: async () => {
    const last = await getSetting(LAST_KEY).catch(() => null);
    set({ activeId: last && toolById(last) ? last : get().activeId, loaded: true });
  },
  open: (id) => {
    if (!toolById(id)) return;
    set({ activeId: id });
    void setSetting(LAST_KEY, id).catch(() => {});
  },
  setInput: (tool, field, value) =>
    set((s) => ({ inputs: { ...s.inputs, [tool]: { ...s.inputs[tool], [field]: value } } })),
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
watchSettings([LAST_KEY], () => useToolboxStore.getState().load());
