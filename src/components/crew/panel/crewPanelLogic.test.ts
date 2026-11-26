import { describe, expect, it } from "vitest";
import type { Team, TeamMember } from "../../../types/team";
import { matchesQuery, teamLine } from "./crewPanelLogic";

const es = (text: string) => text;
const l = (spanish: string) => es(spanish);
const member = (id: string, name: string, patch: Partial<TeamMember> = {}) => ({ id, name, advisor: false, ...patch }) as TeamMember;
const team = (members: TeamMember[], lead = "") => ({ id: "t", name: "Plataforma", description: "", lead, members }) as Team;

describe("what narrows the panel's teams and agents", () => {
  it("takes every word, in any order, without case or accents", () => {
    expect(matchesQuery("", "Plataforma")).toBe(true);
    expect(matchesQuery("  ", "Plataforma")).toBe(true);
    expect(matchesQuery("revision api", "Equipo de API", "Revisión de contratos")).toBe(true);
    expect(matchesQuery("API pagos", "Equipo de API")).toBe(false);
    expect(matchesQuery("LIDER", "Líder técnico")).toBe(true);
  });
});

describe("a team's line in the panel", () => {
  it("counts who works in it and names who leads", () => {
    const squad = team([member("a", "Arquitecto"), member("b", "Backend"), member("c", "Asesora", { advisor: true })], "a");
    expect(teamLine(squad, l)).toBe("2 miembros · Lidera Arquitecto");
    expect(teamLine(team([member("a", "Arquitecto")], "a"), l)).toBe("1 miembro · Lidera Arquitecto");
  });

  it("says a team has a fixed flow when nobody leads, and that it is empty when it is", () => {
    expect(teamLine(team([member("a", "QA"), member("b", "Dev")]), l)).toBe("2 miembros · Flujo fijo, sin líder");
    expect(teamLine(team([]), l)).toBe("Sin miembros todavía");
  });
});
