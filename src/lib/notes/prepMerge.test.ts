import { describe, expect, it } from "vitest";
import { freshLines, mergePreparation, type PrepLabels, type PrepProposal } from "./prepMerge";
import { translations } from "../i18n/translations";
import { es } from "../i18n/translations.es";

// Spanish is loaded on demand in the app; here both are read straight from their files.
const texts = (lang: "es" | "en") => (lang === "es" ? es : translations.en) as Record<string, string>;

const labels = (lang: "es" | "en"): PrepLabels => {
  const say = (key: string) => texts(lang)[key] ?? "";
  return { known: say("notes.prep.known"), questions: say("notes.prep.questions"), decisions: say("notes.prep.decisions"), risks: say("notes.prep.risks"), sources: say("notes.prep.sources") };
};
const template = (lang: "es" | "en") => texts(lang)["notes.tpl.prep.body"];

const proposal: PrepProposal = {
  known: [{ text: "La tabla outbox ya está creada.", from: "Seguimiento del outbox" }],
  questions: [
    { text: "¿Quién aprueba el nombre del schema?", from: "Seguimiento del outbox" },
    { text: "¿Hay fecha para medir el crecimiento?", from: "" },
  ],
  decisions: [{ text: "Fijar el nombre del schema.", from: "Outbox [v2]" }],
  risks: [],
};
const sources = [
  { id: "a", title: "Seguimiento del outbox", date: "2026-11-17" },
  { id: "b", title: "Outbox [v2]", date: "2026-11-10" },
  { id: "c", title: "Bandeja del correo", date: "2026-11-12" },
];

describe("a proposed preparation going into its note", () => {
  it("has a heading in the template for every list, in both languages", () => {
    for (const lang of ["es", "en"] as const) {
      const own = labels(lang);
      for (const heading of [own.known, own.questions, own.decisions, own.risks]) expect(template(lang)).toContain(`## ${heading}\n`);
    }
  });

  it("fills the template's own empty lines and names where each line came from", () => {
    const merged = mergePreparation(template("es"), proposal, sources, labels("es"));
    expect(merged).toContain("## Lo que ya sé\n\n- La tabla outbox ya está creada. *(Seguimiento del outbox)*\n\n## Preguntas que quiero hacer");
    expect(merged).toContain("## Preguntas que quiero hacer\n\n- [ ] ¿Quién aprueba el nombre del schema? *(Seguimiento del outbox)*\n- [ ] ¿Hay fecha para medir el crecimiento?\n\n## Decisiones que necesito");
    // A list with nothing proposed keeps its empty line, and what the person is to write stays.
    expect(merged).toContain("## Riesgos y bloqueos que plantear\n\n- \n");
    expect(merged).toContain("## Objetivo\n\nQué tiene que quedar resuelto al salir.\n\n- \n");
    // Only the notes a line names are listed, before the closing rule; a title that cannot be a link is plain.
    expect(merged).toContain("## Notas y reuniones anteriores consultadas\n\n- [[Seguimiento del outbox]] · 2026-11-17\n- Outbox [v2] · 2026-11-10\n\n---\n");
    expect(merged).not.toContain("Bandeja del correo");
  });

  it("keeps what was written and does not say anything twice", () => {
    const written = template("es").replace("## Preguntas que quiero hacer\n\n- [ ] \n", "## Preguntas que quiero hacer\n\n- [ ] ¿Cuándo sale a producción?\n");
    const once = mergePreparation(written, proposal, sources, labels("es"));
    expect(once).toContain("- [ ] ¿Cuándo sale a producción?\n- [ ] ¿Quién aprueba el nombre del schema? *(Seguimiento del outbox)*\n- [ ] ¿Hay fecha para medir el crecimiento?\n\n## Decisiones");
    expect(freshLines(written, proposal)).toBe(4);
    expect(freshLines(once, proposal)).toBe(0);
    expect(mergePreparation(once, proposal, sources, labels("es"))).toBe(once);
  });

  it("adds the sections a note does not have", () => {
    const merged = mergePreparation("# Preparación — Outbox\n\nMis apuntes.", proposal, sources, labels("es"));
    expect(merged.startsWith("# Preparación — Outbox\n\nMis apuntes.\n\n## Lo que ya sé\n\n- La tabla outbox")).toBe(true);
    expect(merged).toContain("## Preguntas que quiero hacer\n\n- [ ] ¿Quién aprueba");
    expect(merged.trimEnd().endsWith("- Outbox [v2] · 2026-11-10")).toBe(true);
  });
});
