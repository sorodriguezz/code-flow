import type {
  Diagram,
  DiagramFolder,
  DiagramFolderRow,
  DiagramTreeRow,
} from "../../types/diagrams";

/**
 * The folder tree, and the flat list the explorer actually draws.
 *
 * The counterpart of `lib/notes/tree.ts`, and its reasoning applies here unchanged: nested data
 * rendered as a nested component tree is the shape that gets slow, because renaming one diagram
 * six levels down rebuilds every ancestor's JSX to produce the level below it. Flattening to rows
 * with a `depth` breaks that — the list maps over rows, each row is its own memoised component
 * keyed by id, and a change to one of them touches one of them.
 *
 * Written out rather than shared with the notes version even though the two are near-identical.
 * They are structurally alike by coincidence of both being trees, not by contract, and the one
 * place they genuinely differ is the root: a note outside every book is a legacy row the notes
 * flattener tolerates, while a diagram outside every folder is the **normal state** of a diagram
 * that was just made. Merging them would mean one function whose comments contradict each other
 * about its most important case.
 */

/** The rows as a forest, children resolved. Orphans — a row whose parent is missing — surface at
 *  the root rather than vanishing, which is the difference between a bug that hides data and one
 *  the user can see and fix. */
export function buildFolderTree(rows: DiagramFolderRow[]): DiagramFolder[] {
  const byId = new Map<string, DiagramFolder>();
  for (const row of rows) byId.set(row.id, { ...row, children: [] });

  const roots: DiagramFolder[] = [];
  for (const folder of byId.values()) {
    const parent = folder.parent_id ? byId.get(folder.parent_id) : undefined;
    if (parent) parent.children.push(folder);
    else roots.push(folder);
  }

  const sort = (list: DiagramFolder[]) => {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
    for (const folder of list) sort(folder.children);
  };
  sort(roots);
  return roots;
}

/** The key diagrams with no folder are grouped under. Not a folder id — none may collide with it. */
const ROOT = " root";

/**
 * The tree as the list of rows to draw, honouring which folders are open.
 *
 * **`expanded`, not `collapsed`** — a folder is closed unless it is in the set, for the reason the
 * notes flattener gives: thirty folders that all unfold on sight is a wall of titles with the
 * folders lost inside it.
 *
 * Diagrams come after subfolders within a folder — the arrangement every file tree uses.
 *
 * **Root-level diagrams are drawn last, at depth 0, and always.** They are not a leftover: a
 * diagram made from the gallery has no folder yet, and this is where the user finds it. A caller
 * that is *searching* passes every folder as expanded — see `DiagramExplorer` — because a match
 * hidden inside a shut folder is a search that lies about what it found.
 */
export function flattenTree(
  folders: DiagramFolder[],
  diagrams: Diagram[],
  expanded: ReadonlySet<string>,
): DiagramTreeRow[] {
  // Grouped once, rather than a `filter` per folder per render — one pass instead of one per folder.
  const byFolder = new Map<string, Diagram[]>();
  for (const diagram of diagrams) {
    const key = diagram.folder_id ?? ROOT;
    const list = byFolder.get(key);
    if (list) list.push(diagram);
    else byFolder.set(key, [diagram]);
  }

  const rows: DiagramTreeRow[] = [];

  const walk = (list: DiagramFolder[], depth: number) => {
    for (const folder of list) {
      rows.push({
        kind: "folder",
        id: folder.id,
        depth,
        folder,
        // The whole subtree's count, not just this folder's: a closed folder showing "0" while
        // holding forty diagrams in its children is the one number a closed row must not report.
        diagramCount: countWithin(folder, byFolder),
      });
      if (!expanded.has(folder.id)) continue;
      walk(folder.children, depth + 1);
      for (const diagram of byFolder.get(folder.id) ?? []) {
        rows.push({ kind: "diagram", id: diagram.id, depth: depth + 1, diagram });
      }
    }
  };
  walk(folders, 0);

  for (const diagram of byFolder.get(ROOT) ?? []) {
    rows.push({ kind: "diagram", id: diagram.id, depth: 0, diagram });
  }

  return rows;
}

function countWithin(folder: DiagramFolder, byFolder: Map<string, Diagram[]>): number {
  let total = byFolder.get(folder.id)?.length ?? 0;
  for (const child of folder.children) total += countWithin(child, byFolder);
  return total;
}

/** A folder's ancestors, outermost first, then itself — the breadcrumb over an open diagram. */
export function folderPath(
  folders: DiagramFolderRow[],
  folderId: string | null,
): DiagramFolderRow[] {
  if (!folderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: DiagramFolderRow[] = [];
  let current = byId.get(folderId);
  // Bounded by the row count: a cycle is impossible through the UI (`move_folder` refuses one) but
  // a hand-edited database is not the place to hang.
  for (let guard = 0; current && guard <= folders.length; guard++) {
    path.unshift(current);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return path;
}

/** A folder and everything under it. What "does this folder contain the drop target" is asked of,
 *  and what a delete confirmation counts. */
export function descendantIds(folders: DiagramFolderRow[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parent_id) continue;
    const list = children.get(folder.parent_id);
    if (list) list.push(folder.id);
    else children.set(folder.parent_id, [folder.id]);
  }
  const found = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const child of children.get(id) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * What each folder holds, its subfolders included: how many diagrams, and when the newest of them
 * was last touched. Keyed by folder id, every folder present.
 *
 * **It climbs from each diagram instead of descending from each folder.** The descending version is
 * `NoteGallery`'s `countWithin`, and its cost is a walk of the whole workspace *per card drawn* —
 * twice per card where it stands today, because the number and the sentence around it are two
 * separate calls. This walks the diagrams once each, up a chain as deep as the tree, and comes out
 * of a single `useMemo` that every card on screen then reads.
 *
 * **`latest` is compared as an instant, not as a string.** Sorting ISO text only agrees with time
 * while every row in the table was written in the same format and the same offset, which is a
 * property of the data nobody is enforcing; epoch milliseconds don't care. A timestamp that won't
 * parse is `NaN` and therefore never wins the comparison, so one corrupt row loses its own date
 * rather than capturing the folder's.
 *
 * **`walked` bounds the climb.** A cycle in `parent_id` cannot be made through the UI — `moveFolder`
 * refuses one, and Rust refuses it again — but a hand-edited database is not the place to hang, the
 * same guard and the same reasoning as `folderPath` above.
 *
 * **A diagram whose folder is gone counts for nobody.** `flattenTree` already surfaces that row at
 * the root rather than hiding it; adding it to some ancestor that isn't its own would be a worse
 * answer than not counting it, because a wrong number is harder to notice than a missing one.
 */
export interface FolderContents {
  count: number;
  /** The newest `updated_at` inside, or `""` when the folder holds no diagrams at all. */
  latest: string;
}

export function folderContents(
  folders: DiagramFolderRow[],
  diagrams: Diagram[],
): Map<string, FolderContents> {
  const parentOf = new Map<string, string | null>();
  for (const folder of folders) parentOf.set(folder.id, folder.parent_id);

  const totals = new Map<string, { count: number; latest: string; latestAt: number }>();
  for (const folder of folders) totals.set(folder.id, { count: 0, latest: "", latestAt: -Infinity });

  for (const diagram of diagrams) {
    if (!diagram.folder_id) continue;
    const at = Date.parse(diagram.updated_at);
    const walked = new Set<string>();
    let id: string | null = diagram.folder_id;
    while (id && !walked.has(id)) {
      walked.add(id);
      const total = totals.get(id);
      if (!total) break;
      total.count += 1;
      if (!Number.isNaN(at) && at > total.latestAt) {
        total.latestAt = at;
        total.latest = diagram.updated_at;
      }
      id = parentOf.get(id) ?? null;
    }
  }

  const out = new Map<string, FolderContents>();
  for (const [id, total] of totals) out.set(id, { count: total.count, latest: total.latest });
  return out;
}
