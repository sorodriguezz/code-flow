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

export const LANE_COLORS = [
  "#6366f1", // indigo
  "#22c55e", // green
  "#f59e0b", // amber
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#a855f7", // purple
  "#ef4444", // red
  "#14b8a6", // teal
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
