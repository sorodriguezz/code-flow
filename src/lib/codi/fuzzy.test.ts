import { describe, expect, it } from "vitest";
import { closestByName, foldName, matchByName } from "./fuzzy";

/**
 * A spoken name against the names the sidebar shows. The rule that matters most is the last one:
 * a name that fits two things is asked back, never guessed.
 */

const repos = ["api-pagos", "api-users", "web", "infra_terraform", "Tiénda"];
const match = (query: string, items = repos, prefer?: (name: string) => boolean) =>
  matchByName(items, query, (name) => name, prefer);

describe("foldName", () => {
  it("drops case, accents and every separator", () => {
    expect(foldName("Api_Pagos")).toBe("apipagos");
    expect(foldName("api pagos")).toBe("apipagos");
    expect(foldName("Tiénda")).toBe("tienda");
  });
});

describe("matchByName", () => {
  it("finds a repository however its separators were said", () => {
    expect(match("api pagos")).toEqual({ kind: "match", item: "api-pagos" });
    expect(match("API_PAGOS")).toEqual({ kind: "match", item: "api-pagos" });
    expect(match("infra terraform")).toEqual({ kind: "match", item: "infra_terraform" });
    expect(match("tienda")).toEqual({ kind: "match", item: "Tiénda" });
  });

  it("accepts the words in any order, and a word on its own", () => {
    expect(match("pagos api")).toEqual({ kind: "match", item: "api-pagos" });
    expect(match("terraform")).toEqual({ kind: "match", item: "infra_terraform" });
  });

  it("finds the name inside a longer phrase", () => {
    expect(match("the web repo")).toEqual({ kind: "match", item: "web" });
  });

  it("forgives a dropped letter in a long enough name", () => {
    expect(match("api pago")).toEqual({ kind: "match", item: "api-pagos" });
    expect(match("api-usres")).toEqual({ kind: "match", item: "api-users" });
  });

  it("asks back when a name fits more than one", () => {
    expect(match("api")).toEqual({ kind: "ambiguous", candidates: ["api-pagos", "api-users"] });
  });

  it("lets the preferred candidate break a tie, and only a tie", () => {
    const twoWebs = ["web", "web"];
    expect(matchByName(twoWebs, "web", (n) => n)).toMatchObject({ kind: "ambiguous" });
    const items = [
      { name: "web", here: false },
      { name: "web", here: true },
    ];
    expect(matchByName(items, "web", (i) => i.name, (i) => i.here)).toEqual({ kind: "match", item: items[1] });
    // An exact match is never beaten by a preferred partial one.
    expect(match("web", ["web", "website"], (name) => name === "website")).toEqual({ kind: "match", item: "web" });
  });

  it("says none rather than reaching for something unrelated", () => {
    expect(match("billing")).toEqual({ kind: "none" });
    expect(match("")).toEqual({ kind: "none" });
    // Two letters off a three-letter name is a different word, not a slip.
    expect(match("wiki", ["web"])).toEqual({ kind: "none" });
  });
});

describe("closestByName", () => {
  const repos = ["api-pagos", "api-usuarios", "web", "facturacion"];
  it("suggests the one name a slip most likely meant", () => {
    expect(closestByName(repos, "api pagoz extra", (n) => n)).toBe(null);
    expect(closestByName(repos, "facturasion", (n) => n)).toBe("facturacion");
    expect(closestByName(repos, "apipagas", (n) => n)).toBe("api-pagos");
  });
  it("suggests nothing when two are as near, or the query is too short", () => {
    expect(closestByName(["api-uno", "api-dos"], "api-tres", (n) => n)).toBe(null);
    expect(closestByName(repos, "we", (n) => n)).toBe(null);
  });
});
