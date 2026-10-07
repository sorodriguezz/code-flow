/**
 * The order the Flows explorer draws its lists in, and what a drag does to one.
 *
 * **Manual, not alphabetical.** Folders, each folder's flows and the top level's are in the order
 * they were dragged into (`sort_order`), which `migrations::seed_manual_flow_order` first set from
 * the names they used to be sorted by — so nothing moved the day dragging arrived. Names only break
 * ties. A new flow or folder is appended to its list.
 *
 * **Another workspace's global flows come last at the top level, by name.** They are on this shelf,
 * but their place belongs to their home's list, so they are drawn after this workspace's own top
 * level and are not dragged here — the same `own` rule the explorer's menu keeps.
 *
 * Pure, so the tree and the store that writes a drop agree by construction: the store renumbers
 * exactly the list the explorer drew.
 */

interface Placed {
  id: string;
  name: string;
  sort_order: number;
}

interface PlacedFlow extends Placed {
  workspace_id: string;
  folder_id: string | null;
}

export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

/** The dragged order, ties by name. */
export const byPlace = (a: Placed, b: Placed) => a.sort_order - b.sort_order || byName(a, b);

/**
 * Whether `flow` is drawn in the list `folderId` names — a folder's, or the top level's (`null`).
 * A flow filed in a folder this tree does not show (another workspace's) is at the top level.
 */
function inList(flow: PlacedFlow, folderId: string | null, shown: Set<string>): boolean {
  const filed = flow.folder_id && shown.has(flow.folder_id) ? flow.folder_id : null;
  return filed === folderId;
}

/** The tree as the explorer draws it, filtered by `needle` (a lower-cased name fragment). */
export function flowGroups<F extends PlacedFlow, D extends Placed>(
  flows: F[],
  folders: D[],
  workspaceId: string | null,
  needle: string,
): { folders: { folder: D; flows: F[] }[]; root: F[] } {
  const matches = (flow: F) => !needle || flow.name.toLowerCase().includes(needle);
  const shown = new Set(folders.map((folder) => folder.id));
  const grouped = [...folders].sort(byPlace).map((folder) => ({
    folder,
    flows: flows.filter((flow) => inList(flow, folder.id, shown) && matches(flow)).sort(byPlace),
  }));
  const top = flows.filter((flow) => inList(flow, null, shown) && matches(flow));
  const own = top.filter((flow) => flow.workspace_id === workspaceId).sort(byPlace);
  const foreign = top.filter((flow) => flow.workspace_id !== workspaceId).sort(byName);
  return {
    folders: needle ? grouped.filter((group) => group.flows.length > 0) : grouped,
    root: [...own, ...foreign],
  };
}

/** One list of the workspace's own flows — a folder's, or the top level's — in its drawn order. */
export function ownList<F extends PlacedFlow>(
  flows: F[],
  folders: Placed[],
  workspaceId: string,
  folderId: string | null,
): F[] {
  const shown = new Set(folders.map((folder) => folder.id));
  return flows
    .filter((flow) => flow.workspace_id === workspaceId && inList(flow, folderId, shown))
    .sort(byPlace);
}

/**
 * `list` with `item` placed next to `anchor` — before it, or after it with `after` — or appended
 * when there is no anchor (or the anchor is not in the list). `item` is taken out first wherever it
 * was, so the same call reorders within a list and inserts into another.
 */
export function placeIn<T extends { id: string }>(
  list: T[],
  item: T,
  anchor: { id: string; after: boolean } | null,
): T[] {
  const rest = list.filter((entry) => entry.id !== item.id);
  const at = anchor ? rest.findIndex((entry) => entry.id === anchor.id) : -1;
  const index = at < 0 ? rest.length : anchor?.after ? at + 1 : at;
  return [...rest.slice(0, index), item, ...rest.slice(index)];
}
