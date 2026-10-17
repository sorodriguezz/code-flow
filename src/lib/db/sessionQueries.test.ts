import { describe, expect, it } from "vitest";
import { blockers, sessionDialect } from "./sessionQueries";

describe("sessionDialect", () => {
  it("writes each engine's own stop statements", () => {
    expect(sessionDialect("postgres")?.cancel?.("42")).toBe("SELECT pg_cancel_backend(42)");
    expect(sessionDialect("mysql")?.kill("7")).toBe("KILL 7");
    expect(sessionDialect("sqlserver")?.cancel).toBeUndefined();
    expect(sessionDialect("oracle")?.kill("12,345")).toBe("ALTER SYSTEM KILL SESSION '12,345' IMMEDIATE");
    expect(sessionDialect("sqlite")).toBeNull();
  });

  it("refuses an id that is not one — it goes into the statement", () => {
    expect(() => sessionDialect("postgres")?.kill("1; DROP TABLE x")).toThrow();
    expect(() => sessionDialect("oracle")?.kill("1'")).toThrow();
  });
});

describe("blockers", () => {
  it("finds who holds others up, by plain or Oracle ids", () => {
    expect(
      blockers([
        { id: "1", blockedBy: null },
        { id: "2", blockedBy: "1,3" },
        { id: "3", blockedBy: null },
      ]),
    ).toEqual(new Set(["1", "3"]));
    expect(
      blockers([
        { id: "10,5", blockedBy: null },
        { id: "11,9", blockedBy: "10" },
      ]),
    ).toEqual(new Set(["10,5"]));
  });
});
