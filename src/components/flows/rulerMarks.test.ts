import { describe, expect, it } from "vitest";
import { rulerMarks } from "./rulerMarks";

describe("the Programación ruler", () => {
  const now = Date.parse("2026-10-06T22:11:30Z");

  it("draws a busy schedule across the whole day, clipped to the ruler", () => {
    const marks = rulerMarks({ upcoming: [], busy: [{ from: "2026-10-06T22:10:00Z", to: "2026-10-07T22:15:00Z" }] }, now);
    expect(marks).toEqual([{ kind: "band", from: "2026-10-06T22:10:00Z", to: "2026-10-07T22:15:00Z", left: 0, width: 1 }]);
  });

  it("keeps a busy schedule's gaps", () => {
    // Every minute from 09:00 to 17:59, looked at from 03:00.
    const marks = rulerMarks({ upcoming: [], busy: [{ from: "2026-10-07T09:00:00Z", to: "2026-10-07T18:00:00Z" }] }, Date.parse("2026-10-07T03:00:00Z"));
    expect(marks).toEqual([{ kind: "band", from: "2026-10-07T09:00:00Z", to: "2026-10-07T18:00:00Z", left: 0.25, width: 0.375 }]);
  });

  it("leaves out runs past the ruler instead of piling them on its edge", () => {
    // A weekday 09:00 (12:00Z) computed on Friday — Monday and Tuesday — looked at on Sunday.
    const sunday = Date.parse("2026-10-11T13:00:00Z");
    const marks = rulerMarks({ upcoming: ["2026-10-12T12:00:00Z", "2026-10-13T12:00:00Z"], busy: [] }, sunday);
    expect(marks).toEqual([{ kind: "dot", at: "2026-10-12T12:00:00Z", left: 23 / 24 }]);
  });

  it("turns many runs into thin ticks", () => {
    const quarterHours = Array.from({ length: 97 }, (_, i) => new Date(now + 30_000 + i * 15 * 60_000).toISOString());
    const marks = rulerMarks({ upcoming: quarterHours, busy: [] }, now);
    expect(marks).toHaveLength(96);
    expect(marks.every((mark) => mark.kind === "tick")).toBe(true);
  });
});
