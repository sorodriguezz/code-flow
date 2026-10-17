import { describe, expect, it } from "vitest";
import { commitFilterActive, dayToSeconds, logFilterOf, NO_COMMIT_FILTER, narrowingCount } from "./commitFilter";

describe("commit filter", () => {
  it("sends nothing for the whole history", () => {
    expect(logFilterOf(NO_COMMIT_FILTER)).toBeNull();
    expect(logFilterOf({ ...NO_COMMIT_FILTER, scope: "current" })).toBeNull();
    expect(commitFilterActive(NO_COMMIT_FILTER)).toBe(false);
    expect(commitFilterActive({ ...NO_COMMIT_FILTER, scope: "current" })).toBe(true);
  });

  it("normalises the path and spans whole days", () => {
    const sent = logFilterOf({ ...NO_COMMIT_FILTER, path: "./src\\lib/", since: "2026-01-02", until: "2026-01-02" });
    expect(sent?.path).toBe("src/lib");
    expect((sent?.until ?? 0) - (sent?.since ?? 0)).toBe(86399);
    expect(logFilterOf({ ...NO_COMMIT_FILTER, scope: "firstParent" })?.first_parent).toBe(true);
    expect(dayToSeconds("ayer")).toBeNull();
  });

  it("counts the narrowing filters, dates as one", () => {
    expect(narrowingCount({ ...NO_COMMIT_FILTER, author: "ana", since: "2026-01-01", until: "2026-02-01" })).toBe(2);
  });
});
