/**
 * How a repository's terminals are laid out in the dock: their order in the list, which of them
 * share a split, which way each split runs, how the room is shared, and which splits type into all
 * their panes at once. Pure — the store calls these and keeps the result.
 */

/** A split: terminals shown side by side (`row`) or stacked (`column`). A terminal belongs to
 *  exactly one group; a terminal on its own is a group of one. */
export interface TerminalGroup {
  id: string;
  ids: string[];
  dir: "row" | "column";
  /** One share per pane, summing to 1. */
  sizes: number[];
  /** Typing into any pane of the group goes to all of them. */
  broadcast: boolean;
}

let groupSeq = 0;
export function newGroup(ids: string[], dir: "row" | "column" = "row"): TerminalGroup {
  groupSeq += 1;
  return { id: `g${Date.now().toString(36)}${groupSeq}`, ids, dir, sizes: evenSizes(ids.length), broadcast: false };
}

export function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / Math.max(1, count));
}

/** Sizes that sum to 1 and give no pane less than `min` of the room. */
export function normalizeSizes(sizes: number[], count: number, min = 0.08): number[] {
  if (sizes.length !== count || sizes.some((size) => !Number.isFinite(size) || size <= 0)) return evenSizes(count);
  const floored = sizes.map((size) => Math.max(min, size));
  const total = floored.reduce((sum, size) => sum + size, 0);
  return floored.map((size) => size / total);
}

/** `id` added after `after` in its group (or at the end), and the room shared evenly again. */
export function addToGroup(group: TerminalGroup, id: string, dir?: "row" | "column"): TerminalGroup {
  const ids = [...group.ids, id];
  return { ...group, ids, dir: group.ids.length === 1 && dir ? dir : group.dir, sizes: evenSizes(ids.length) };
}

/** `id` taken out of whichever group holds it; a group left empty goes. The others keep their
 *  proportions — the freed share is spread over them. */
export function removeFromGroups(groups: TerminalGroup[], id: string): TerminalGroup[] {
  return groups
    .map((group) => {
      const at = group.ids.indexOf(id);
      if (at < 0) return group;
      const ids = group.ids.filter((entry) => entry !== id);
      const sizes = group.sizes.filter((_, index) => index !== at);
      return { ...group, ids, sizes: normalizeSizes(sizes, ids.length), broadcast: ids.length > 1 && group.broadcast };
    })
    .filter((group) => group.ids.length > 0);
}

/** Every mention of `from` replaced by `to` — a terminal restarted keeps its place. */
export function replaceId(groups: TerminalGroup[], from: string, to: string): TerminalGroup[] {
  return groups.map((group) =>
    group.ids.includes(from) ? { ...group, ids: group.ids.map((entry) => (entry === from ? to : entry)) } : group,
  );
}

/** `id` moved out of its split into a group of its own. */
export function detach(groups: TerminalGroup[], id: string): TerminalGroup[] {
  const holder = groups.find((group) => group.ids.includes(id));
  if (!holder || holder.ids.length === 1) return groups;
  return [...removeFromGroups(groups, id), newGroup([id])];
}

/** `id` moved into `targetId`'s split, at its end. */
export function joinGroup(groups: TerminalGroup[], id: string, targetGroupId: string): TerminalGroup[] {
  const target = groups.find((group) => group.id === targetGroupId);
  if (!target || target.ids.includes(id)) return groups;
  const rest = removeFromGroups(groups, id);
  return rest.map((group) => (group.id === targetGroupId ? addToGroup(group, id) : group));
}

/** `id` moved to `index` in the list, the others closing up around it. */
export function moveInList<T extends { id: string }>(items: T[], id: string, index: number): T[] {
  const from = items.findIndex((item) => item.id === id);
  if (from < 0) return items;
  const next = items.filter((item) => item.id !== id);
  const to = Math.max(0, Math.min(next.length, index));
  next.splice(to, 0, items[from]);
  return next;
}

/**
 * The divider between pane `index` and `index + 1` moved by `delta` (a share of the whole); the two
 * panes it separates trade the room, neither going under `min`.
 */
export function resizeAt(sizes: number[], index: number, delta: number, min = 0.08): number[] {
  if (index < 0 || index >= sizes.length - 1) return sizes;
  const pair = sizes[index] + sizes[index + 1];
  const left = Math.max(min, Math.min(pair - min, sizes[index] + delta));
  const next = [...sizes];
  next[index] = left;
  next[index + 1] = pair - left;
  return next;
}
