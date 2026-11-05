import { describe, expect, it } from "vitest";
import { readableTeamText } from "./teamText";

describe("readableTeamText", () => {
  it("turns the lead's equipo block into the plan it describes", () => {
    const text = 'Es un ajuste puntual.\n\n```equipo\n{"mensaje":"Mover el navbar","items":[{"id":"a","miembro":"Dev backend","titulo":"Colocar el navbar","tarea":"Muévelo arriba.","depende_de":[]}],"chico":true,"terminar":false}\n```';
    const out = readableTeamText(text);
    expect(out).not.toContain("```");
    expect(out).toContain("Mover el navbar");
    expect(out).toContain("1. **Dev backend** — Colocar el navbar");
    expect(out).toContain("Muévelo arriba.");
    expect(out).toContain("_tarea chica_");
  });

  it("leaves a block it cannot parse as it was", () => {
    const text = "```equipo\n{not json\n```";
    expect(readableTeamText(text)).toBe(text);
  });
});
