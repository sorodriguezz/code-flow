import { describe, expect, it } from "vitest";
import { quotaBlocks, railWindows } from "./quotaStore";
import type { ProviderQuota, QuotaLimit } from "../types/domain";

const lim = (kind: string, used: number, scope = ""): QuotaLimit => ({ kind, scope, used_percent: used, resets_at: "" });
const row = (limits: QuotaLimit[], provider = "claude"): ProviderQuota => ({
  provider,
  limits,
  plan: "",
  error: "",
  fetched_at: "",
  account_id: null,
});

// The shapes each backend module produces — see the tests in `src-tauri/src/ai_quota.rs`.
const claudeWithFable = row([lim("weekly", 95, "Fable"), lim("session", 12), lim("weekly", 40)]);
const geminiGroups = row([lim("weekly", 6.76, "Claude and GPT models"), lim("weekly", 4.56, "Gemini Models")], "gemini");
const opencodeMonthFull = row([lim("monthly", 100), lim("weekly", 40), lim("session", 2)], "opencode");
const codexFree = row([lim("monthly", 18)], "codex");

describe("railWindows", () => {
  it("puts the fullest non-session limit outside, even a model's slice of the week", () => {
    const { session, long } = railWindows(claudeWithFable);
    expect(session?.used_percent).toBe(12);
    expect(long?.scope).toBe("Fable");
  });

  it("does not hide a full month behind a quiet week (OpenCode)", () => {
    expect(railWindows(opencodeMonthFull).long?.kind).toBe("monthly");
  });

  it("takes the fullest group when no total exists (Gemini)", () => {
    const { session, long } = railWindows(geminiGroups);
    expect(session).toBeNull();
    expect(long?.scope).toBe("Claude and GPT models");
  });

  it("uses a kindless window when there is nothing else", () => {
    expect(railWindows(row([lim("", 30, "gemini-pro")])).long?.used_percent).toBe(30);
  });

  it("reports nothing for a row without limits", () => {
    expect(railWindows(row([]))).toEqual({ session: null, long: null });
  });
});

describe("quotaBlocks", () => {
  const scopes = (quota: ProviderQuota) => quotaBlocks(quota).map((b) => `${b.kind}|${b.limit.scope}`);

  it("gives a model's week a block of its own, after the weekly total (Claude + Fable)", () => {
    expect(scopes(claudeWithFable)).toEqual(["session|", "weekly|", "weekly|Fable"]);
  });

  it("keeps every window, in session → week → month order (OpenCode)", () => {
    const blocks = quotaBlocks(opencodeMonthFull);
    expect(blocks.map((b) => b.kind)).toEqual(["session", "weekly", "monthly"]);
    expect(blocks[2].limit.used_percent).toBe(100);
  });

  it("shows each group of a week reported only per group, fullest first (Gemini)", () => {
    expect(scopes(geminiGroups)).toEqual(["weekly|Claude and GPT models", "weekly|Gemini Models"]);
  });

  it("shows a lone month (Codex free)", () => {
    expect(quotaBlocks(codexFree)).toEqual([{ kind: "monthly", limit: codexFree.limits[0] }]);
  });

  it("gives each kindless bucket its own block, fullest first", () => {
    const blocks = quotaBlocks(row([lim("model", 10, "flash"), lim("model", 30, "pro")]));
    expect(blocks.map((b) => b.limit.scope)).toEqual(["pro", "flash"]);
  });
});
