import { describe, expect, it } from "vitest";
import { askBlink, cueClock, startle, WAKE_S } from "./cue";

describe("Codi's cue clock", () => {
  it("plays a wake once per `at`, and replays it for a new one", () => {
    const clock = cueClock();
    const at = performance.now();
    clock.set({ phase: "listen", cue: { kind: "wake", at } });
    expect(clock.wake).toBeGreaterThanOrEqual(0);
    clock.step(WAKE_S);
    expect(clock.wake).toBe(-1);
    // The same cue handed over again (a re-render) does not startle it twice…
    clock.set({ phase: "listen", cue: { kind: "wake", at } });
    expect(clock.wake).toBe(-1);
    // …a new wake word does.
    clock.set({ phase: "listen", cue: { kind: "wake", at: performance.now() } });
    expect(clock.wake).toBeGreaterThanOrEqual(0);
  });

  it("does not startle a mark mounted long after the wake word", () => {
    const clock = cueClock();
    clock.set({ phase: "listen", cue: { kind: "wake", at: performance.now() - 5_000 } });
    expect(clock.wake).toBe(-1);
  });

  it("eases into the ask's pose and out of it, and holds it in a still frame", () => {
    const clock = cueClock();
    clock.set({ phase: "listen", cue: { kind: "ask", at: 0 } });
    clock.step(0.1);
    expect(clock.ask).toBeGreaterThan(0);
    expect(clock.ask).toBeLessThan(1);
    clock.settle();
    expect(clock.ask).toBe(1);
    clock.set({ phase: "listen" });
    clock.step(0.1);
    expect(clock.ask).toBeLessThan(1);
  });

  it("drops every cue when the run ends, stops or goes quiet — a finish wins", () => {
    for (const ending of [{ done: true }, { failed: true }, { stopping: true }, { quiet: true }]) {
      const clock = cueClock();
      clock.set({ phase: "listen", cue: { kind: "wake", at: performance.now() } });
      clock.set({ phase: "listen", cue: { kind: "ask", at: 0 }, ...ending });
      clock.step(1);
      expect(clock.wake, JSON.stringify(ending)).toBe(-1);
      expect(clock.ask, JSON.stringify(ending)).toBe(0);
    }
  });

  it("shapes the startle and the questioning blink", () => {
    expect(startle(-1)).toBe(0);
    expect(startle(WAKE_S * 0.2)).toBeCloseTo(1);
    expect(startle(WAKE_S)).toBeCloseTo(0);
    // Open most of the beat, shut twice near its start.
    expect(askBlink(1.5)).toBe(1);
    expect(askBlink(0.1)).toBeLessThan(0.2);
    expect(askBlink(0.3)).toBeLessThan(0.2);
  });
});
