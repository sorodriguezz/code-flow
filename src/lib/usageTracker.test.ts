import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({ usageRecord: vi.fn(() => Promise.resolve()), usageSetContext: vi.fn(() => Promise.resolve()) }));
vi.mock("../state/workspaceChatStore", () => ({ useWorkspaceChatStore: { getState: () => ({ byConversation: {} }) } }));

import { localDay, pendingUsageForTests, resetUsageTrackingForTests, startSatelliteUsageTracking, startUsageTracking, trackUsage, viewKey } from "./usageTracker";
import { invoke } from "./tauri/invoke";

describe("usageTracker", () => {
  beforeEach(() => resetUsageTrackingForTests());
  afterEach(() => vi.unstubAllGlobals());

  it.each(["main", "app"])("starts %s tracking with Tauri's read-only internals", (kind) => {
    const internals = Object.freeze({ invoke: vi.fn(() => Promise.resolve(null)) });
    const interval = vi.fn();
    const win = { __TAURI_INTERNALS__: internals, addEventListener: vi.fn(), setInterval: interval };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { visibilityState: "visible", hasFocus: () => true, addEventListener: vi.fn() });

    const start = () => kind === "main" ? startUsageTracking() : startSatelliteUsageTracking(kind);
    expect(start).not.toThrow();
    start();
    expect(interval).toHaveBeenCalledTimes(1);
    expect(win.__TAURI_INTERNALS__).toBe(internals);
  });

  it("still counts island commands once through the public API with frozen internals", async () => {
    const nativeInvoke = vi.fn(() => Promise.resolve(null));
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: Object.freeze({ invoke: nativeInvoke }),
      addEventListener: vi.fn(),
      setInterval: vi.fn(),
    });
    vi.stubGlobal("document", { addEventListener: vi.fn() });
    startSatelliteUsageTracking("app");
    startSatelliteUsageTracking("app");

    await invoke("db_connect", { connectionId: "connection" });
    expect(nativeInvoke).toHaveBeenCalledOnce();
    expect(pendingUsageForTests()).toContainEqual(expect.objectContaining({ kind: "action", key: "db.connect", count: 1 }));
  });

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
