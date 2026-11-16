import { describe, expect, it } from "vitest";
import { ghostPrompt, ghostRemainder, ghostTidy, ghostWanted, ghostWord } from "./useComposerGhost";

describe("ghostWanted", () => {
  it("asks only with the caret at the end of the draft", () => {
    expect(ghostWanted("explica la función", 18, 18)).toBe(true);
    expect(ghostWanted("explica la función", 5, 5)).toBe(false);
    expect(ghostWanted("explica la función", 0, 18)).toBe(false);
  });

  it("needs something on the caret's line", () => {
    expect(ghostWanted("ex", 2, 2)).toBe(false);
    expect(ghostWanted("primera línea\n", 14, 14)).toBe(false);
    expect(ghostWanted("primera línea\nseg", 17, 17)).toBe(true);
  });

  it("leaves slash commands alone", () => {
    expect(ghostWanted("/compact algo", 13, 13)).toBe(false);
  });
});

describe("ghostRemainder", () => {
  const memo = { prefix: "refactoriza el ", text: "módulo de pagos" };

  it("serves what is left while typing along", () => {
    expect(ghostRemainder(memo, "refactoriza el ")).toBe("módulo de pagos");
    expect(ghostRemainder(memo, "refactoriza el mód")).toBe("ulo de pagos");
  });

  it("drops it on a divergence or once it is all typed", () => {
    expect(ghostRemainder(memo, "refactoriza el x")).toBeNull();
    expect(ghostRemainder(memo, "refactoriza el módulo de pagos")).toBeNull();
    expect(ghostRemainder(memo, "otra cosa")).toBeNull();
    expect(ghostRemainder(null, "refactoriza")).toBeNull();
  });
});

describe("ghostWord", () => {
  it("takes the next word with the space before it", () => {
    expect(ghostWord(" de pagos")).toBe(" de");
    expect(ghostWord("módulo de pagos")).toBe("módulo");
    expect(ghostWord("   ")).toBe("   ");
  });
});

describe("ghostPrompt", () => {
  it("ends in the draft, so the model continues it", () => {
    const prompt = ghostPrompt("por qué falla", { place: 'the repository "api"', lastAnswer: "El test usa `parseDate`." });
    expect(prompt.endsWith("User: por qué falla")).toBe(true);
    expect(prompt).toContain('the repository "api"');
    expect(prompt).toContain("Assistant: El test usa `parseDate`.");
  });

  it("keeps the end of a long answer and skips a missing one", () => {
    const long = "a".repeat(5000) + "FIN";
    expect(ghostPrompt("x", { place: "p", lastAnswer: long })).toContain("aFIN\n\nUser: x");
    expect(ghostPrompt("x", { place: "p", lastAnswer: null })).not.toContain("Assistant:");
  });
});

describe("ghostTidy", () => {
  it("cuts a suggestion where it starts looping", () => {
    const loop = " de la aplicación de agendamiento de pacientes de la aplicación de agendamiento de pacientes de la aplicación";
    expect(ghostTidy(loop, "se necesita un sistema")).toBe(" de la aplicación de agendamiento de pacientes");
  });

  it("offers nothing when the suggestion only repeats the end of the draft", () => {
    const draft = "un sistema de agendamiento de pacientes de la aplicación";
    expect(ghostTidy(" de agendamiento de pacientes de la aplicación", draft)).toBe("");
  });

  it("stops at the end of the first sentence", () => {
    expect(ghostTidy(" la rama main. Después revisa los tests", "compara con")).toBe(" la rama main.");
  });

  it("caps a long suggestion at a word boundary", () => {
    const long = " " + Array.from({ length: 60 }, (_, i) => `palabra${i}`).join(" ");
    const out = ghostTidy(long, "hola");
    expect(out.length).toBeLessThanOrEqual(160);
    expect(long.startsWith(out)).toBe(true);
    expect(out.endsWith(" ")).toBe(false);
  });

  it("leaves an ordinary suggestion alone", () => {
    expect(ghostTidy(" y dime qué archivos cambian", "explica el cambio")).toBe(" y dime qué archivos cambian");
  });
});
