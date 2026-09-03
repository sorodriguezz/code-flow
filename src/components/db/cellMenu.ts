import { Ban, ClipboardPaste, Copy, Scissors } from "lucide-react";
import type { MenuItem } from "../common/ContextMenu";
import { pushErrorToast } from "../../state/toastStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The four things a right-click on a data cell can do, in one place for every grid that has cells.
 *
 * # Why this exists at all
 *
 * Right-clicking a result cell used to reach one of two wrong answers. Over a plain cell the
 * document-level guard in `lib/contextMenuGuard` swallowed the event and *nothing* opened, because
 * the guard's job is to stop the webview offering Reload / Back / Inspect Element inside a window
 * that has no history and no tab. Over a cell being edited it was worse: the editor is a real
 * `<input>`, the guard deliberately stands down on text fields so that right-click-paste keeps
 * working in the app's ~150 form boxes, and the platform menu appeared over the grid.
 *
 * So the grid has to claim the event itself. That is the seam the guard is built around — it stands
 * down the moment it sees `defaultPrevented` — and claiming it is also the only way to offer the
 * one menu a data cell actually wants.
 *
 * # NULL is not empty, and the clipboard cannot say so
 *
 * The grid draws NULL and `""` differently on purpose, and everything downstream keeps them apart.
 * The system clipboard has no way to carry "no value": it holds text or it holds nothing. Copying a
 * NULL cell therefore writes an empty string rather than the four letters `NULL`, because a
 * clipboard holding `NULL` pastes the *string* "NULL" into the next cell — a real value, silently
 * different from the one that was copied, and indistinguishable afterwards from a column that
 * genuinely contains that word.
 *
 * Cut removes a value, and in a database removing a value is NULL, not `""`. That asymmetry with
 * Copy is deliberate: Copy answers "what is in this cell", Cut answers "take it out".
 *
 * # Nothing here writes to a database
 *
 * `onSet` stages an edit exactly as typing into the cell does. Cut and Set NULL are staged changes
 * that show up tinted and are saved, or discarded, with everything else. A read-only grid passes
 * `onSet: null` and gets Copy alone — rather than four entries, three of which would be inert.
 */

/** Translations, taken as a parameter because this is a plain builder rather than a component. */
type Translate = (key: TranslationKey, params?: Record<string, string>) => string;

export interface CellMenuTarget {
  /** The cell's value as the grid is showing it — a staged edit if there is one, NULL as `null`. */
  value: string | null;
  /**
   * Stages a new value for this cell, or `null` for `null` in the SQL sense.
   *
   * `null` here — the callback itself, not the value — means the grid is read-only, which is how a
   * console result differs from a table's data tab.
   */
  onSet: ((value: string | null) => void) | null;
}

/**
 * Copies a cell to the clipboard, NULL included.
 *
 * Exported because the row-level menus copy whole rows through the same rules and should not each
 * decide what a NULL looks like on the way out.
 */
export async function copyCellValue(value: string | null): Promise<void> {
  await navigator.clipboard.writeText(value ?? "");
}

export function cellMenuItems(target: CellMenuTarget, t: Translate): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: t("db.cellCopy"),
      icon: Copy,
      onClick: () => {
        void copyCellValue(target.value).catch(() => pushErrorToast(t("db.cellCopyFailed")));
      },
    },
  ];

  const set = target.onSet;
  if (!set) return items;

  items.push(
    {
      label: t("db.cellCut"),
      icon: Scissors,
      onClick: () => {
        // Staged only after the copy lands. Cutting a value the clipboard never received would
        // destroy it with nothing to paste back, and the write is the half that can fail.
        void copyCellValue(target.value)
          .then(() => set(null))
          .catch(() => pushErrorToast(t("db.cellCopyFailed")));
      },
    },
    {
      label: t("db.cellPaste"),
      icon: ClipboardPaste,
      onClick: () => {
        // `readText` needs a user gesture, and a click on a menu item is one. It can still be
        // refused — the webview may not grant read access even where it grants write — so the
        // failure says what to do instead rather than leaving a menu entry that quietly does
        // nothing. Pasting into the cell editor with ⌘V never goes through here.
        void navigator.clipboard
          .readText()
          .then((text) => set(text))
          .catch(() => pushErrorToast(t("db.cellPasteFailed")));
      },
    },
    {
      label: t("db.cellSetNull"),
      icon: Ban,
      // Separated: the three above are clipboard, this one is a value. They are next to each other
      // because both are things you do to a cell, not because they are the same kind of thing.
      separated: true,
      // Offered even where the column rejects NULL. `DbColumn` carries a name and a type and no
      // nullability — the grid genuinely does not know — and a staged edit the engine refuses
      // surfaces on save with the engine's own message, which is the same path every other invalid
      // edit already takes. Greying it out on a guess would hide the action on columns that do
      // accept NULL.
      onClick: () => set(null),
    },
  );

  return items;
}
