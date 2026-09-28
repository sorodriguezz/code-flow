import { describe, expect, it } from "vitest";
import { isEnginePause, resumeInstant } from "./chainPause";

const at = (iso: string) => Date.parse(iso);

describe("resumeInstant", () => {
  it("takes the exact instant when the provider stated one", () => {
    expect(resumeInstant({ resets: null, resets_at: 1_751_234_567 }, at("2026-09-28T00:00:00Z"))).toBe(1_751_234_567_000);
  });

  it("reads a relative wait", () => {
    const now = at("2026-09-28T10:00:00Z");
    expect(resumeInstant({ resets: "in 2 hours", resets_at: null }, now)).toBe(now + 2 * 3_600_000);
    expect(resumeInstant({ resets: "in 45 minutes", resets_at: null }, now)).toBe(now + 45 * 60_000);
    expect(resumeInstant({ resets: "in 2 hours 30 minutes", resets_at: null }, now)).toBe(now + 150 * 60_000);
  });

  it("reads Claude's clock time in the zone it names — the next one, not today's if it is gone", () => {
    // 23:30 on the 27th in Santiago (UTC-3 in September): the next 12am is half an hour away.
    const now = at("2026-09-28T02:30:00Z");
    expect(resumeInstant({ resets: "12am (America/Santiago)", resets_at: null }, now)).toBe(at("2026-09-28T03:00:00Z"));
    // 18:00 UTC: 5pm has passed today, so it is tomorrow's.
    expect(resumeInstant({ resets: "5pm (UTC)", resets_at: null }, at("2026-09-28T18:00:00Z"))).toBe(
      at("2026-09-29T17:00:00Z"),
    );
    expect(resumeInstant({ resets: "17:00 (UTC)", resets_at: null }, at("2026-09-28T16:00:00Z"))).toBe(
      at("2026-09-28T17:00:00Z"),
    );
  });

  it("honours a weekday and a date", () => {
    // Sunday the 27th → Monday the 28th.
    expect(resumeInstant({ resets: "Mon 9am (UTC)", resets_at: null }, at("2026-09-27T10:00:00Z"))).toBe(
      at("2026-09-28T09:00:00Z"),
    );
    // Madrid is UTC+2 until late October; the 6 is the day, not the hour.
    expect(resumeInstant({ resets: "Oct 6, 9:30pm (Europe/Madrid)", resets_at: null }, at("2026-09-28T10:00:00Z"))).toBe(
      at("2026-10-06T19:30:00Z"),
    );
  });

  it("offers nothing it cannot read for sure", () => {
    const now = at("2026-09-28T10:00:00Z");
    expect(resumeInstant({ resets: null, resets_at: null }, now)).toBeNull();
    expect(resumeInstant({ resets: "soon", resets_at: null }, now)).toBeNull();
    expect(resumeInstant({ resets: "9", resets_at: null }, now)).toBeNull();
    expect(resumeInstant({ resets: "5pm (Nowhere/Atlantis)", resets_at: null }, now)).toBeNull();
    expect(resumeInstant({ resets: "13pm (UTC)", resets_at: null }, now)).toBeNull();
  });
});

describe("isEnginePause", () => {
  it("is true only for the three engine reasons", () => {
    expect(isEnginePause("chain.pausedQuota")).toBe(true);
    expect(isEnginePause("chain.pausedAuth")).toBe(true);
    expect(isEnginePause("chain.pausedCliMissing")).toBe(true);
    expect(isEnginePause("chain.interrupted")).toBe(false);
    expect(isEnginePause("chain.stopped")).toBe(false);
    expect(isEnginePause("")).toBe(false);
  });
});
