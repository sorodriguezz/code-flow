import { describe, expect, it, vi } from "vitest";
import {
  MIN_RESUME_DELAY_MS,
  RESUME_GRACE_MS,
  UNKNOWN_RESET_PROBE_MS,
  quotaResumeTime,
  resolveQuotaResumeTime,
} from "./quotaResume";

const classifyFailureMock = vi.hoisted(() => vi.fn());

vi.mock("./tauri/commands", () => ({ aiClassifyFailure: classifyFailureMock }));

const QUOTA_PREFIX = "QUOTA_EXCEEDED::";
const SANTIAGO_RESET = `${QUOTA_PREFIX}You've hit your 5-hour limit · resets 5:20pm (America/Santiago)`;
const NOW_IN_SANTIAGO_14_01 = Date.parse("2026-11-11T14:01:00-03:00");
const RESET_IN_SANTIAGO_17_20 = Date.parse("2026-11-11T17:20:00-03:00");
const MINUTE_MS = 60_000;
const ORDINARY_FAILURE = "connection reset";
const SECOND_MS = 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function resumeFor(providerWords: string): number | null {
  const marked = `${QUOTA_PREFIX}${providerWords}`;
  return quotaResumeTime(marked, NOW_IN_SANTIAGO_14_01);
}

describe("quotaResumeTime", () => {
  it("reads the reset clock in the provider's time zone", () => {
    const resumeAt = quotaResumeTime(SANTIAGO_RESET, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(RESET_IN_SANTIAGO_17_20 + RESUME_GRACE_MS);
  });

  it("rolls a reset clock that already passed today over to tomorrow", () => {
    const afterReset = RESET_IN_SANTIAGO_17_20 + 10 * MINUTE_MS;
    const resumeAt = quotaResumeTime(SANTIAGO_RESET, afterReset);
    const expected = RESET_IN_SANTIAGO_17_20 + 24 * 60 * MINUTE_MS + RESUME_GRACE_MS;
    expect(resumeAt).toBe(expected);
  });

  it("reads midnight as 12am", () => {
    const message = `${QUOTA_PREFIX}You've hit your session limit · resets 12am (America/Santiago)`;
    const resumeAt = quotaResumeTime(message, NOW_IN_SANTIAGO_14_01);
    const midnight = Date.parse("2026-11-12T00:00:00-03:00");
    expect(resumeAt).toBe(midnight + RESUME_GRACE_MS);
  });

  it("uses the epoch stamp when the provider gives one", () => {
    const stamp = Math.floor(RESET_IN_SANTIAGO_17_20 / 1000);
    const message = `${QUOTA_PREFIX}Claude AI usage limit reached|${stamp}`;
    const resumeAt = quotaResumeTime(message, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(stamp * 1000 + RESUME_GRACE_MS);
  });

  it("reads a relative wait", () => {
    const message = `${QUOTA_PREFIX}Usage limit reached. Try again in 2 hours 15 minutes.`;
    const resumeAt = quotaResumeTime(message, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 135 * MINUTE_MS + RESUME_GRACE_MS);
  });

  it("probes later when the reset time is unknown", () => {
    const message = `${QUOTA_PREFIX}Rate limit reached.`;
    const resumeAt = quotaResumeTime(message, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + UNKNOWN_RESET_PROBE_MS);
  });

  it("never resumes sooner than the minimum delay", () => {
    const stamp = Math.floor(NOW_IN_SANTIAGO_14_01 / 1000) - 600;
    const message = `${QUOTA_PREFIX}Claude AI usage limit reached|${stamp}`;
    const resumeAt = quotaResumeTime(message, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + MIN_RESUME_DELAY_MS);
  });

  it("does not resume a billing refusal or an ordinary error", () => {
    const billing = `${QUOTA_PREFIX}Insufficient balance on your account`;
    const billingResume = quotaResumeTime(billing, NOW_IN_SANTIAGO_14_01);
    const ordinaryResume = quotaResumeTime(ORDINARY_FAILURE, NOW_IN_SANTIAGO_14_01);
    expect(billingResume).toBeNull();
    expect(ordinaryResume).toBeNull();
  });

  it("reads waits in seconds, as Gemini words them", () => {
    const resumeAt = resumeFor("Quota exceeded for model. Please retry in 35.5s.");
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 35.5 * SECOND_MS + RESUME_GRACE_MS);
  });

  it("reads Gemini's retryDelay field", () => {
    const resumeAt = resumeFor('RESOURCE_EXHAUSTED {"@type":"RetryInfo","retryDelay": "42s"}');
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 42 * SECOND_MS + RESUME_GRACE_MS);
  });

  it("reads waits in days and hours", () => {
    const resumeAt = resumeFor("You've hit your usage limit. Try again in 3 days 2 hours.");
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 3 * DAY_MS + 2 * HOUR_MS + RESUME_GRACE_MS);
  });

  it("reads compact waits like 1h30m", () => {
    const resumeAt = resumeFor("Rate limit reached, retry in 1h30m");
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 90 * MINUTE_MS + RESUME_GRACE_MS);
  });

  it("reads a reset on a weekday", () => {
    const resumeAt = resumeFor("You've hit your weekly limit · resets Mon 9am (America/Santiago)");
    const mondayNine = Date.parse("2026-11-16T09:00:00-03:00");
    expect(resumeAt).toBe(mondayNine + RESUME_GRACE_MS);
  });

  it("reads a reset on a calendar date", () => {
    const resumeAt = resumeFor("You've hit your usage limit. Try again at Nov 14th, 2026 3:00 PM (UTC).");
    const novemberFourteenth = Date.parse("2026-11-14T15:00:00Z");
    expect(resumeAt).toBe(novemberFourteenth + RESUME_GRACE_MS);
  });

  it("reads a reset tomorrow on a 24-hour clock", () => {
    const resumeAt = resumeFor("Usage limit reached · resets tomorrow at 08:30 (America/Santiago)");
    const tomorrowMorning = Date.parse("2026-11-12T08:30:00-03:00");
    expect(resumeAt).toBe(tomorrowMorning + RESUME_GRACE_MS);
  });

  it("reads an ISO instant", () => {
    const resumeAt = resumeFor("rate limit reached; resets at 2026-11-11T20:00:00Z");
    const isoInstant = Date.parse("2026-11-11T20:00:00Z");
    expect(resumeAt).toBe(isoInstant + RESUME_GRACE_MS);
  });

  it("reads a Retry-After header", () => {
    const resumeAt = resumeFor("429 Too Many Requests. Retry-After: 120");
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 120 * SECOND_MS + RESUME_GRACE_MS);
  });
});

describe("resolveQuotaResumeTime", () => {
  it("asks the backend classifier about an unmarked error from a custom engine", async () => {
    classifyFailureMock.mockResolvedValueOnce({
      kind: "quota",
      message: "rate limit reached, try again in 10 minutes",
      resets: "in 10 minutes",
      resets_at: null,
    });
    const resumeAt = await resolveQuotaResumeTime("rate limit reached, try again in 10 minutes", NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBe(NOW_IN_SANTIAGO_14_01 + 10 * MINUTE_MS + RESUME_GRACE_MS);
  });

  it("leaves an unmarked ordinary failure alone", async () => {
    classifyFailureMock.mockResolvedValueOnce({ kind: "other", message: ORDINARY_FAILURE, resets: null, resets_at: null });
    const resumeAt = await resolveQuotaResumeTime(ORDINARY_FAILURE, NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBeNull();
  });

  it("does not resume an unmarked billing refusal", async () => {
    classifyFailureMock.mockResolvedValueOnce({ kind: "quota", message: "Payment required", resets: null, resets_at: null });
    const resumeAt = await resolveQuotaResumeTime("Payment required", NOW_IN_SANTIAGO_14_01);
    expect(resumeAt).toBeNull();
  });
});
