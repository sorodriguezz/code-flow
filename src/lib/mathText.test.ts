import { describe, expect, it } from "vitest";
import { mayContainMath, splitMath } from "./mathText";

describe("splitMath", () => {
  it("finds an inline formula and the text around it", () => {
    expect(splitMath("the area is $\\pi r^2$ here")).toEqual([
      { kind: "text", value: "the area is " },
      { kind: "inline", value: "\\pi r^2" },
      { kind: "text", value: " here" },
    ]);
  });

  it("finds a displayed formula, across lines", () => {
    expect(splitMath("so:\n$$\nx = \\frac{a}{b}\n$$\ndone")).toEqual([
      { kind: "text", value: "so:\n" },
      { kind: "display", value: "x = \\frac{a}{b}" },
      { kind: "text", value: "\ndone" },
    ]);
  });

  it("leaves prices alone", () => {
    expect(splitMath("it costs $5 and then $10 more")).toEqual([{ kind: "text", value: "it costs $5 and then $10 more" }]);
    expect(splitMath("$ spaced $")).toEqual([{ kind: "text", value: "$ spaced $" }]);
  });

  it("an escaped dollar is a dollar, not the start of a formula", () => {
    expect(splitMath("pay \\$5 or \\$6")).toEqual([{ kind: "text", value: "pay $5 or $6" }]);
  });

  it("an unclosed or empty formula stays text", () => {
    expect(splitMath("only $$ here")).toEqual([{ kind: "text", value: "only $$ here" }]);
    expect(splitMath("$$$$")).toEqual([{ kind: "text", value: "$$$$" }]);
    expect(splitMath("lone $x")).toEqual([{ kind: "text", value: "lone $x" }]);
  });

  it("handles several formulas in a row", () => {
    const kinds = splitMath("$a$ and $b$ and $$c$$").map((s) => s.kind);
    expect(kinds).toEqual(["inline", "text", "inline", "text", "display"]);
  });

  it("knows what is not worth a pass", () => {
    expect(mayContainMath("no money here")).toBe(false);
    expect(mayContainMath("a $ sign")).toBe(true);
  });
});
