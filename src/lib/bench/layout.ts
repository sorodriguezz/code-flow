/**
 * The arrangement of shells inside one bench tab, and every operation on it.
 *
 * A **binary tree**, not a list of groups. The repository dock models a split as an array of ids
 * shown side by side, which can draw one row or one column and nothing else. What was asked for —
 * and what every terminal emulator with panes does — needs two levels: one shell down the left with
 * two stacked beside it is a column split whose right half is a row split, and no flat grouping can
 * say that.
 *
 * **Pure, and separate from the component that draws it, so it can be reasoned about.** Splitting,
 * closing and resizing are the operations where an off-by-one leaves a pane that cannot be reached
 * or a ratio that collapses one side to nothing, and none of that is visible in a screenshot until
 * it has already happened to somebody's work.
 *
 * **Stored as JSON in `workspace_bench_tabs.layout`.** The backend keeps the string and never walks
 * it; this file is the only thing that understands it, which is also why [`reconcile`] exists — a
 * tree read back from the database is *untrusted input*, and it can name terminals that were killed
 * in another window or omit ones that were added.
 */

/** A pane showing one terminal. The leaf is the terminal — there is no empty pane. */
export interface PaneLeaf {
  kind: "leaf";
  /** A `workspace_terminals.id`. */
  id: string;
}

export interface PaneSplit {
  kind: "split";
  /** `row` puts `a` left of `b`; `col` puts `a` above `b`. */
  dir: "row" | "col";
  /** `a`'s share of the axis, 0–1. Clamped to [MIN_RATIO, 1 - MIN_RATIO] on every write. */
  ratio: number;
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

/**
 * How small a pane may be dragged, as a fraction of its parent.
 *
 * Not a matter of taste: a pane is an xterm, and xterm's fit addon divides the box by the cell size
 * and floors it. A pane dragged to nothing reports *one column* to the shell, which then draws its
 * prompt for a one-column terminal and stays broken after the divider is dragged back — the damage
 * outlives the gesture. Ten percent of a pane is always several columns wide.
 */
const MIN_RATIO = 0.1;

export const clampRatio = (ratio: number): number => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio));

export const leaf = (id: string): PaneLeaf => ({ kind: "leaf", id });

/** Every terminal the tree shows, left to right and top to bottom — which is also tab order. */
export function paneIds(node: PaneNode | null): string[] {
  if (!node) return [];
  return node.kind === "leaf" ? [node.id] : [...paneIds(node.a), ...paneIds(node.b)];
}

/**
 * Splits the pane showing `targetId`, putting `newId` in the half that opens up.
 *
 * The *pane* splits, not the tab — which is what makes the arrangement build up the way the user
 * expects. Splitting the right-hand pane of a row divides that pane in two and leaves the left one
 * exactly as it was; splitting the tab instead would halve everything on screen every time.
 *
 * The new pane always takes the second half, so "split right" puts it on the right and "split down"
 * puts it below. Anything else would be a surprise every time.
 */
export function splitPane(node: PaneNode, targetId: string, newId: string, dir: "row" | "col"): PaneNode {
  if (node.kind === "leaf") {
    return node.id === targetId ? { kind: "split", dir, ratio: 0.5, a: node, b: leaf(newId) } : node;
  }
  return { ...node, a: splitPane(node.a, targetId, newId, dir), b: splitPane(node.b, targetId, newId, dir) };
}

/**
 * Removes the pane showing `id`; its sibling takes the whole of the space they shared.
 *
 * `null` when the tree held nothing else — an empty tab, which the caller closes. Returning a tree
 * with a hole in it instead would be a pane nobody can put anything in.
 */
export function removePane(node: PaneNode, id: string): PaneNode | null {
  if (node.kind === "leaf") return node.id === id ? null : node;
  const a = removePane(node.a, id);
  const b = removePane(node.b, id);
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/** Sets one divider's position, found by the split's own path. See [`pathTo`]. */
export function setRatio(node: PaneNode, path: string, ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (path === "") return { ...node, ratio: clampRatio(ratio) };
  const [head, ...rest] = path.split(".");
  const tail = rest.join(".");
  return head === "a"
    ? { ...node, a: setRatio(node.a, tail, ratio) }
    : { ...node, b: setRatio(node.b, tail, ratio) };
}

/**
 * Reconciles a stored tree against the terminals that actually exist.
 *
 * Every load goes through this, because the two can disagree in both directions and neither is a
 * bug worth failing over: a terminal deleted from another window leaves an id in the tree that
 * names nothing, and one added while this layout was stale leaves a terminal the tree never
 * mentions. Dropped and appended respectively — the arrangement the user built is kept, and what
 * cannot be honoured is fixed rather than refused.
 *
 * A tab with terminals and no stored layout at all — a fresh tab, or one migrated from the flat
 * bench that came before panes — comes out as a single column of them, which is the arrangement it
 * effectively had.
 */
export function reconcile(node: PaneNode | null, existing: string[]): PaneNode | null {
  const alive = new Set(existing);
  let pruned = node;
  for (const id of paneIds(node)) {
    if (!alive.has(id) && pruned) pruned = removePane(pruned, id);
  }
  const shown = new Set(paneIds(pruned));
  for (const id of existing) {
    if (shown.has(id)) continue;
    // Appended as a column, which is the axis a terminal has the least use for: a shell's lines are
    // wide and short, so halving the height costs less than halving the width. The user can drag or
    // re-split it wherever they actually want it.
    pruned = pruned ? { kind: "split", dir: "col", ratio: 0.5, a: pruned, b: leaf(id) } : leaf(id);
  }
  return pruned;
}

/** Parses a stored layout. Anything unparseable or structurally wrong comes back `null` and is
 *  rebuilt from the tab's terminals by [`reconcile`] — a corrupt string must not cost the shells. */
export function parseLayout(raw: string): PaneNode | null {
  if (!raw.trim()) return null;
  try {
    return valid(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export const serializeLayout = (node: PaneNode | null): string => (node ? JSON.stringify(node) : "");

/** Structural validation, because this comes off disk and a malformed branch would throw inside
 *  the renderer — where the failure is a blank panel rather than a message. */
function valid(value: unknown): PaneNode | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") return typeof node.id === "string" && node.id ? { kind: "leaf", id: node.id } : null;
  if (node.kind !== "split") return null;
  const a = valid(node.a);
  const b = valid(node.b);
  if (!a || !b) return null;
  const dir = node.dir === "row" ? "row" : "col";
  const ratio = typeof node.ratio === "number" && Number.isFinite(node.ratio) ? clampRatio(node.ratio) : 0.5;
  return { kind: "split", dir, ratio, a, b };
}
