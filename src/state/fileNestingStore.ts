import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { DEFAULT_NESTING_PATTERNS, type NestingPattern } from "../lib/fileNesting";

/**
 * Whether the explorer nests derived files under the file they come from, and the patterns that
 * decide what "derived" means.
 *
 * **Global, not per repository** — and that is the one thing about this store worth arguing.
 * `editor_hidden:` is keyed per repo because a hidden entry names a *path* inside one checkout, and
 * that path means nothing anywhere else. A nesting pattern names *filenames*: `*.ts` takes in
 * `${capture}.spec.ts` in every project that has ever existed. Keyed per repo, every new clone
 * would open with the feature freshly untaught, and the user would have to explain again that a
 * spec belongs to its source. It is the same split `iconRulesStore` argues for — the profiles are
 * global, only the *selection* is per repo — except that here there is nothing to select, so there
 * is nothing per repo at all.
 *
 * The switch travels with the patterns for the same reason: "I don't like file nesting" is a
 * sentence about how somebody reads trees, not about one checkout.
 *
 * # Off by default
 *
 * Nesting rearranges a tree people already know how to read, and the first reading of a file that
 * "moved" is that something is broken — the same misreading the `editor.allHiddenHere` string
 * exists to prevent. Everything in this app that changes what you see on its own is switched on by
 * hand (`blameAnnotationEnabled` in `preferencesStore` makes the identical call), and this is one
 * click away from both the explorer's context menu and its own panel.
 */

/** One row. Both the switch and the list live in it, because they are read together on the same
 *  frame and two rows would be two awaits before the first tree can be drawn. */
const KEY = "editor_file_nesting";

interface StoredNesting {
  enabled: boolean;
  patterns: NestingPattern[];
}

interface FileNestingState {
  enabled: boolean;
  patterns: NestingPattern[];
  /** False until the first read lands, so a caller can tell "no patterns" from "not read yet". */
  loaded: boolean;
  init: () => Promise<void>;
  setEnabled: (value: boolean) => void;
  /**
   * Replaces the whole list. Every mutation the panel offers — edit a field, toggle a row, delete
   * one, add one — is a rewrite of the same array, and a per-field API would be four actions that
   * all end in this one write. The same shape `iconRulesStore.save` has, for the same reason.
   */
  save: (patterns: NestingPattern[]) => void;
  /** Back to the shipped patterns. Leaves the switch alone: restoring the list is not a request to
   *  turn the feature on or off. */
  reset: () => void;
}

/**
 * Reads the stored row.
 *
 * **`null` and `{ patterns: [] }` are different answers and must stay different.** `null` means
 * "there is no saved row, or it could not be read" and falls back to the shipped patterns;
 * `[]` means the user emptied the list on purpose and is honoured as written. `preferencesStore`
 * draws the same line for `lockedBranchRules` between "don't know yet" and "protect nothing".
 * Collapsing them here would give two silent failures for the price of one: a corrupt row would
 * turn the feature off without saying so, and the first edit after that would overwrite a
 * deliberately empty list with fifteen defaults.
 *
 * Rows are filtered rather than trusted, on the same reasoning as `hiddenFilesStore.parse`: this is
 * a hand-editable settings value, and one malformed pattern should cost that pattern, not the
 * whole list.
 */
function parse(stored: string | null): StoredNesting | null {
  if (!stored) return null;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== "object" || parsed === null) return null;
    const row = parsed as Partial<StoredNesting>;
    if (!Array.isArray(row.patterns)) return null;
    return {
      enabled: row.enabled === true,
      patterns: row.patterns.filter(
        (entry): entry is NestingPattern =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as NestingPattern).id === "string" &&
          (entry as NestingPattern).id !== "" &&
          typeof (entry as NestingPattern).parent === "string" &&
          (entry as NestingPattern).parent !== "" &&
          Array.isArray((entry as NestingPattern).children) &&
          (entry as NestingPattern).children.every((child) => typeof child === "string") &&
          typeof (entry as NestingPattern).enabled === "boolean",
      ),
    };
  } catch {
    return null;
  }
}

export const useFileNestingStore = create<FileNestingState>((set, get) => {
  /** Fire-and-forget, like every write in `hiddenFilesStore`: the state on screen is already
   *  correct, and a settings write that fails must not take the interaction down with it. */
  const persist = (next: StoredNesting) => {
    void setSetting(KEY, JSON.stringify(next)).catch(() => {});
  };

  return {
    enabled: false,
    patterns: DEFAULT_NESTING_PATTERNS,
    loaded: false,

    init: async () => {
      const stored = parse(await getSetting(KEY).catch(() => null));
      set({
        enabled: stored?.enabled ?? false,
        // See `parse`: only a genuinely absent or unreadable row falls back to the defaults.
        patterns: stored ? stored.patterns : DEFAULT_NESTING_PATTERNS,
        loaded: true,
      });
    },

    setEnabled: (value) => {
      set({ enabled: value });
      persist({ enabled: value, patterns: get().patterns });
    },

    save: (patterns) => {
      set({ patterns });
      persist({ enabled: get().enabled, patterns });
    },

    reset: () => {
      set({ patterns: DEFAULT_NESTING_PATTERNS });
      persist({ enabled: get().enabled, patterns: DEFAULT_NESTING_PATTERNS });
    },
  };
});
