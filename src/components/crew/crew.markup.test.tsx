import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultPolicy, emptyMember, type TeamItem, type TeamMember, type TeamRunState } from "../../types/team";

/**
 * The live run and the org chart, rendered on the server: what each must show of the state it is
 * handed. The stores serve their initial state here (no DOM, no seeding), which is all these need —
 * everything they draw comes in as props.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));

const { WorkGraph } = await import("./live/WorkGraph");
const { GateCard } = await import("./live/RunParts");
const { OrgCanvas } = await import("./teams/OrgCanvas");

function member(id: string, extra: Partial<TeamMember> = {}): TeamMember & { provider: string; model: string; effort: string; prompt: string } {
  return { ...emptyMember(), id, name: id, agent_id: `agent-${id}`, provider: "claude", model: "sonnet", effort: "", prompt: "", ...extra };
}

let n = 0;
function item(id: string, extra: Partial<TeamItem> = {}): TeamItem {
  n++;
  return {
    id, run_id: "r", key: id, member_id: "be", member_name: "be", project_id: "", kind: "work", title: `Title ${id}`, instruction: "", depends_on: [],
    status: "pending", approved: false, task_id: "", worktree_path: "", branch: "", commit_sha: "", merged: false, output_text: "", attempts: 0,
    last_error: "", feedback: "", round: 0, lap: 0, ref_item: "", run_in: "headless", terminal_session: "", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}`,
    updated_at: "", started_at: "", finished_at: "", parent: "", model: "", ...extra,
  };
}

function run(items: TeamItem[], patch: Partial<TeamRunState["run"]> = {}): TeamRunState {
  return {
    run: {
      id: "r", workspace_id: "w", team_id: "t", team_name: "Squad", title: "Login", goal: "Fix login", status: "running", gate: "", gate_note: "", lead: "lead",
      lead_rounds_used: 0, lead_done: false, dispatches: 1, last_reason: "", agent_project_id: "", pinned: false, created_at: "", updated_at: "", policy: defaultPolicy(),
      members: [member("lead"), member("be"), member("fe")], ...patch,
    },
    repos: [],
    items,
    messages: [],
  };
}

describe("the live work graph", () => {
  it("draws every item and counts what runs side by side", () => {
    const html = renderToStaticMarkup(
      <WorkGraph
        state={run([item("plan", { kind: "plan", member_id: "lead", status: "done" }), item("a", { status: "running", started_at: "1" }), item("b", { status: "running", started_at: "2", member_id: "fe", member_name: "fe" })])}
        selected={null}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("Title a");
    expect(html).toContain("Title b");
    expect(html).toMatch(/2 (en paralelo|in parallel)/);
    // Work in flight is drawn by the travelling border, never by turning the element.
    expect(html).toContain("cf-crew-working");
    expect(html).not.toMatch(/rotate\(/);
  });
});

describe("the gate", () => {
  it("lists the plan it asks you to approve", () => {
    const html = renderToStaticMarkup(<GateCard state={run([item("plan", { kind: "plan", status: "done", member_id: "lead" }), item("x", { title: "Write the endpoint" })], { status: "gated", gate: "plan", gate_note: "Two steps." })} />);
    expect(html).toContain("Write the endpoint");
    expect(html).toContain("Two steps.");
    expect(html).toMatch(/Aprobar el plan|Approve the plan/);
  });
});

describe("the org chart", () => {
  it("frames a sub-lead's branch and marks the lead and the advisor", () => {
    const team = {
      id: "t", workspace_id: "w", name: "Squad", description: "", lead: "lead", policy: defaultPolicy(), plan: [], created_at: "", updated_at: "",
      members: [member("lead"), member("arch", { leads: true }), member("be", { reports_to: "arch" }), member("adv", { advisor: true })],
    };
    const html = renderToStaticMarkup(<OrgCanvas team={team} update={() => {}} selected={null} onSelect={() => {}} />);
    expect(html).toMatch(/Rama de arch|arch&#x27;s branch|arch's branch/);
    expect(html).toMatch(/title="(Líder|Lead)"/);
    expect(html).toMatch(/title="(Asesor|Advisor)"/);
    expect(html).toMatch(/title="(Sub-líder: planifica su rama|Sub-lead: plans its branch)"/);
  });
});
