/** The arithmetic behind split editors, as pure functions over the group list.
 *
 * Kept out of the component because these are the rules people actually notice — "the file I
 * opened went to the wrong pane", "splitting duplicated my whole tab strip" — and a rule you can
 * only exercise by clicking around the app is a rule that stays broken. Everything here is
 * data-in/data-out so it can be checked directly.
 */

/**
 * One editor group. It owns only *which* files it shows and which is on top; the files themselves
 * live in a registry shared by every group, which is what makes the same file open in two panes
 * one buffer rather than two copies.
 */
export interface EditorGroup {
  id: string;
  /**
   * Which column of the grid this group sits in.
   *
   * The list stays flat and ordered; this is the second axis laid over it. Groups sharing a column
   * are **contiguous in the list** and are stacked top to bottom inside it; each distinct column, in
   * first-appearance order, is one vertical slice of the editor. Every function here maintains that
   * contiguity, and the layout in `EditorView` reads it straight off the list.
   *
   * A tree of nested splits — VS Code's model — buys arbitrary nesting for a large amount of
   * bookkeeping in every operation. Two levels covers "put this beside that" and "put this under
   * that", which is what the gesture actually asks for, and leaves every existing function working
   * on a plain array.
   */
  column: string;
  /** Open paths, in tab order. Pinned ones are always the head of it — see `pinned`. */
  paths: string[];
  activePath: string | null;
  /**
   * Paths pinned in *this* group, as a set. Pinning is a property of the tab, not of the file:
   * the same file open in two splits can be pinned in one and not the other, which is why this
   * lives here rather than beside the file's text in the registry.
   *
   * The invariant every function below maintains: **the pinned paths occupy the first
   * `pinned.length` slots of `paths`**. "Pinned" is only worth anything if the tab stays where
   * you can find it, so it is an ordering rule and not just a flag — a drag that would leave a
   * pinned tab after an unpinned one is clamped back to the boundary rather than refused.
   */
  pinned: string[];
}

let counter = 0;
/** Column ids are generated apart from group ids: a column outlives the group that opened it when
 *  more groups are stacked into it, and reusing a group's id would make that read backwards. */
let columns = 0;

export const newColumn = () => `column-${(columns += 1)}`;

export function newGroup(
  paths: string[] = [],
  activePath: string | null = null,
  column: string = newColumn(),
): EditorGroup {
  counter += 1;
  return { id: `group-${counter}`, column, paths, activePath, pinned: [] };
}

/** Where the pinned run ends in `paths` — the only insertion point both regions agree on. */
function boundaryIn(paths: string[], pinned: string[]): number {
  return paths.filter((p) => pinned.includes(p)).length;
}

/** The tab to fall back to once the one at `index` is gone: whatever slid into its slot, then its
 * left neighbour — the "keep looking at something adjacent" rule editors use. */
function neighbourOf(paths: string[], index: number): string | null {
  return paths[index] ?? paths[index - 1] ?? null;
}

export interface OpenOutcome {
  groups: EditorGroup[];
  /** The preview tab this open took the place of, if any. Still open elsewhere unless
   * `evictedFully` says otherwise. */
  evicted: string | null;
  /** True when the evicted path is no longer in *any* group — the caller drops it from the
   * registry, which is also what disposes its editor model. */
  evictedFully: boolean;
}

/**
 * Opens `path` in exactly one group — the target — and leaves every other group untouched. That
 * "exactly one" is the whole point: opening a file while the editor is split must not make it
 * appear in both panes.
 *
 * A non-pinned open takes over the *target group's* preview slot rather than adding a tab, so
 * clicking through the tree on the left never evicts what's pinned on the right.
 */
export function openInGroups(
  groups: EditorGroup[],
  targetId: string,
  path: string,
  pin: boolean,
  isPreview: (path: string) => boolean,
): OpenOutcome {
  const target = groups.find((g) => g.id === targetId) ?? groups[0];
  if (!target) return { groups, evicted: null, evictedFully: false };

  const previewIndex =
    pin || target.paths.includes(path) ? -1 : target.paths.findIndex((p) => isPreview(p));
  const evicted = previewIndex >= 0 ? target.paths[previewIndex] : null;

  const next = groups.map((group) => {
    if (group.id !== target.id) return group;
    if (group.paths.includes(path)) return { ...group, activePath: path };
    if (previewIndex < 0) return { ...group, paths: [...group.paths, path], activePath: path };
    const paths = [...group.paths];
    paths[previewIndex] = path;
    return { ...group, paths, activePath: path };
  });

  return { groups: next, evicted, evictedFully: evicted !== null && !next.some((g) => g.paths.includes(evicted)) };
}

/**
 * Splits a group's **current file only** into a new group immediately to its right.
 *
 * Only the active file crosses over — never the rest of the tab strip. The split means "show me
 * this file beside itself"; what happens next is decided by whichever group has focus, which is
 * the new one. There is no cap: splitting again splits again, like VS Code.
 */
export function splitGroups(
  groups: EditorGroup[],
  groupId: string,
  /** Which file crosses over. Defaults to the group's active one — the toolbar button and the
   * shortcut mean "this file", while the tab menu means the tab it was opened on, which needn't
   * be the one on top. */
  path?: string,
): { groups: EditorGroup[]; focusId: string } | null {
  const index = groups.findIndex((g) => g.id === groupId);
  const source = groups[index];
  const moving = path ?? source?.activePath;
  if (!source || !moving || !source.paths.includes(moving)) return null;
  // Its own column, so the new group lands *beside* the source rather than under it — which is what
  // the split button and its shortcut have always meant.
  const created = newGroup([moving], moving);
  const next = [...groups];
  next.splice(lastIndexOfColumn(groups, source.column) + 1, 0, created);
  return { groups: next, focusId: created.id };
}

/**
 * Closes one tab in one group. An emptied group folds away — unless it's the last one, since that
 * would leave nowhere for the next file to open.
 */
export function closeTabInGroups(groups: EditorGroup[], groupId: string, path: string): EditorGroup[] {
  const source = groups.find((g) => g.id === groupId);
  if (!source?.paths.includes(path)) return groups;
  const updated = groups.map((group) => {
    if (group.id !== groupId) return group;
    const index = group.paths.indexOf(path);
    const paths = group.paths.filter((p) => p !== path);
    return {
      ...group,
      paths,
      pinned: group.pinned.filter((p) => p !== path),
      activePath: group.activePath === path ? neighbourOf(paths, index) : group.activePath,
    };
  });
  return updated.length > 1 ? updated.filter((group) => group.paths.length > 0) : updated;
}

/**
 * Sweeps one group's tabs, keeping the pinned ones. Pinning is the gesture for "keep this in
 * reach", so a sweep that took pinned tabs with it would leave the pin meaning nothing.
 *
 * A group left with no pinned tab folds away — unless it's the last one, which stays as the empty
 * editor, the same bargain `closeTabInGroups` makes when you close the final tab.
 */
export function closeAllInGroups(groups: EditorGroup[], groupId: string): EditorGroup[] {
  const emptied = groups.map((group) => {
    if (group.id !== groupId) return group;
    const paths = group.paths.filter((p) => group.pinned.includes(p));
    return {
      ...group,
      paths,
      // The survivors all sit left of whatever was active, since pinned tabs hold the head slots —
      // so the adjacent tab to land on is the last of them.
      activePath: paths.includes(group.activePath ?? "") ? group.activePath : neighbourOf(paths, paths.length),
    };
  });
  return emptied.length > 1 ? emptied.filter((group) => group.paths.length > 0) : emptied;
}

/**
 * Pins or unpins one tab, moving it to the pinned/unpinned boundary so the invariant on
 * `EditorGroup.pinned` holds. Either direction is the shortest trip: pinning parks the tab at the
 * end of the pinned run rather than at the very front, so pinning three files in a row keeps them
 * in the order they were pinned.
 */
export function togglePinInGroups(groups: EditorGroup[], groupId: string, path: string): EditorGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId || !group.paths.includes(path)) return group;
    const pinned = group.pinned.includes(path)
      ? group.pinned.filter((p) => p !== path)
      : [...group.pinned, path];
    const rest = group.paths.filter((p) => p !== path);
    const paths = [...rest];
    paths.splice(boundaryIn(rest, pinned), 0, path);
    return { ...group, paths, pinned };
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Moves a tab to `targetIndex` in `targetGroupId` — the one operation behind both gestures:
 * dragging a tab along its own strip, and dragging it into another split.
 *
 * `targetIndex` is an **insertion point**, not a tab position: 0 is before the first tab and
 * `paths.length` is after the last. That's what makes "drop it at the end of the strip" and "drop
 * it between these two" the same call, and it's why dropping past a tab's midpoint lands after it
 * rather than on it.
 *
 * Moving the last tab out of a group folds that group away, the same as closing it — an empty
 * pane left behind is just something else to clean up.
 */
export function moveTabInGroups(
  groups: EditorGroup[],
  source: { groupId: string; path: string },
  targetGroupId: string,
  targetIndex: number,
): { groups: EditorGroup[]; focusId: string } | null {
  const from = groups.find((g) => g.id === source.groupId);
  const to = groups.find((g) => g.id === targetGroupId);
  if (!from || !to || !from.paths.includes(source.path)) return null;

  if (from.id === to.id) {
    const current = from.paths.indexOf(source.path);
    const without = from.paths.filter((p) => p !== source.path);
    // A tab can be reordered freely, but only within its own half of the strip: dropping a pinned
    // tab past the boundary lands it at the boundary instead of unpinning it, because a drag is a
    // reorder and pinning is a separate decision made from the menu.
    const boundary = boundaryIn(without, from.pinned);
    const pinnedHere = from.pinned.includes(source.path);
    // The insertion point was measured against the strip *including* the dragged tab, so every
    // slot to its right shifts left once it's pulled out.
    const insertAt = clamp(
      targetIndex > current ? targetIndex - 1 : targetIndex,
      pinnedHere ? 0 : boundary,
      pinnedHere ? boundary : without.length,
    );
    if (insertAt === current) return { groups, focusId: from.id };
    const paths = [...without];
    paths.splice(insertAt, 0, source.path);
    return {
      groups: groups.map((g) => (g.id === from.id ? { ...g, paths, activePath: source.path } : g)),
      focusId: from.id,
    };
  }

  const fromIndex = from.paths.indexOf(source.path);
  const fromPaths = from.paths.filter((p) => p !== source.path);
  // Dragging a file into a group that already shows it isn't a duplicate — it's a reposition,
  // and the file stops being open twice.
  const existing = to.paths.indexOf(source.path);
  const toPaths = existing >= 0 ? to.paths.filter((p) => p !== source.path) : [...to.paths];
  // Pinning doesn't travel: a tab dragged into another split arrives unpinned there, so it lands
  // in the unpinned region — unless that group had it pinned already, which the reposition keeps.
  const boundary = boundaryIn(toPaths, to.pinned);
  const pinnedThere = to.pinned.includes(source.path);
  const insertAt = clamp(
    existing >= 0 && targetIndex > existing ? targetIndex - 1 : targetIndex,
    pinnedThere ? 0 : boundary,
    pinnedThere ? boundary : toPaths.length,
  );
  toPaths.splice(insertAt, 0, source.path);

  const next = groups.map((group) => {
    if (group.id === from.id) {
      return {
        ...group,
        paths: fromPaths,
        pinned: group.pinned.filter((p) => p !== source.path),
        activePath: group.activePath === source.path ? neighbourOf(fromPaths, fromIndex) : group.activePath,
      };
    }
    if (group.id === to.id) return { ...group, paths: toPaths, activePath: source.path };
    return group;
  });

  return {
    groups: next.length > 1 ? next.filter((group) => group.paths.length > 0) : next,
    focusId: to.id,
  };
}

/** The last slot a column occupies in the flat list — where a new column has to go to sit after it
 *  without breaking the contiguity every reader depends on. */
function lastIndexOfColumn(groups: EditorGroup[], column: string): number {
  let last = -1;
  groups.forEach((group, at) => {
    if (group.column === column) last = at;
  });
  return last;
}

/** Where a side lands: which way the new group goes relative to the one dropped on. */
export type SplitSide = "left" | "right" | "top" | "bottom";

/**
 * Drops a dragged tab against the **edge** of a group, splitting the editor there.
 *
 * The gesture VS Code has and this app did not: dragging a tab over another pane offered exactly one
 * outcome, "put it in that group", so the only way to see two files at once was the split button —
 * which always splits the *active* file to the right. This is the other half: aim at an edge and the
 * file goes beside, or under, whatever you aimed at.
 *
 * `left`/`right` open a **new column**, so the two panes sit side by side. `top`/`bottom` reuse the
 * target's column and stack inside it. That is the whole of the grid: a row of columns, each a
 * stack of groups.
 *
 * The tab leaves its old group the way any move does — including the group folding away when it was
 * the last tab in it, which is what makes dragging the only tab of a pane across the screen a *move*
 * rather than a way to end up with an empty pane.
 */
export function dropIntoSplit(
  groups: EditorGroup[],
  source: { groupId: string; path: string },
  targetGroupId: string,
  side: SplitSide,
): { groups: EditorGroup[]; focusId: string } | null {
  const from = groups.find((g) => g.id === source.groupId);
  const target = groups.find((g) => g.id === targetGroupId);
  if (!from || !target || !from.paths.includes(source.path)) return null;
  // Splitting a group away from itself when it holds nothing else would produce the group it came
  // from, one pane to the side, and an empty one where it was.
  if (from.id === target.id && from.paths.length === 1) return null;

  const fromIndex = from.paths.indexOf(source.path);
  const withoutIt = from.paths.filter((p) => p !== source.path);
  const trimmed = groups.map((group) =>
    group.id === from.id
      ? {
          ...group,
          paths: withoutIt,
          pinned: group.pinned.filter((p) => p !== source.path),
          activePath:
            group.activePath === source.path ? neighbourOf(withoutIt, fromIndex) : group.activePath,
        }
      : group,
  );
  // An emptied source folds away before the insertion point is measured, or the new group lands one
  // slot off whenever the drag came from a single-tab pane to its left.
  const surviving = trimmed.filter((group) => group.paths.length > 0);

  const vertical = side === "top" || side === "bottom";
  const created = newGroup([source.path], source.path, vertical ? target.column : newColumn());
  const targetAt = surviving.findIndex((group) => group.id === target.id);
  const at = vertical
    ? targetAt + (side === "bottom" ? 1 : 0)
    : side === "right"
      ? lastIndexOfColumn(surviving, target.column) + 1
      : surviving.findIndex((group) => group.column === target.column);

  const next = [...surviving];
  next.splice(at, 0, created);
  return { groups: next, focusId: created.id };
}

/**
 * Closes a whole group, reporting which of its files no other group was showing.
 *
 * Those orphans close with the group — a pane is not a filing cabinet, and moving stray tabs into
 * the neighbour "to be safe" just leaves files stuck somewhere the user didn't put them. The
 * caller confirms first when any of them has unsaved edits, which is the same bargain closing a
 * dirty tab makes.
 */
export function closeGroupInGroups(
  groups: EditorGroup[],
  groupId: string,
): { groups: EditorGroup[]; focusId: string; orphaned: string[] } | null {
  if (groups.length < 2) return null;
  const index = groups.findIndex((g) => g.id === groupId);
  const closing = groups[index];
  if (!closing) return null;
  const remaining = groups.filter((g) => g.id !== groupId);
  // Focus goes to the neighbour on the left, falling back to the one on the right — the group
  // the eye is already nearest to.
  const survivor = remaining[Math.max(0, index - 1)] ?? remaining[0];
  return {
    groups: remaining,
    focusId: survivor.id,
    orphaned: closing.paths.filter((p) => !remaining.some((g) => g.paths.includes(p))),
  };
}
