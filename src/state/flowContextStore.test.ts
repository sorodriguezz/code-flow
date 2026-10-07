import { describe, expect, it } from "vitest";
import { globMatches, splitPatterns } from "./flowContextStore";

describe("the right-click entry's file pattern", () => {
  it("splits on the commas outside braces", () => {
    expect(splitPatterns("*.csv, report-*")).toEqual(["*.csv", "report-*"]);
    expect(splitPatterns("*.{ts,tsx}, *.md")).toEqual(["*.{ts,tsx}", "*.md"]);
    expect(splitPatterns(" , ")).toEqual([]);
  });

  it("matches a name, whatever folder the file is in", () => {
    expect(globMatches("*.csv", "data/ventas.CSV")).toBe(true);
    expect(globMatches("*.csv", "data/ventas.json")).toBe(false);
    expect(globMatches("**/*.ts", "src/lib/a.ts")).toBe(true);
    expect(globMatches("*.{ts,tsx}", "src/App.tsx")).toBe(true);
    expect(globMatches("*.{ts,tsx}", "src/App.js")).toBe(false);
    expect(globMatches("report-[0-9]*", "report-2026.pdf")).toBe(true);
    expect(globMatches("report-[!0-9]*", "report-2026.pdf")).toBe(false);
    expect(globMatches("?.txt", "a.txt")).toBe(true);
    expect(globMatches("a+b.txt", "a+b.txt")).toBe(true);
  });

  it("matches a pattern with a folder against the path", () => {
    expect(globMatches("src/**/*.ts", "src/lib/flows/spec.ts")).toBe(true);
    expect(globMatches("src/**/*.ts", "src/spec.ts")).toBe(true);
    expect(globMatches("src/*.ts", "src/lib/spec.ts")).toBe(false);
    expect(globMatches("docs/*", "src\\docs\\a.md")).toBe(false);
  });

  it("lets everything through without a pattern", () => {
    expect(globMatches("", "x.bin")).toBe(true);
  });
});
