import { describe, expect, it } from "vitest";
import {
  CONTEXT_FULL_AT,
  CONTEXT_WARN_AT,
  contextFraction,
  estimateTokens,
  formatTokens,
} from "./contextWindow";

// The window these numbers are divided by comes from Rust — `ai::context_window_for`, tested in
// `ai.rs` — because the backend's automatic compaction decides with the same figure. A second table
// here would let the ring and the turn disagree. What is left below is everything that turns a
// window into something on screen.

/**
 * The estimate is the fallback, and it is only allowed to fail in one direction.
 *
 * Under-counting is the harmful one: it reads comfortable while the window is already full. So the
 * ratio is deliberately below the English rule of thumb, and this pins that it stays there.
 */
describe("estimateTokens", () => {
  it("counts nothing for nothing", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("errs high rather than low against the four-characters-per-token rule of thumb", () => {
    const text = "a".repeat(4_000);
    expect(estimateTokens(text)).toBeGreaterThan(1_000);
  });

  it("charges for whitespace, which every tokenizer here does", () => {
    // Long enough for the difference to survive the rounding: one space in ten characters
    // disappears into a `ceil`, a hundred of them do not.
    const spaced = "hola mundo ".repeat(100);
    expect(estimateTokens(spaced)).toBeGreaterThan(estimateTokens(spaced.split(" ").join("")));
  });
});

describe("contextFraction", () => {
  it("has no answer without a window", () => {
    expect(contextFraction(10_000, null)).toBeNull();
    expect(contextFraction(10_000, 0)).toBeNull();
  });

  it("clamps at full rather than drawing past the end of the bar", () => {
    // A measurement above the table's figure means the table is wrong about this model, not that
    // the conversation is at 130%.
    expect(contextFraction(260_000, 200_000)).toBe(1);
  });

  it("is an ordinary fraction in between", () => {
    expect(contextFraction(50_000, 200_000)).toBeCloseTo(0.25);
  });
});

describe("formatTokens", () => {
  it("abbreviates so the chip does not resize every few turns", () => {
    expect(formatTokens(840, "es")).toBe("840");
    expect(formatTokens(9_400, "es")).toBe("9,4k");
    expect(formatTokens(142_700, "es")).toBe("143k");
    expect(formatTokens(1_200_000, "es")).toBe("1,2M");
  });

  it("follows the locale's decimal separator", () => {
    expect(formatTokens(9_400, "en")).toBe("9.4k");
  });
});

describe("the thresholds", () => {
  it("warn before full, and both leave room to act", () => {
    // A warning at 95% is a warning about something that has already happened: compaction needs a
    // conversation that still fits in a turn of its own.
    expect(CONTEXT_WARN_AT).toBeLessThan(CONTEXT_FULL_AT);
    expect(CONTEXT_FULL_AT).toBeLessThan(1);
  });
});
