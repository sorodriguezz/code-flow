import { describe, expect, it } from "vitest";
import { builtinLibrary, draftFromTemplate, templateSyncPlan, type AgentTemplateBody, type TeamTemplateBody } from "./builtinTemplates";
import { AGENT_ICONS } from "./agentIcons";
import { AGENT_COLORS } from "./agentColors";

describe("built-in templates", () => {
  const lib = builtinLibrary("es");

  it("are well formed: known icon and colour, teams point at real slots and templates", () => {
    const icons = new Set(AGENT_ICONS.map((i) => i.id));
    for (const item of lib.filter((x) => x.kind === "agent")) {
      expect(icons.has(item.icon), item.id).toBe(true);
      expect((AGENT_COLORS as readonly string[]).includes(item.color), item.id).toBe(true);
      expect((item.body as AgentTemplateBody).model, item.id).toBeTruthy();
    }
    const agentIds = new Set(lib.filter((x) => x.kind === "agent").map((x) => x.id.replace("builtin:", "")));
    for (const team of lib.filter((x) => x.kind === "team")) {
      const body = team.body as TeamTemplateBody;
      const slots = new Set(body.slots.map((s) => s.slot));
      expect(slots.has(body.lead_slot), team.id).toBe(true);
      for (const slot of body.slots) {
        expect(agentIds.has(slot.agent_template), `${team.id}/${slot.slot}`).toBe(true);
        if (slot.reports_to) expect(slots.has(slot.reports_to), `${team.id}/${slot.slot}`).toBe(true);
      }
    }
  });

  it("are in both languages", () => {
    const en = builtinLibrary("en");
    expect(en.length).toBe(lib.length);
    expect(en.find((x) => x.id === "builtin:advisor")?.name).toBe("Advisor");
    expect(lib.find((x) => x.id === "builtin:advisor")?.name).toBe("Asesor");
  });

  it("number a new agent's name when it is taken, and sync respects overrides", () => {
    const qa = lib.find((x) => x.id === "builtin:qa")!;
    const draft = draftFromTemplate(qa, "ws", ["QA"]);
    expect(draft.name).toBe("QA 2");
    expect(draft.template_id).toBe("builtin:qa");
    expect(templateSyncPlan(draft, qa)).toEqual([]);
    const edited = { ...draft, model: "claude-opus-5-5", overrides: ["model"] };
    const plan = templateSyncPlan(edited, qa);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ field: "model", overridden: true });
  });
});
