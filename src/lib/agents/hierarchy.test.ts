import { describe, expect, it } from "vitest";
import { canReport, chainUp, layoutOrg, manager, removeMember, reparent, subtree } from "./hierarchy";
import { emptyMember, type TeamMember } from "../../types/team";

function m(id: string, reports_to = "", extra: Partial<TeamMember> = {}): TeamMember {
  return { ...emptyMember(), id, name: id, agent_id: id, reports_to, ...extra };
}

// lead ← arch (sub-lead) ← be, fe ; lead ← qa ; advisor
const team = [m("lead"), m("arch", "", { leads: true }), m("be", "arch"), m("fe", "arch"), m("qa"), m("adv", "", { advisor: true })];

describe("hierarchy", () => {
  it("falls back to the lead, like the backend", () => {
    expect(manager(team, "lead", "qa")).toBe("lead");
    expect(manager(team, "lead", "be")).toBe("arch");
    expect(manager(team, "lead", "lead")).toBeNull();
    expect(manager(team, "", "qa")).toBeNull();
    expect(manager([...team, m("lost", "nobody")], "lead", "lost")).toBe("lead");
  });

  it("walks branches and chains", () => {
    expect(subtree(team, "lead", "arch").sort()).toEqual(["be", "fe"]);
    expect(chainUp(team, "lead", "fe")).toEqual(["arch", "lead"]);
  });

  it("refuses cycles, self, the lead, advisors and trees past three levels", () => {
    expect(canReport(team, "lead", "arch", "be")).toEqual({ ok: false, reason: "cycle" });
    expect(canReport(team, "lead", "be", "be")).toEqual({ ok: false, reason: "self" });
    expect(canReport(team, "lead", "lead", "qa")).toEqual({ ok: false, reason: "lead" });
    expect(canReport(team, "lead", "qa", "adv")).toEqual({ ok: false, reason: "advisor" });
    expect(canReport(team, "lead", "qa", "be")).toEqual({ ok: true });
    // qa under fe would be depth 3: fine. arch (with its branch) under qa would be 4.
    expect(canReport(team, "lead", "qa", "fe")).toEqual({ ok: true });
    const deeper = reparent(team, "lead", "qa", "fe");
    expect(canReport(deeper, "lead", "arch", "adv").ok).toBe(false);
    expect(canReport(team, "lead", "arch", "qa")).toEqual({ ok: true });
    expect(canReport(reparent(team, "lead", "qa", "be"), "lead", "arch", "qa")).toEqual({ ok: false, reason: "cycle" });
  });

  it("stores «reports to the lead» as empty", () => {
    expect(reparent(team, "lead", "be", "lead").find((x) => x.id === "be")?.reports_to).toBe("");
  });

  it("moves a removed member's reports up to its manager", () => {
    const after = removeMember(team, "lead", "arch");
    expect(after.find((x) => x.id === "be")?.reports_to).toBe("");
    const nested = removeMember(reparent(team, "lead", "qa", "be"), "lead", "be");
    expect(nested.find((x) => x.id === "qa")?.reports_to).toBe("arch");
  });

  it("lays the tree out with parents centred over children and the advisor beside the lead", () => {
    const out = layoutOrg(team, "lead", { w: 100, h: 50, gapX: 20, gapY: 40 });
    const at = (id: string) => out.nodes.find((n) => n.id === id)!;
    expect(at("lead").depth).toBe(0);
    expect(at("arch").depth).toBe(1);
    expect(at("be").depth).toBe(2);
    expect(at("arch").x).toBe((at("be").x + at("fe").x) / 2);
    expect(at("adv").y).toBe(at("lead").y);
    expect(at("adv").x).toBeGreaterThan(at("lead").x);
    expect(out.frames.map((f) => f.id)).toEqual(["arch"]);
    expect(out.edges).toContainEqual({ from: "arch", to: "be" });
    // Nothing overlaps on a row.
    for (const a of out.nodes) for (const b of out.nodes) if (a !== b && a.y === b.y) expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(100);
  });

  it("draws a team without a lead as one row", () => {
    const out = layoutOrg([m("a"), m("b")], "", { w: 100, h: 50, gapX: 20, gapY: 40 });
    expect(out.nodes.every((n) => n.depth === 0)).toBe(true);
    expect(out.edges).toEqual([]);
  });

  it.each([false, true])("leaves room around nested frames and a separate footer for each branch (reversed: %s)", (reversed) => {
    const members = [
      m("lead"),
      m("tech", "", { leads: true }),
      m("frontend", "tech", { leads: true }),
      m("dev", "frontend"),
    ];
    const size = { w: 184, h: 68, gapX: 26, gapY: 56 };
    const out = layoutOrg(reversed ? [...members].reverse() : members, "lead", size);
    const outer = out.frames.find((f) => f.id === "tech")!;
    const inner = out.frames.find((f) => f.id === "frontend")!;

    expect(inner.x - outer.x).toBeGreaterThanOrEqual(14);
    expect(outer.x + outer.w - (inner.x + inner.w)).toBeGreaterThanOrEqual(14);
    expect(inner.y - outer.y).toBeGreaterThanOrEqual(14);
    // Each footer has a 16px label, 6px below it and at least 8px above it.
    expect(outer.y + outer.h - (inner.y + inner.h)).toBeGreaterThanOrEqual(30);
    const dev = out.nodes.find((n) => n.id === "dev")!;
    expect(inner.y + inner.h - (dev.y + size.h)).toBeGreaterThanOrEqual(30);
    expect(out.frames.indexOf(outer)).toBeLessThan(out.frames.indexOf(inner));
    for (const f of out.frames) {
      expect(f.x).toBeGreaterThanOrEqual(0);
      expect(f.y).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w).toBeLessThanOrEqual(out.width);
      expect(f.y + f.h).toBeLessThanOrEqual(out.height);
    }
  });

  it("keeps sibling branches and other members clear of nested frames", () => {
    const members = [
      m("lead"),
      m("tech", "", { leads: true }),
      m("backend", "tech", { leads: true }),
      m("be1", "backend"),
      m("be2", "backend"),
      m("frontend", "tech", { leads: true }),
      m("fe1", "frontend"),
      m("fe2", "frontend"),
      m("dba", "tech"),
      m("qa", "", { leads: true }),
      m("tester", "qa"),
    ];
    const size = { w: 184, h: 68, gapX: 26, gapY: 56 };
    const out = layoutOrg(members, "lead", size);
    for (const frame of out.frames) {
      const branch = [frame.id, ...subtree(members, "lead", frame.id)];
      for (const node of out.nodes.filter((n) => !branch.includes(n.id))) {
        expect(
          node.x + size.w <= frame.x || node.x >= frame.x + frame.w ||
          node.y + size.h <= frame.y || node.y >= frame.y + frame.h,
        ).toBe(true);
      }
    }
    const byId = (id: string) => out.frames.find((f) => f.id === id)!;
    expect(byId("frontend").x - (byId("backend").x + byId("backend").w)).toBeGreaterThanOrEqual(size.gapX);
    expect(byId("qa").x - (byId("tech").x + byId("tech").w)).toBeGreaterThanOrEqual(size.gapX);
  });
});
