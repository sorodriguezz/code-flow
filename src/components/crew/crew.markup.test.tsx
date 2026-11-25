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
const { DoneChecklist } = await import("./live/DoneChecklist");
const { itemLook, isWorking } = await import("./live/look");
const { OrgCanvas } = await import("./teams/OrgCanvas");
const { memberGaps } = await import("./teams/SafetyPanel");

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

describe("where a running item really is", () => {
  it("tells a queued turn and a verification apart from an agent at work", () => {
    const queued = item("q", { status: "running", intelligence: { paths: [], criteria: [], evidence: [], recovery: null, substitute: null, phase: "queued" } });
    const verifying = item("v", { status: "running", intelligence: { paths: [], criteria: [], evidence: [], recovery: null, substitute: null, phase: "verifying" } });
    const working = item("w", { status: "running" });
    expect(itemLook(queued)[0]).toBe("En cola");
    expect(itemLook(verifying)[0]).toBe("Verificando");
    expect(itemLook(working)[0]).toBe("Trabajando");
    expect([queued, verifying, working].map(isWorking)).toEqual([false, false, true]);
  });

  it("lets the user decide a dependency that is in no plan", () => {
    const html = renderToStaticMarkup(<GateCard state={run([item("front", { title: "Front" })], { status: "gated", gate: "deps:front", gate_note: "«Front» depende de «contrato-api», que no existe en el plan." })} />);
    expect(html).toMatch(/Depende de una tarea que no existe|depends on a task that does not exist/);
    expect(html).toMatch(/Seguir sin esa dependencia|Go on without that dependency/);
    expect(html).toMatch(/Omitir la tarea|Skip the task/);
  });
});

describe("the definition of done", () => {
  const work = item("w", {
    status: "done", commit_sha: "abc1234def", merged: true,
    intelligence: {
      paths: [], recovery: null, substitute: null,
      criteria: ["El timeout es 60 s", "No rompe el login"],
      evidence: [
        { label: "El timeout es 60 s", result: "reported", detail: "config.ts:12", source: "agent" },
        { label: "No rompe el login", result: "unverified", detail: "", source: "agent" },
        { label: "pnpm test", result: "passed", detail: "42 passed", source: "check", sha: "abc1234def" },
      ],
    },
  });

  it("tells what the agent declared from what the app checked, and what has no evidence", () => {
    const html = renderToStaticMarkup(<DoneChecklist state={run([work])} item={work} />);
    expect(html).toMatch(/Lo declara el agente|Declared by the agent/);
    expect(html).toMatch(/Sin evidencia|No evidence/);
    expect(html).toMatch(/Lo comprobó CodeFlow · abc1234|Checked by CodeFlow · abc1234/);
    expect(html).toMatch(/Integrado|Merged/);
    // Four of the five rows hold: the criterion nobody showed evidence for does not.
    expect(html).toMatch(/4 de 5|4 of 5/);
  });

  it("flags work that changed nothing and did not say why", () => {
    const silent = item("s", { status: "done", intelligence: { paths: [], criteria: [], evidence: [], recovery: null, substitute: null, no_change: "undeclared" } });
    const html = renderToStaticMarkup(<DoneChecklist state={run([silent])} item={silent} />);
    expect(html).toMatch(/No cambió ningún archivo|It changed no file/);
    expect(html).toMatch(/No dijo por qué|It did not say why/);
  });

  it("draws nothing for an item with nothing to show", () => {
    const plan = item("p", { kind: "plan", status: "done" });
    expect(renderToStaticMarkup(<DoneChecklist state={run([plan])} item={plan} />)).toBe("");
  });
});

describe("checks that run isolated", () => {
  it("asks how to go on when there is no container to run them in, the safe way first", () => {
    const held = item("h", { status: "gated", intelligence: { paths: [], criteria: [], evidence: [], recovery: null, substitute: null, sandbox_hold: "Docker no responde." } });
    const html = renderToStaticMarkup(<GateCard state={run([held], { status: "gated", gate: "sandbox:h", gate_note: "Docker no responde." })} />);
    expect(html).toMatch(/No se pudo verificar con aislamiento|The checks could not run isolated/);
    expect(html).toMatch(/Reintentar aislado|Try again, isolated/);
    expect(html).toMatch(/Verificar en este equipo|Check on this computer/);
    expect(html).toMatch(/Nada se ha ejecutado todavía|Nothing has run yet/);
    // Two ways to go on: nothing to comment.
    expect(html).not.toMatch(/Comentario \(opcional\)|Comment \(optional\)/);
  });

  it("says which image a check ran in", () => {
    const done = item("d", {
      status: "done", commit_sha: "abc1234def",
      intelligence: { paths: [], criteria: [], recovery: null, substitute: null, evidence: [{ label: "npm test", result: "passed", detail: "", source: "check", sha: "abc1234def", sandbox: "node:22-bookworm-slim" }] },
    });
    const html = renderToStaticMarkup(<DoneChecklist state={run([done])} item={done} />);
    expect(html).toMatch(/(aislado en|isolated in) node:22-bookworm-slim · abc1234/);
  });
});

describe("what a provider can be held to", () => {
  const caps = (readOnly: boolean, metered: boolean) => ({ id: "x", label: "X", inProcess: false, appScripts: "full" as const, appScriptsDefault: true, acp: false, guarantees: { readOnly, metered, loopGuard: false, resumes: true } });

  it("flags a member that must not write on a provider that only asks, and spend nobody reads", () => {
    expect(memberGaps(caps(true, true), false, false)).toEqual([]);
    expect(memberGaps(caps(false, true), false, false)).toEqual(["read_only"]);
    // A member that is there to write has nothing to enforce.
    expect(memberGaps(caps(false, true), true, false)).toEqual([]);
    expect(memberGaps(caps(true, false), true, false)).toEqual(["meter"]);
    // A minutes cap on the run bounds an engine that publishes nothing.
    expect(memberGaps(caps(true, false), true, true)).toEqual([]);
    expect(memberGaps(undefined, false, false)).toEqual([]);
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
