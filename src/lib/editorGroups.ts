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
  /** Open paths, in tab order. */
  paths: string[];
  activePath: string | null;
}

let counter = 0;
export function newGroup(paths: string[] = [], activePath: string | null = null): EditorGroup {
  counter += 1;
  return { id: `group-${counter}`, paths, activePath };
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
): { groups: EditorGroup[]; focusId: string } | null {
  const index = groups.findIndex((g) => g.id === groupId);
  const source = groups[index];
  if (!source?.activePath) return null;
  const created = newGroup([source.activePath], source.activePath);
  const next = [...groups];
  next.splice(index + 1, 0, created);
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
      activePath: group.activePath === path ? neighbourOf(paths, index) : group.activePath,
    };
  });
  return updated.length > 1 ? updated.filter((group) => group.paths.length > 0) : updated;
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
    // The insertion point was measured against the strip *including* the dragged tab, so every
    // slot to its right shifts left once it's pulled out.
    const insertAt = clamp(targetIndex > current ? targetIndex - 1 : targetIndex, 0, without.length);
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
  const insertAt = clamp(existing >= 0 && targetIndex > existing ? targetIndex - 1 : targetIndex, 0, toPaths.length);
  toPaths.splice(insertAt, 0, source.path);

  const next = groups.map((group) => {
    if (group.id === from.id) {
      return {
        ...group,
        paths: fromPaths,
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
