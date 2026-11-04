/**
 * A team run's work as a graph that grows left to right as the lead plans: each item sits one
 * column past whatever it waits on, items of the same column stack by member, and the lead's later
 * rounds come after the work they read. Pure, so the live view and its tests agree.
 */
import type { TeamItem } from "../../types/team";

export type RunEdgeKind = "dep" | "plan" | "ref" | "delegate";

export interface RunGraph {
  pos: Map<string, { col: number; row: number }>;
  edges: { from: string; to: string; kind: RunEdgeKind }[];
  cols: number;
  rows: number;
}

const LEAD_KINDS = new Set(["plan", "final", "answer"]);

export function isLeadItem(item: Pick<TeamItem, "kind">): boolean {
  return LEAD_KINDS.has(item.kind);
}

export function layoutRun(items: TeamItem[]): RunGraph {
  const byId = new Map(items.map((i) => [i.id, i]));
  const ordered = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key));
  const planOfRound = new Map<number, TeamItem>();
  for (const i of ordered) if (i.kind === "plan" && !planOfRound.has(i.round)) planOfRound.set(i.round, i);

  const edges: RunGraph["edges"] = [];
  const parents = new Map<string, string[]>();
  const add = (from: string, to: string, kind: RunEdgeKind) => {
    if (from === to || !byId.has(from)) return;
    const list = parents.get(to) ?? [];
    if (list.includes(from)) return;
    list.push(from);
    parents.set(to, list);
    edges.push({ from, to, kind });
  };

  for (const item of ordered) {
    for (const dep of item.depends_on) add(dep, item.id, "dep");
    if (item.ref_item) add(item.ref_item, item.id, "ref");
    if (item.parent) add(item.parent, item.id, "delegate");
    if (isLeadItem(item)) {
      // A later round reads what came before it: draw from the earlier work nobody else waited on.
      const at = ordered.indexOf(item);
      const before = ordered.slice(0, at).filter((o) => !(o.kind === "plan" && o.round === item.round && item.kind === "plan"));
      const leaves = before.filter((o) => !before.some((x) => (parents.get(x.id) ?? []).includes(o.id)));
      for (const leaf of leaves) add(leaf.id, item.id, "plan");
    } else if (!parents.has(item.id)) {
      const plan = planOfRound.get(item.round) ?? [...planOfRound.values()].filter((p) => p.created_at <= item.created_at).pop();
      if (plan) add(plan.id, item.id, "plan");
    }
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const of = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const ps = parents.get(id) ?? [];
    const d = ps.length ? Math.max(...ps.map(of)) + 1 : 0;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const i of ordered) of(i.id);

  const columns = new Map<number, TeamItem[]>();
  for (const i of ordered) {
    const d = depth.get(i.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(i);
    columns.set(d, col);
  }
  const pos = new Map<string, { col: number; row: number }>();
  let rows = 1;
  for (const [col, list] of columns) {
    list.sort((a, b) => a.member_name.localeCompare(b.member_name) || a.created_at.localeCompare(b.created_at) || a.key.localeCompare(b.key));
    list.forEach((item, row) => pos.set(item.id, { col, row }));
    rows = Math.max(rows, list.length);
  }
  return { pos, edges, cols: Math.max(1, columns.size ? Math.max(...columns.keys()) + 1 : 1), rows };
}

/** How many items are in flight at once right now, and the most there have been in this run. */
export function parallelism(items: TeamItem[]): { now: number; peak: number } {
  const now = items.filter((i) => i.status === "running" && !isLeadItem(i)).length;
  const events: [string, number][] = [];
  for (const i of items) {
    if (isLeadItem(i) || !i.started_at) continue;
    events.push([i.started_at, 1]);
    if (i.finished_at) events.push([i.finished_at, -1]);
  }
  events.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return { now, peak: Math.max(peak, now) };
}
