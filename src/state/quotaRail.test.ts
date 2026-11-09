import { describe, expect, it } from "vitest";
import { railWindows } from "./quotaStore";
import type { ProviderQuota, QuotaLimit } from "../types/domain";

const lim = (kind: string, used: number, scope = ""): QuotaLimit => ({ kind, scope, used_percent: used, resets_at: "" });
const row = (limits: QuotaLimit[]): ProviderQuota => ({
  provider: "claude",
  limits,
  plan: "",
  error: "",
  fetched_at: "",
  account_id: null,
});

describe("railWindows", () => {
  it("takes the session inside and the unscoped week outside, ignoring model slices", () => {
    const { session, long } = railWindows(row([lim("weekly", 95, "Fable"), lim("session", 12), lim("weekly", 40)]));
    expect(session?.used_percent).toBe(12);
    expect(long?.used_percent).toBe(40);
  });

  it("falls back to the fullest scoped week when no total exists (Gemini groups)", () => {
    const { session, long } = railWindows(row([lim("weekly", 10, "A"), lim("weekly", 60, "B")]));
    expect(session).toBeNull();
    expect(long?.scope).toBe("B");
  });

  it("uses a kindless window when there is nothing else", () => {
    expect(railWindows(row([lim("", 30, "gemini-pro")])).long?.used_percent).toBe(30);
  });

  it("reports nothing for a row without limits", () => {
    expect(railWindows(row([]))).toEqual({ session: null, long: null });
  });
});
