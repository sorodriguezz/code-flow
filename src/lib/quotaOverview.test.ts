import { describe, expect, it } from "vitest";
import type { ProviderQuota, QuotaLimit } from "../types/domain";
import { accountAvailability, attentionItems, availabilityOf, quotaOverview, upcomingResets } from "./quotaOverview";

const limit = (kind: string, used: number, scope = "", resets_at = ""): QuotaLimit => ({ kind, scope, used_percent: used, resets_at });
const quota = (provider: string, limits: QuotaLimit[], account_id: string | null = null): ProviderQuota => ({ provider, limits, plan: "", error: "", fetched_at: "2026-11-26T12:00:00Z", account_id });

describe("how available an account is", () => {
  it("reads a percentage as one of five states, by the figure that is shown for it", () => {
    expect([0, 59, 60, 79, 80, 94, 95, 99, 100, 140].map((used) => availabilityOf(used))).toEqual([
      "available", "available", "moderate", "moderate", "near", "near", "critical", "critical", "exhausted", "exhausted",
    ]);
    // Shown rounded up, so read rounded up: 99.2% is drawn «100%» and is spent, 94.1% is «95%».
    expect(availabilityOf(99.2)).toBe("exhausted");
    expect(availabilityOf(94.1)).toBe("critical");
    expect(availabilityOf(59.0)).toBe("available");
    expect(availabilityOf(null)).toBe("unknown");
    expect(availabilityOf(Number.NaN)).toBe("unknown");
  });

  it("is as far gone as the fullest of its general windows", () => {
    expect(accountAvailability(quota("claude", [limit("session", 100), limit("weekly", 30)])).status).toBe("exhausted");
    expect(accountAvailability(quota("claude", [limit("session", 11), limit("weekly", 41)])).status).toBe("available");
    expect(accountAvailability(quota("opencode", [limit("weekly", 20), limit("monthly", 86)]))).toMatchObject({ status: "near", limit: { kind: "monthly" } });
  });

  it("is not spent because one model is: it can still be used with the others", () => {
    // The week is at 40%; one model's slice of it is gone.
    const claude = quota("claude", [limit("weekly", 100, "Fable"), limit("weekly", 40), limit("session", 12)]);
    expect(accountAvailability(claude).status).toBe("available");
    expect(attentionItems([claude])).toMatchObject([{ status: "exhausted", modelOnly: true, limit: { scope: "Fable" } }]);
    // Nothing but groups of models: available while one of them is, spent when all are.
    const gemini = quota("gemini", [limit("", 100, "Gemini Models"), limit("", 33, "Claude and GPT models")]);
    expect(accountAvailability(gemini)).toMatchObject({ status: "available", limit: { scope: "Claude and GPT models" } });
    expect(attentionItems([gemini])[0]).toMatchObject({ modelOnly: true });
    const spent = quota("gemini", [limit("", 100, "Gemini Models"), limit("", 100, "Claude and GPT models")]);
    expect(accountAvailability(spent).status).toBe("exhausted");
    expect(attentionItems([spent]).map((item) => item.modelOnly)).toEqual([false, false]);
  });

  it("says it does not know about an account that reported nothing", () => {
    expect(accountAvailability(quota("codex", []))).toEqual({ status: "unknown", limit: null });
  });
});

describe("the summary", () => {
  const providers = [
    quota("claude", [limit("session", 11), limit("weekly", 41)], "a"),
    quota("claude", [limit("session", 24), limit("weekly", 92)], "b"),
    quota("claude", [limit("weekly", 67)], "c"),
    quota("codex", [limit("session", 100), limit("weekly", 50)]),
    quota("codex", [], "d"),
    quota("gemini", [limit("", 76, "Gemini Models")]),
  ];

  it("counts accounts by state and never averages their percentages", () => {
    const overview = quotaOverview(providers);
    expect(overview.accounts).toHaveLength(6);
    expect(overview.byStatus).toEqual({ available: 1, moderate: 2, near: 1, critical: 0, exhausted: 1, unknown: 1 });
    expect(overview.available).toBe(3);
    expect(overview.critical).toBe(2);
    expect(overview).not.toHaveProperty("average");
  });

  it("draws each provider's accounts from the most available to the least, the unknown last", () => {
    const overview = quotaOverview(providers);
    expect(overview.providers.map((p) => [p.provider, p.accounts.map((a) => a.status), p.available])).toEqual([
      ["claude", ["available", "moderate", "near"], 2],
      ["codex", ["exhausted", "unknown"], 0],
      ["gemini", ["moderate"], 1],
    ]);
  });

  it("lists what needs attention fullest first", () => {
    expect(attentionItems(providers).map((item) => [item.quota.provider, item.limit.kind, item.limit.used_percent])).toEqual([
      ["codex", "session", 100],
      ["claude", "weekly", 92],
    ]);
  });

  it("says which spent windows come back first, and leaves untouched ones out", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const rows = [
      quota("codex", [limit("session", 100, "", at(42)), limit("weekly", 10, "", at(30))]),
      quota("claude", [limit("session", 70, "", at(257)), limit("weekly", 92, "", at(7200)), limit("weekly", 80, "Fable", at(-5))]),
      quota("gemini", [limit("", 65, "Gemini Models", at(380)), limit("", 0, "Other", at(5))]),
    ];
    expect(upcomingResets(rows, now, 3).map((reset) => [reset.quota.provider, reset.limit.kind || reset.limit.scope])).toEqual([
      ["codex", "session"],
      ["claude", "session"],
      ["gemini", "Gemini Models"],
    ]);
    // Nothing spent: the soonest of what was used at all.
    const calm = [quota("codex", [limit("session", 5, "", at(90)), limit("weekly", 0, "", at(10))])];
    expect(upcomingResets(calm, now).map((reset) => reset.limit.kind)).toEqual(["session"]);
  });
});
