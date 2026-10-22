import { afterEach, describe, expect, it } from "vitest";
import { endListen, listenActive, listenLevel, setListenLevel } from "./listen";

describe("the listening level", () => {
  afterEach(() => endListen());

  it("rises fast and falls slower, so a syllable lands as a pulse", () => {
    setListenLevel(0, 0);
    setListenLevel(1, 10);
    expect(listenActive()).toBe(true);
    // Within a few hundredths of a second of a loud reading it is most of the way up…
    expect(listenLevel(70)).toBeGreaterThan(0.8);
    setListenLevel(0, 80);
    const top = listenLevel(80);
    // …while a fifth of a second after it went quiet it has only fallen part of the way.
    expect(listenLevel(130)).toBeGreaterThan(top * 0.6);
    expect(listenLevel(280)).toBeLessThan(top * 0.45);
    expect(listenLevel(1_000)).toBeLessThan(0.05);
  });

  it("is smoothed against the clock, not per reading: every mark reads the same value", () => {
    setListenLevel(0, 0);
    setListenLevel(0.8, 0);
    const once = listenLevel(40);
    // A second mark reading in the same frame, and a third reading late, see the same level.
    expect(listenLevel(40)).toBe(once);
    expect(listenLevel(20)).toBe(once);
  });

  it("clamps what it is fed, and treats a feed that stopped as silence", () => {
    setListenLevel(4, 0);
    expect(listenLevel(200)).toBeLessThanOrEqual(1);
    setListenLevel(Number.NaN, 200);
    expect(listenLevel(1_000)).toBeLessThan(0.05);
    setListenLevel(0.9, 2_000);
    expect(listenLevel(2_200)).toBeGreaterThan(0.8);
    // No level since, and no `endListen`: it falls away instead of holding the last one.
    expect(listenLevel(4_000)).toBeLessThan(0.05);
    expect(listenActive()).toBe(true);
  });

  it("stands in with a speech-like shape when nothing feeds it, and again once it ends", () => {
    expect(listenActive()).toBe(false);
    const levels = [0, 90, 180, 270, 360, 450, 540].map((ms) => listenLevel(ms));
    expect(levels.every((level) => level >= 0.1 && level <= 1)).toBe(true);
    // Syllables: loud and quiet ones, not a steady hum.
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.3);
    setListenLevel(0.5, 0);
    endListen();
    expect(listenActive()).toBe(false);
    expect(listenLevel(90)).toBe(levels[1]);
  });
});
