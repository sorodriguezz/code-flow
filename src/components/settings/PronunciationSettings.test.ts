import { describe, expect, it } from "vitest";
import { changedWords } from "./PronunciationSettings";

describe("changedWords", () => {
  it("marks only the words the voice is handed differently", () => {
    const words = changedWords("Abre CodeFlow, revisa el repository.", "Abre Cóud Flou, revisa el ripósitori.");
    expect(words.filter((w) => w.changed).map((w) => w.word)).toEqual(["Cóud", "Flou,", "ripósitori."]);
    expect(words.map((w) => w.word).join(" ")).toBe("Abre Cóud Flou, revisa el ripósitori.");
  });

  it("marks nothing when the sentence is read as written", () => {
    expect(changedWords("Hola, ¿cómo estás?", "Hola, ¿cómo estás?").some((w) => w.changed)).toBe(false);
  });
});
