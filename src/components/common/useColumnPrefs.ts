import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What the user has decided about one listing's columns, kept for as long as the panel is open.
 *
 * **Nothing here goes to disk, and that is the design.** These are decisions about the shape of one
 * session's work — the width of a key column in the table you are reading right now — not settings.
 * `layoutStore` is not the place either: it stores one number per `LayoutKey`, and a width *map*
 * keyed by column name is not that.
 */
export interface ColumnPrefs {
  /** Pinned display order, or `null` to follow the data. */
  order: string[] | null;
  hidden: Set<string>;
  /** Columns the user asked for that the data has not produced — kept apart from the derived set so
   *  "Reset" can drop them and a fresh listing cannot. */
  extra: string[];
  /** Widths the user dragged. Anything not in here is auto-fitted to the content. */
  widths: Record<string, number>;
}

/**
 * One map of column preferences per panel, keyed by whatever the panel calls a scope — a table name,
 * a queue name, a `/blob:root` leg.
 *
 * **The map is a ref, and that is the whole reason this is a hook rather than four lines of state.**
 * The preferences have to survive clicking away to another table and back, and every panel that
 * holds them resets its state when the selection changes — so as state they would be wiped by the
 * very effect that makes the switch. As a ref they survive it. The cost is that a ref changing is
 * not something a `useMemo` can see, which is what `version` is for: it goes in the dependency list
 * of every memo that reads `prefsFor`, and without it a column the user just hid stays drawn.
 *
 * `resetOn` is the host: a different account is a different everything, and carrying one account's
 * widths into another's tables of the same name is how a grid of 36-character GUID keys arrives
 * truncated.
 */
export function useColumnPrefs(resetOn: string): {
  /** Never null: an unseen scope follows the data. */
  prefsFor: (scope: string) => ColumnPrefs;
  update: (scope: string, changes: Partial<ColumnPrefs>) => void;
  /** Bumped by `update`. Belongs in the dependency list of every memo that reads `prefsFor`. */
  version: number;
} {
  const prefs = useRef(new Map<string, ColumnPrefs>());
  const [version, setVersion] = useState(0);

  // Reading a scope nobody has touched must not *create* it: the defaults are what "follow the
  // data" looks like, and writing them in would make an untouched listing indistinguishable from
  // one the user had reset by hand.
  const prefsFor = useCallback(
    (scope: string): ColumnPrefs =>
      prefs.current.get(scope) ?? { order: null, hidden: new Set(), extra: [], widths: {} },
    [],
  );

  const update = useCallback(
    (scope: string, changes: Partial<ColumnPrefs>) => {
      prefs.current.set(scope, { ...prefsFor(scope), ...changes });
      setVersion((n) => n + 1);
    },
    [prefsFor],
  );

  // Guarded on `size` rather than run unconditionally: this effect fires once on mount, where there
  // is nothing to clear, and a `setVersion` there would be a second render before the panel has
  // drawn its first.
  useEffect(() => {
    if (prefs.current.size === 0) return;
    prefs.current.clear();
    setVersion((n) => n + 1);
  }, [resetOn]);

  return { prefsFor, update, version };
}
