import { afterEach, describe, expect, it } from "vitest";
import { endVoice, startVoice, voiceActive, voiceLevel } from "./voice";

describe("the voice level", () => {
  afterEach(() => endVoice());

  it("follows the envelope against the clock, between its steps", () => {
    startVoice([0, 1, 0.5], 40);
    const start = performance.now();
    expect(voiceActive()).toBe(true);
    expect(voiceLevel(start)).toBeCloseTo(0, 1);
    expect(voiceLevel(start + 60)).toBeCloseTo(0.75, 1);
    // Past the end of the utterance it is silent, not stuck on the last step.
    expect(voiceLevel(start + 1_000)).toBe(0);
  });

  it("stands in with a speech-like shape when nothing is playing", () => {
    endVoice();
    expect(voiceActive()).toBe(false);
    const levels = [0, 100, 200, 300, 400].map((ms) => voiceLevel(ms));
    expect(levels.every((level) => level >= 0.3 && level <= 1)).toBe(true);
    expect(new Set(levels.map((level) => level.toFixed(2))).size).toBeGreaterThan(1);
  });
});
