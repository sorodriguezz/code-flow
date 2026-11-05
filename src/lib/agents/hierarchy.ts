/**
 * Who answers to whom inside a team — the same rules as `src-tauri/src/team/hierarchy.rs`, so the
 * org chart refuses a move before the backend has to. Plus the tidy-tree layout the chart draws.
 */
import type { TeamMember } from "../../types/team";

/** Lead → sub-lead → sub-sub-lead → member. */
export const MAX_DEPTH = 3;

type M = Pick<TeamMember, "id" | "reports_to" | "leads" | "advisor">;

/** The member `id` answers to; `null` for the lead and for every member of a team with no lead. */
export function manager(members: M[], lead: string, id: string): string | null {
  if (id === lead || !lead) return null;
  const member = members.find((m) => m.id === id);
  if (!member) return null;
  const boss = member.reports_to;
  if (boss && boss !== id && members.some((m) => m.id === boss)) return boss;
  return members.some((m) => m.id === lead) ? lead : null;
}

/** Everyone under `id`, at any depth, never `id` itself. */
export function subtree(members: M[], lead: string, id: string): string[] {
  const out: string[] = [];
  const frontier = [id];
  while (frontier.length) {
    const current = frontier.pop() as string;
    for (const m of members) {
      if (m.id !== current && m.id !== id && manager(members, lead, m.id) === current && !out.includes(m.id)) {
        out.push(m.id);
        frontier.push(m.id);
      }
    }
  }
  return out;
}

/** The managers above `id`, nearest first, ending at the lead. */
export function chainUp(members: M[], lead: string, id: string): string[] {
  const out: string[] = [];
  let current = id;
  for (;;) {
    const boss = manager(members, lead, current);
    if (!boss || boss === id || out.includes(boss)) break;
    out.push(boss);
    current = boss;
  }
  return out;
}

export function depth(members: M[], lead: string, id: string): number {
  return chainUp(members, lead, id).length;
}

/** The deepest level under `id`, counting `id` as 0. */
function height(members: M[], lead: string, id: string): number {
  let best = 0;
  for (const child of members.filter((m) => m.id !== id && manager(members, lead, m.id) === id)) best = Math.max(best, 1 + height(members, lead, child.id));
  return best;
}

export type MoveVerdict = { ok: true } | { ok: false; reason: "self" | "cycle" | "depth" | "advisor" | "lead" };

/** Whether `child` may report to `boss` (`""` or the lead: straight to the lead). */
export function canReport(members: M[], lead: string, child: string, boss: string): MoveVerdict {
  if (child === boss) return { ok: false, reason: "self" };
  if (child === lead) return { ok: false, reason: "lead" };
  const target = boss || lead;
  if (!target) return { ok: true };
  if (members.find((m) => m.id === target)?.advisor) return { ok: false, reason: "advisor" };
  if (subtree(members, lead, child).includes(target)) return { ok: false, reason: "cycle" };
  const depthAfter = (target === lead ? 0 : depth(members, lead, target)) + 1 + height(members, lead, child);
  if (depthAfter > MAX_DEPTH) return { ok: false, reason: "depth" };
  return { ok: true };
}

/** The member list with `child` moved under `boss`. Reporting to the lead is stored as `""`. */
export function reparent<T extends M>(members: T[], lead: string, child: string, boss: string): T[] {
  const target = boss === lead ? "" : boss;
  return members.map((m) => (m.id === child ? { ...m, reports_to: target } : m));
}

/** A member taken out: its reports move up to its own manager, and nobody keeps talking to it. */
export function removeMember<T extends M & { talks_to: string[]; escalate_to: string }>(members: T[], lead: string, id: string): T[] {
  const boss = manager(members, lead, id);
  const up = boss && boss !== lead ? boss : "";
  return members
    .filter((m) => m.id !== id)
    .map((m) => ({
      ...m,
      reports_to: m.reports_to === id ? up : m.reports_to,
      talks_to: m.talks_to.filter((t) => t !== id),
      escalate_to: m.escalate_to === id ? "" : m.escalate_to,
    }));
}

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  depth: number;
}

export interface OrgLayout {
  nodes: NodeBox[];
  edges: { from: string; to: string }[];
  /** A sub-lead's branch: the box around it and everyone under it. */
  frames: { id: string; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
}

/** Extra room each side of a framed branch, past the frame's own padding. */
const BRANCH_ROOM = 14;

/**
 * A tidy tree: each leaf takes one slot, a parent sits centred over its children, levels are rows.
 * The advisor sits beside the lead, outside the tree. A team with no lead (a fixed plan) is a row.
 */
export function layoutOrg(members: M[], lead: string, size: { w: number; h: number; gapX: number; gapY: number }): OrgLayout {
  const { w, h, gapX, gapY } = size;
  const nodes: NodeBox[] = [];
  const edges: { from: string; to: string }[] = [];
  const advisors = members.filter((m) => m.advisor && m.id !== lead);
  const inTree = members.filter((m) => !advisors.includes(m));
  const children = (id: string) => inTree.filter((m) => m.id !== id && manager(inTree, lead, m.id) === id);
  const roots = lead && inTree.some((m) => m.id === lead) ? inTree.filter((m) => m.id === lead) : inTree.filter((m) => !manager(inTree, lead, m.id));

  let cursor = 0;
  const place = (id: string, d: number, seen: Set<string>): { left: number; right: number } => {
    seen.add(id);
    const kids = children(id).filter((k) => !seen.has(k.id));
    let x: number;
    let left: number;
    let right: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += w + gapX;
      left = x;
      right = x + w;
    } else {
      // A sub-lead's branch is drawn in a frame: leave room on both sides so two frames never touch.
      const framed = id !== lead && !!inTree.find((m) => m.id === id)?.leads;
      if (framed) cursor += BRANCH_ROOM;
      const spans = kids.map((k) => {
        edges.push({ from: id, to: k.id });
        return place(k.id, d + 1, seen);
      });
      if (framed) cursor += BRANCH_ROOM;
      const first = nodes.find((n) => n.id === kids[0].id) as NodeBox;
      const last = nodes.find((n) => n.id === kids[kids.length - 1].id) as NodeBox;
      x = (first.x + last.x) / 2;
      left = Math.min(x, ...spans.map((s) => s.left));
      right = Math.max(x + w, ...spans.map((s) => s.right));
    }
    nodes.push({ id, x, y: d * (h + gapY), depth: d });
    return { left, right };
  };

  const seen = new Set<string>();
  for (const root of roots) place(root.id, 0, seen);
  // Anything a broken `reports_to` left out still gets drawn, as its own root.
  for (const m of inTree) if (!seen.has(m.id)) place(m.id, 0, seen);

  const leadNode = nodes.find((n) => n.id === lead);
  let ax = (leadNode?.x ?? 0) + w + gapX;
  for (const advisor of advisors) {
    const taken = () => nodes.some((n) => n.depth === 0 && Math.abs(n.x - ax) < w + gapX / 2);
    while (taken()) ax += w + gapX;
    nodes.push({ id: advisor.id, x: ax, y: 0, depth: 0 });
    ax += w + gapX;
  }

  const frames: OrgLayout["frames"] = [];
  const pad = 14;
  for (const m of inTree) {
    if (!m.leads || m.id === lead) continue;
    const ids = [m.id, ...subtree(inTree, lead, m.id)];
    if (ids.length < 2) continue;
    const boxes = nodes.filter((n) => ids.includes(n.id));
    const x0 = Math.min(...boxes.map((b) => b.x)) - pad;
    const y0 = Math.min(...boxes.map((b) => b.y)) - pad - 12;
    const x1 = Math.max(...boxes.map((b) => b.x + w)) + pad;
    // Room under the last row for the branch's name, written inside the frame.
    const y1 = Math.max(...boxes.map((b) => b.y + h)) + pad + 16;
    frames.push({ id: m.id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }

  const minX = Math.min(0, ...nodes.map((n) => n.x), ...frames.map((f) => f.x));
  const minY = Math.min(0, ...frames.map((f) => f.y));
  if (minX < 0 || minY < 0) {
    for (const n of nodes) {
      n.x -= minX;
      n.y -= minY;
    }
    for (const f of frames) {
      f.x -= minX;
      f.y -= minY;
    }
  }
  const width = Math.max(w, ...nodes.map((n) => n.x + w), ...frames.map((f) => f.x + f.w));
  const height = Math.max(h, ...nodes.map((n) => n.y + h), ...frames.map((f) => f.y + f.h));
  return { nodes, edges, frames, width, height };
}
