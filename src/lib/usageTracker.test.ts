import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({ usageRecord: vi.fn(() => Promise.resolve()), usageSetContext: vi.fn(() => Promise.resolve()) }));

import { localDay, pendingUsageForTests, resetUsageTrackingForTests, trackUsage, viewKey } from "./usageTracker";

describe("usageTracker", () => {
  beforeEach(() => resetUsageTrackingForTests());

  it("adds increments to one counter per day, workspace, kind and key", () => {
    trackUsage("view", "graph", {}, "w1");
    trackUsage("view", "graph", { seconds: 12.4 }, "w1");
    trackUsage("view", "graph", {}, "w2");
    const rows = pendingUsageForTests();
    expect(rows).toHaveLength(2);
    const w1 = rows.find((row) => row.workspaceId === "w1")!;
    expect([w1.count, Math.round(w1.seconds), w1.day, w1.repo]).toEqual([1, 12, localDay(), ""]);
    expect(w1.hour).toBe(new Date().getHours());
  });

  it("keeps a repository apart from the rest of its workspace", () => {
    trackUsage("action", "api.send", {}, "w1", "p1");
    trackUsage("action", "api.send", {}, "w1");
    expect(pendingUsageForTests().map((row) => row.repo).sort()).toEqual(["", "p1"]);
  });

  it("drops empty keys and zero amounts", () => {
    trackUsage("feature", "", {}, "w");
    trackUsage("feature", "x", { count: 0 }, "w");
    expect(pendingUsageForTests()).toHaveLength(0);
  });

  it("tells the database app apart from the API client", () => {
    expect(viewKey("api", "database")).toBe("databases");
    expect(viewKey("api", "requests")).toBe("api");
    expect(viewKey("graph", "database")).toBe("graph");
  });
});
