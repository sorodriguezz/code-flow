import { describe, expect, it } from "vitest";
import { formatElapsed, nodeTime } from "./runFormat";

describe("node times", () => {
  const at = Date.parse("2026-10-06T10:00:00Z");
  const row = (status: "running" | "success" | "error" | "skipped", durationMs: number | null) => ({
    status,
    startedAt: "2026-10-06T09:59:47.400Z",
    durationMs,
  });

  it("ticks in whole seconds while a node runs", () => {
    expect(formatElapsed(400)).toBe("0 s");
    expect(formatElapsed(12_600)).toBe("12 s");
    expect(formatElapsed(65_000)).toBe("1 min 5 s");
    expect(nodeTime(row("running", null), at)).toBe("12 s");
  });

  it("keeps what a node took once it ran, and nothing for one that did not", () => {
    expect(nodeTime(row("success", 850), at)).toBe("850 ms");
    expect(nodeTime(row("error", 14_200), at)).toBe("14 s");
    expect(nodeTime(row("skipped", null), at)).toBe("");
    expect(nodeTime({ status: "running", startedAt: null, durationMs: null }, at)).toBe("");
  });
});
