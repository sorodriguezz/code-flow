import { describe, expect, it, vi } from "vitest";
import { aiQuotaStatus } from "../lib/tauri/commands";
import type { ProviderQuota } from "../types/domain";
import { formatResetAt, formatResetIn, missingClaudeWeekly, useQuotaStore } from "./quotaStore";

vi.mock("../lib/tauri/commands", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/tauri/commands")>(),
  aiQuotaStatus: vi.fn(),
  getSetting: vi.fn().mockResolvedValue(null),
}));

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

  it("shows the calendar date and local time even for a reset today", () => {
    expect(formatResetAt(inMinutes(83), now, "en", "calendar")).toEqual({ day: "today", text: "Oct 19, 03:23 PM" });
  });

  it("includes the year when a calendar reset crosses into the next one", () => {
    const endOfYear = new Date(2026, 11, 31, 20).getTime();
    const reset = new Date(2027, 0, 1, 5).toISOString();
    expect(formatResetAt(reset, endOfYear, "en", "calendar")).toEqual({ day: "tomorrow", text: "Jan 1, 2027, 05:00 AM" });
  });

  it("is silent on the same inputs the countdown is silent on", () => {
    expect(formatResetAt("", now)).toBeNull();
    expect(formatResetAt("not a date", now)).toBeNull();
    expect(formatResetAt(inMinutes(-1), now)).toBeNull();
  });
});


describe("missingClaudeWeekly", () => {
  const session = { kind: "session", scope: "", used_percent: 3, resets_at: inMinutes(45) };
  const quota = { provider: "claude", plan: "", account_id: "personal", fetched_at: new Date(now).toISOString(), error: "from_run", limits: [session] };

  it("marks partial Claude run readings, including endpoint fallbacks", () => {
    expect(missingClaudeWeekly(quota)).toBe(true);
    expect(missingClaudeWeekly({ ...quota, error: "from_run|stale" })).toBe(true);
  });

  it("preserves a confirmed weekly reading at zero", () => {
    expect(missingClaudeWeekly({ ...quota, limits: [session, { ...session, kind: "weekly", used_percent: 0 }] })).toBe(false);
  });

  it("does not invent a weekly window for other providers or direct responses", () => {
    expect(missingClaudeWeekly({ ...quota, provider: "codex" })).toBe(false);
    expect(missingClaudeWeekly({ ...quota, error: "" })).toBe(false);
  });
});

describe("individual quota refresh", () => {
  it.each(["opencode", "gemini", "grok"] as const)("coalesces %s requests and only replaces that provider", async (provider) => {
    const original = useQuotaStore.getState();
    const row: ProviderQuota = { provider, plan: "", error: "", fetched_at: inMinutes(0), account_id: null, limits: [] };
    const other = { ...row, provider: "codex" };
    const current = {
      ...row,
      limits: ["session", "weekly", "monthly"].map((kind) => ({ kind, scope: "", used_percent: 40, resets_at: inMinutes(50) })),
    };
    try {
      useQuotaStore.setState({ providers: [other, row], lastReadAt: now });
      vi.mocked(aiQuotaStatus).mockResolvedValueOnce({ providers: [current], routed: [] });
      const refresh = useQuotaStore.getState().refreshProvider;
      await Promise.all([refresh(provider), refresh(provider)]);
      expect(aiQuotaStatus).toHaveBeenCalledExactlyOnceWith(`${provider}_poll`);
      expect(useQuotaStore.getState().providers).toEqual([other, current]);
      expect(useQuotaStore.getState().lastReadAt).toBe(now);
    } finally {
      useQuotaStore.setState(original);
      vi.mocked(aiQuotaStatus).mockReset();
    }
  });

  it("keeps a newer Gemini result when an older full poll finishes after it", async () => {
    const original = useQuotaStore.getState();
    const older: ProviderQuota = { provider: "gemini", plan: "", error: "", fetched_at: inMinutes(0), account_id: null, limits: [] };
    const current = { ...older, fetched_at: inMinutes(1), limits: [{ kind: "weekly", scope: "Gemini", used_percent: 40, resets_at: inMinutes(50) }] };
    vi.useFakeTimers();
    try {
      useQuotaStore.setState({ providers: [older] });
      vi.mocked(aiQuotaStatus).mockResolvedValueOnce({ providers: [older], routed: [] });
      const full = useQuotaStore.getState().refresh();
      vi.mocked(aiQuotaStatus).mockResolvedValueOnce({ providers: [current], routed: [] });
      await useQuotaStore.getState().refreshProvider("gemini");
      await vi.advanceTimersByTimeAsync(500);
      await full;
      expect(useQuotaStore.getState().providers).toEqual([current]);
    } finally {
      useQuotaStore.setState(original);
      vi.mocked(aiQuotaStatus).mockReset();
      vi.useRealTimers();
    }
  });
});

describe("background quota monitoring", () => {
  it("loads and refreshes the three providers before opening the panel, and pauses while hidden", async () => {
    const original = useQuotaStore.getState();
    const page = new EventTarget();
    let visible = true;
    Object.defineProperty(page, "visibilityState", { get: () => visible ? "visible" : "hidden" });
    vi.stubGlobal("document", page);
    vi.useFakeTimers();
    const row: ProviderQuota = { provider: "gemini", plan: "", error: "", fetched_at: inMinutes(0), account_id: null, limits: [] };
    const triggers = ["gemini_poll", "grok_poll", "opencode_poll"];
    const calls = () => vi.mocked(aiQuotaStatus).mock.calls.map(([trigger]) => trigger);
    vi.mocked(aiQuotaStatus).mockImplementation(async (trigger) => ({
      providers: trigger === "gemini_poll" ? [row] : [],
      routed: ["gemini"],
    }));
    useQuotaStore.setState({ providers: [], fetched: false });
    const stop = useQuotaStore.getState().watch();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(calls()).toEqual(triggers);
      expect(useQuotaStore.getState().providers).toEqual([row]);
      expect(useQuotaStore.getState().routed).toEqual(["gemini"]);
      expect(useQuotaStore.getState().fetched).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls()).toEqual([...triggers, ...triggers]);
      visible = false;
      page.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls()).toHaveLength(6);

      visible = true;
      page.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls().slice(6)).toEqual(triggers);
    } finally {
      stop();
      useQuotaStore.setState(original);
      vi.mocked(aiQuotaStatus).mockReset();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
