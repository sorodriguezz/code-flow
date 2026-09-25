import type { CommitInfo } from "../types/domain";

export interface GraphRow {
  commit: CommitInfo;
  row: number;
  lane: number;
}

export interface GraphEdge {
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  edges: GraphEdge[];
  laneCount: number;
}

/**
 * The lane palette.
 *
 * **Lane 0 follows the accent.** It is the first-parent line of whatever sits on top of the history
 * — almost always the branch being worked on — so the line you are standing on wears the app's own
 * colour, and changes with it when the accent does. A CSS variable rather than a hex, which the SVG
 * strokes resolve at paint time. (The ref chips no longer wear their lane: they are coloured by kind
 * — see `REF_HUE` in `GraphView`.)
 *
 * **The rest avoid red and green.** Everywhere else in this app those two already mean state — an
 * added line, a deleted file, a failed job — and a lane that happened to come out green read as
 * "this branch is fine", one that came out red as "this one is broken". What is left is the
 * mid-lightness band that reads on both themes: teal, amber, pink, sky, violet.
 */
export const LANE_COLORS = [
  "var(--cf-accent)",
  "#14b8a6", // teal
  "#f59e0b", // amber
  "#ec4899", // pink
  "#38bdf8", // sky
  "#a78bfa", // violet
];

/**
 * Assigns each commit a lane so the graph can be drawn like `git log --graph --all`.
 * Expects commits pre-ordered topologically + chronologically (children before parents),
 * which is what the backend's `list_commits` returns.
 */
export function computeGraphLayout(commits: CommitInfo[]): GraphLayout {
  const indexById = new Map<string, number>();
  commits.forEach((c, i) => indexById.set(c.id, i));

  const activeLanes: (string | null)[] = [];
  const rows: GraphRow[] = new Array(commits.length);

  const findFreeLane = (): number => {
    const free = activeLanes.findIndex((slot) => slot === null);
    if (free !== -1) return free;
    activeLanes.push(null);
    return activeLanes.length - 1;
  };

  commits.forEach((commit, row) => {
    let lane = activeLanes.findIndex((slot) => slot === commit.id);
    if (lane === -1) {
      lane = findFreeLane();
    }
    activeLanes[lane] = null;

    commit.parent_ids.forEach((parentId, parentIdx) => {
      if (parentIdx === 0) {
        activeLanes[lane] = parentId;
        return;
      }
      const alreadyTracked = activeLanes.some((slot) => slot === parentId);
      if (!alreadyTracked) {
        const mergeLane = findFreeLane();
        activeLanes[mergeLane] = parentId;
      }
    });

    rows[row] = { commit, row, lane };
  });

  const edges: GraphEdge[] = [];
  rows.forEach(({ commit, row, lane }) => {
    commit.parent_ids.forEach((parentId) => {
      const parentRow = indexById.get(parentId);
      if (parentRow === undefined) return; // parent outside the loaded window
      edges.push({
        fromRow: row,
        fromLane: lane,
        toRow: parentRow,
        toLane: rows[parentRow].lane,
      });
    });
  });

  const laneCount = rows.reduce((max, r) => Math.max(max, r.lane + 1), 1);

  return { rows, edges, laneCount };
}

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}
