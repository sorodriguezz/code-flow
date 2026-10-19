import { describe, expect, it } from "vitest";
import { formatResetAt, formatResetIn } from "./quotaStore";

/** A fixed local instant to count from, so the day boundaries under test are the machine's own —
 *  which is exactly what the panel resolves against. */
const now = new Date(2026, 9, 19, 14, 0, 0).getTime();

/** `at` as the RFC 3339 the backend hands over for an instant `minutes` from `now`. */
function inMinutes(minutes: number): string {
  return new Date(now + minutes * 60_000).toISOString();
}

describe("formatResetIn", () => {
  it("counts to the instant in at most two units", () => {
    expect(formatResetIn(inMinutes(83), now)).toBe("1h 23m");
    expect(formatResetIn(inMinutes(4), now)).toBe("4m");
    expect(formatResetIn(inMinutes(60 * 28), now)).toBe("1d 4h");
  });

  it("has nothing to say about a window with no instant or one already rolled over", () => {
    expect(formatResetIn("", now)).toBeNull();
    expect(formatResetIn("not a date", now)).toBeNull();
    expect(formatResetIn(inMinutes(-1), now)).toBeNull();
  });
});

describe("formatResetAt", () => {
  it("names today and tomorrow and leaves the clock reading alone", () => {
    expect(formatResetAt(inMinutes(83), now, "en")).toEqual({ day: "today", text: "03:23 PM" });
    expect(formatResetAt(inMinutes(60 * 20), now, "en")).toEqual({ day: "tomorrow", text: "10:00 AM" });
  });

  it("carries its own date any further out, since the weekday alone would not say which week", () => {
    const at = formatResetAt(inMinutes(60 * 52), now, "en");
    expect(at?.day).toBe("other");
    expect(at?.text).toBe("Wed, Oct 21, 06:00 PM");
  });

  it("crosses midnight by the calendar day, not by the hours between", () => {
    // 23:00 → 01:00 is two hours away and still a different day.
    const late = new Date(2026, 9, 19, 23, 0, 0).getTime();
    expect(formatResetAt(new Date(2026, 9, 20, 1, 0, 0).toISOString(), late, "en")?.day).toBe("tomorrow");
  });

  it("is silent on the same inputs the countdown is silent on", () => {
    expect(formatResetAt("", now)).toBeNull();
    expect(formatResetAt("not a date", now)).toBeNull();
    expect(formatResetAt(inMinutes(-1), now)).toBeNull();
  });
});
