import { describe, expect, it } from "vitest";
import { slotsOf, summarisedAtTheEnd } from "./CodiRoutines";

describe("a routine's blanks", () => {
  it("are the {words} its sentences name, once each, in order", () => {
    expect(slotsOf(["el tiempo", "el tiempo en {lugar}", "{lugar} y { tema }", "{lugar}"])).toEqual(["lugar", "tema"]);
  });
});

describe("the summary Codi adds at the end", () => {
  it("is owed when something is read after the last answer, and only then", () => {
    expect(summarisedAtTheEnd([{ kind: "search", query: "tiempo", pages: 2 }])).toBe(true);
    expect(summarisedAtTheEnd([{ kind: "search", query: "tiempo", pages: 2 }, { kind: "answer", instruction: "di el tiempo" }])).toBe(false);
    expect(summarisedAtTheEnd([{ kind: "open", target: "Safari" }, { kind: "say", text: "hola" }])).toBe(false);
    // A step left blank is skipped by the runner, so it reads nothing either.
    expect(summarisedAtTheEnd([{ kind: "answer", instruction: "x" }, { kind: "command", command: " ", cwd: "" }])).toBe(false);
  });
});
