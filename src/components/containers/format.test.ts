import { describe, expect, it } from "vitest";
import { fmtBytes, fmtPercent, statusSince } from "./format";

describe("how long a container has been as it is", () => {
  it("reads the engine's status line, not the creation date", () => {
    expect(statusSince("Up 3 hours", "es")).toEqual({ since: "3 h", failedCode: null });
    expect(statusSince("Up 40 minutes (healthy)", "es").since).toBe("40 min");
    expect(statusSince("Up About an hour", "en").since).toBe("1h");
    expect(statusSince("Up Less than a second", "es").since).toBe("<1 s");
    expect(statusSince("Exited (0) 2 hours ago", "es")).toEqual({ since: "hace 2 h", failedCode: null });
    expect(statusSince("Exited (137) 5 days ago", "en")).toEqual({ since: "5d ago", failedCode: 137 });
    expect(statusSince("Created", "es")).toEqual({ since: "", failedCode: null });
  });

  it("formats sizes and percentages the way Docker prints them", () => {
    expect(fmtBytes(182_000_000)).toBe("182 MB");
    expect(fmtBytes(8_300_000)).toBe("8.3 MB");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(null)).toBe("—");
    expect(fmtPercent(12.44)).toBe("12.4%");
    expect(fmtPercent(250)).toBe("250%");
  });
});

describe("why a container stopped", () => {
  it("reads the exit code", async () => {
    const { stopReason, hasFailed, fmtDuration } = await import("./format");
    expect(stopReason("running", null)).toBeNull();
    expect(stopReason("exited", 0)).toBe("stopped");
    expect(stopReason("exited", 143)).toBe("stopped");
    expect(stopReason("exited", 137)).toBe("killed");
    expect(stopReason("exited", 139)).toBe("crashed");
    expect(stopReason("exited", 1)).toBe("failed");
    expect(stopReason("dead", null)).toBe("failed");
    expect(hasFailed({ state: "exited", health: "", exitCode: 0 })).toBe(false);
    expect(hasFailed({ state: "exited", health: "", exitCode: 2 })).toBe(true);
    expect(hasFailed({ state: "running", health: "unhealthy", exitCode: null })).toBe(true);
    expect(fmtDuration(0.4)).toBe("0.4s");
    expect(fmtDuration(22.3)).toBe("22s");
    expect(fmtDuration(72)).toBe("1m 12s");
  });
});
