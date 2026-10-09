import { describe, expect, it } from "vitest";
import { spliceDictation } from "./insert";

describe("spliceDictation", () => {
  it("joins words with one space on either side", () => {
    expect(spliceDictation("Revisa esto:", 12, 12, "hola")).toEqual({ value: "Revisa esto: hola", caret: 17 });
    expect(spliceDictation("antesdespués", 5, 5, "medio")).toEqual({ value: "antes medio después", caret: 11 });
  });

  it("adds nothing where there is already a space, or punctuation follows", () => {
    expect(spliceDictation("a ", 2, 2, "b")).toEqual({ value: "a b", caret: 3 });
    expect(spliceDictation("hola.", 4, 4, "mundo")).toEqual({ value: "hola mundo.", caret: 10 });
    expect(spliceDictation("", 0, 0, "solo")).toEqual({ value: "solo", caret: 4 });
  });

  it("replaces a selection", () => {
    expect(spliceDictation("uno dos tres", 4, 7, "DOS")).toEqual({ value: "uno DOS tres", caret: 7 });
  });
});
