import { describe, expect, it } from "vitest";
import { clearRemoteProgress, progressLabel, reduceRemoteProgress, remoteProgressOf } from "./remoteProgress";

const ev = (repoPath: string, phase: string | null, percent: number | null, line = "x") => ({
  repoPath,
  operation: "fetch",
  line,
  phase,
  percent,
});

describe("remote progress", () => {
  it("keys by repository so another repo's progress is never read", () => {
    let m = reduceRemoteProgress({}, ev("/a", "Receiving objects", 45));
    m = reduceRemoteProgress(m, ev("/b", "Resolving deltas", 10));
    expect(remoteProgressOf(m, "/a")?.percent).toBe(45);
    expect(remoteProgressOf(m, "/b")?.phase).toBe("Resolving deltas");
    expect(remoteProgressOf(m, "/c")).toBeNull();
    expect(remoteProgressOf(m, null)).toBeNull();
  });

  it("keeps the last meter across a plain text line", () => {
    let m = reduceRemoteProgress({}, ev("/a", "Receiving objects", 45));
    m = reduceRemoteProgress(m, ev("/a", null, null, "remote: hello"));
    expect(m["/a"]).toMatchObject({ phase: "Receiving objects", percent: 45, line: "remote: hello" });
  });

  it("clears one repository only", () => {
    const m = reduceRemoteProgress(reduceRemoteProgress({}, ev("/a", "p", 1)), ev("/b", "p", 2));
    const cleared = clearRemoteProgress(m, "/a");
    expect(Object.keys(cleared)).toEqual(["/b"]);
    expect(clearRemoteProgress(cleared, "/zzz")).toBe(cleared);
  });

  it("labels phase and percent", () => {
    const m = reduceRemoteProgress({}, ev("/a", "Receiving objects", 44.6));
    expect(progressLabel(m["/a"], (k) => k)).toBe("git.phaseReceiving 45 %");
    expect(progressLabel(reduceRemoteProgress({}, ev("/a", "Odd phase", null))["/a"], (k) => k)).toBe("Odd phase");
    expect(progressLabel(null, (k) => k)).toBe("");
  });
});
