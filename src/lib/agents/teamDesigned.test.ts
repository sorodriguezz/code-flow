import { describe, expect, it } from "vitest";
import { teamDesignedMessage } from "./teamDesigned";
import { turnActivity } from "../turnActivity";
import { emptyTeam, emptyMember } from "../../types/team";
import type { RunStep } from "../runSteps";

const team = (seats: number) => ({ ...emptyTeam("w1"), name: "Tienda web", members: Array.from({ length: seats }, (_, i) => ({ ...emptyMember(), id: `m${i}` })) });

describe("a team a chat made", () => {
  it("is announced with what it cost the roster", () => {
    expect(teamDesignedMessage({ team: team(4), updated: false, newAgents: 3 }, true)).toBe("El chat creó el equipo «Tienda web»: 4 puestos, 3 agentes nuevos.");
    expect(teamDesignedMessage({ team: team(1), updated: false, newAgents: 1 }, true)).toBe("El chat creó el equipo «Tienda web»: 1 puesto, 1 agente nuevo.");
    expect(teamDesignedMessage({ team: team(2), updated: true, newAgents: 0 }, true)).toBe("El chat actualizó el equipo «Tienda web»: 2 puestos, con agentes que ya tenías.");
    expect(teamDesignedMessage({ team: team(2), updated: false, newAgents: 2 }, false)).toBe("The chat created the team «Tienda web»: 2 seats, 2 new agents.");
  });

  it("shows in the turn's activity as something done in the app", () => {
    const steps = [
      { kind: "tool", tool: "mcp__codeflow_map__team_brief", arg: "" },
      { kind: "tool", tool: "mcp__codeflow_map__team_create", arg: "Tienda web" },
    ] as unknown as RunStep[];
    const groups = turnActivity(steps);
    expect(groups.map((g) => [g.kind, g.count])).toEqual([["app", 2]]);
  });
});

import { teamProposedMessage } from "./teamDesigned";
import { flagText, policyFacts, seatDepth } from "./teamProposal";
import { defaultPolicy } from "../../types/team";
import type { TeamProposalSeat } from "../tauri/teamCommands";

describe("a team a chat could only propose", () => {
  const es = (a: string, _b: string) => a;
  const en = (_a: string, b: string) => b;
  const seat = (over: Partial<TeamProposalSeat>): TeamProposalSeat => ({
    name: "", role: "", agent: "", fresh: false, provider: "claude", model: "sonnet", edits: true, lead: false, handsOn: false, advisor: false, subLead: false, reviewer: false, reportsTo: "", repos: [], icon: "", color: "", ...over,
  });

  it("is announced as the user's to decide", () => {
    expect(teamProposedMessage({ id: "p", workspaceId: "w", name: "Tienda", seats: 3, newAgents: 2, updating: false }, true)).toBe("El chat propone el equipo «Tienda»: 3 puestos, 2 agentes nuevos. Tú decides si se crea.");
    expect(teamProposedMessage({ id: "p", workspaceId: "w", name: "Tienda", seats: 1, newAgents: 0, updating: true }, false)).toBe("The chat proposes changing the team «Tienda»: 1 seat, with agents you already have. You decide whether it is created.");
  });

  it("says each thing to keep in mind in the user's language, naming who it is about", () => {
    expect(flagText({ kind: "read_only_unenforced", who: "Revisor", what: "Grok" }, es)).toBe("«Revisor» no debe escribir, pero Grok no lo impide: solo se le pide.");
    expect(flagText({ kind: "model_unchecked", who: "Dev", what: "claude/x" }, en)).toContain("«Dev»'s model (claude/x) could not be checked");
    for (const kind of ["agent_off", "sublead_alone", "no_engine", "nobody_writes", "unmetered", "guarantees_block", "merge_unasked"] as const) {
      expect(flagText({ kind, who: "Quien", what: "Qué" }, es).length).toBeGreaterThan(20);
    }
  });

  it("draws the hierarchy: the lead and the advisor on top, a sub-lead's branch below it", () => {
    const seats = [
      seat({ name: "Líder", lead: true }),
      seat({ name: "Asesor", advisor: true }),
      seat({ name: "Back", subLead: true }),
      seat({ name: "API", reportsTo: "Back" }),
      seat({ name: "Front" }),
    ];
    expect(seats.map((s) => seatDepth(s, seats))).toEqual([0, 0, 1, 2, 1]);
  });

  it("sums up how the team runs in a handful of facts", () => {
    const policy = { ...defaultPolicy(), integrate: "pr" as const, sandbox: "checks" as const, single_pass: false, review: { ...defaultPolicy().review, enabled: true } };
    const facts = Object.fromEntries(policyFacts(policy, "Revisor", es).map((f) => [f.label, f.value]));
    expect(facts).toEqual({
      "El plan": "te pregunta",
      "Al integrar": "abre un pull request · te pregunta",
      Revisión: "Revisor lee cada cambio",
      "En paralelo": "hasta 3 tareas",
      Verificaciones: "aisladas en un contenedor",
      Ritmo: "itera hasta cerrar",
    });
  });
});
