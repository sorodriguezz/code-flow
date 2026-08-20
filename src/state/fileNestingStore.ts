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
 * # One switch, and patterns that are not edited
 *
 * There was a whole panel for this — parent globs, `${capture}` templates, per-row enable, add,
 * delete, reset, a live preview — occupying a slot in the editor's side rail. It was taken out. For
 * "keep the spec next to its source" that is an enormous amount of apparatus to read, and the
 * question a user actually has is yes-or-no, which the explorer's own context menu already answers
 * in one click.
 *
 * The patterns stay in the stored row and are still honoured if a row is found with them, so nobody
 * who had customised loses their setup; there is simply nothing in the app that writes them any
 * more. If pattern editing is ever wanted back, it wants to be a text field holding the whole list,
 * not fifteen controls.
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
  /** Which generation of `DEFAULT_NESTING_PATTERNS` this row has already been offered. See
   *  `PATTERN_GENERATION`. Absent on every row written before there was one, which reads as 0. */
  generation?: number;
}

/**
 * Bumped whenever a rule is **added** to `DEFAULT_NESTING_PATTERNS`.
 *
 * The list is saved into the user's settings the first time the switch is touched, and after that
 * the saved copy wins — which is right for a list the user can edit, and wrong for one they cannot:
 * the panel that edited these was removed, so a new default would reach a fresh install and nobody
 * else, forever. `n-suffix-ts` was exactly that: the fix for "`.controller.docs.ts` does not nest"
 * shipped, and every existing install carried on not nesting it.
 *
 * So a row from an older generation gets the rules added since, appended in order, and is written
 * back at the new generation. Only rules *added* — an existing id is never touched, so an edited
 * pattern stays edited and a disabled one stays disabled.
 */
const PATTERN_GENERATION = 1;

/** Which generation first shipped each rule. Anything unlisted is generation 0 — original. */
const PATTERN_ADDED_IN: Record<string, number> = { "n-suffix-ts": 1 };

/**
 * The stored list plus whatever defaults it has never been offered.
 *
 * Matched by id, so a rule the user changed keeps their version of it. Returns the same array when
 * there is nothing to add, which keeps the common path free of a pointless re-render.
 */
function withNewDefaults(patterns: NestingPattern[], generation: number): NestingPattern[] {
  if (generation >= PATTERN_GENERATION) return patterns;
  // An empty list is the one unmistakable sign of a curated row — see `parse`, which goes out of
  // its way to keep "emptied on purpose" distinct from "nothing saved". Handing that row a rule
  // back would undo the only edit it has.
  if (patterns.length === 0) return patterns;
  const present = new Set(patterns.map((pattern) => pattern.id));
  const added = DEFAULT_NESTING_PATTERNS.filter(
    (pattern) => !present.has(pattern.id) && (PATTERN_ADDED_IN[pattern.id] ?? 0) > generation,
  );
  return added.length === 0 ? patterns : [...patterns, ...added];
}

interface FileNestingState {
  enabled: boolean;
  patterns: NestingPattern[];
  /** False until the first read lands, so a caller can tell "no patterns" from "not read yet". */
  loaded: boolean;
  init: () => Promise<void>;
  setEnabled: (value: boolean) => void;
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
      generation: typeof row.generation === "number" ? row.generation : 0,
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
  const persist = (next: Omit<StoredNesting, "generation">) => {
    void setSetting(KEY, JSON.stringify({ ...next, generation: PATTERN_GENERATION })).catch(
      () => {},
    );
  };

  return {
    enabled: false,
    patterns: DEFAULT_NESTING_PATTERNS,
    loaded: false,

    init: async () => {
      const stored = parse(await getSetting(KEY).catch(() => null));
      // See `parse`: only a genuinely absent or unreadable row falls back to the defaults.
      const patterns = stored
        ? withNewDefaults(stored.patterns, stored.generation ?? 0)
        : DEFAULT_NESTING_PATTERNS;
      set({ enabled: stored?.enabled ?? false, patterns, loaded: true });
      // Written back so the migration settles instead of running on every launch — and only when
      // there was a row to migrate, so a first run still leaves the settings untouched until the
      // user actually turns something on.
      if (stored && (stored.generation ?? 0) < PATTERN_GENERATION) {
        persist({ enabled: stored.enabled, patterns });
      }
    },

    setEnabled: (value) => {
      set({ enabled: value });
      persist({ enabled: value, patterns: get().patterns });
    },
  };
});
