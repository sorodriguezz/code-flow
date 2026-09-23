import { create } from "zustand";
import { getSettings, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";
import {
  isCsvSeparatorChoice,
  type CsvSeparatorChoice,
  type CsvSeparatorId,
} from "../lib/csvDialect";

const RAINBOW_KEY = "csv_rainbow_enabled";
const SEPARATOR_KEY = "csv_separator";

/**
 * How delimited files are read in the editor: coloured by column or not, and with which separator.
 * The reading itself is `lib/csvDialect.ts`; this only holds the answers.
 */
interface CsvState {
  /** On unless turned off: it only changes how a file *looks*, and nobody opens a CSV hoping to
   *  count commas. Off, delimited files open as plain text, exactly as they did before this existed. */
  rainbow: boolean;
  /** What a `.csv` is split on. `auto` reads the head of each file. */
  separator: CsvSeparatorChoice;
  /**
   * Separators picked for one file from the editor's toolbar, keyed by the editor model's path.
   *
   * For this session only, and on purpose: the pick corrects the rare file detection reads wrong,
   * and writing a row per file anybody ever opened would be a table that only grows.
   */
  fileSeparators: Record<string, CsvSeparatorId>;
  init: () => Promise<void>;
  setRainbow: (on: boolean) => Promise<void>;
  setSeparator: (choice: CsvSeparatorChoice) => Promise<void>;
  /** `null` goes back to whatever the setting says. */
  setFileSeparator: (file: string, id: CsvSeparatorId | null) => void;
}

export const useCsvStore = create<CsvState>((set, get) => ({
  rainbow: true,
  separator: "auto",
  fileSeparators: {},

  init: async () => {
    const stored = await getSettings([RAINBOW_KEY, SEPARATOR_KEY]).catch(() => null);
    if (!stored) return;
    const separator = stored[SEPARATOR_KEY];
    set({
      // Unset is on; only an explicit "false" turns it off.
      rainbow: stored[RAINBOW_KEY] !== "false",
      separator: isCsvSeparatorChoice(separator) ? separator : "auto",
    });
  },

  setRainbow: async (on) => {
    set({ rainbow: on });
    await setSetting(RAINBOW_KEY, String(on));
  },

  setSeparator: async (choice) => {
    set({ separator: choice });
    await setSetting(SEPARATOR_KEY, choice);
  },

  setFileSeparator: (file, id) => {
    const { [file]: _previous, ...rest } = get().fileSeparators;
    set({ fileSeparators: id ? { ...rest, [file]: id } : rest });
  },
}));

// Chosen in Settings › Editor, which only the main window has — and a repository window's editor is
// the one most likely to have the file open. See `lib/settingsSync`.
watchSettings([RAINBOW_KEY, SEPARATOR_KEY], () => useCsvStore.getState().init());
