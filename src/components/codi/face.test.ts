import { describe, expect, it } from "vitest";
import { codiActivity, turnOutcome } from "./face";
import type { CodiActed } from "../../lib/tauri/codiCommands";

/**
 * Codi's face says what Codi is doing — never a phase it is not in. The mapping is the contract
 * between the runtime's phases and the thinking mark's looks.
 */

const acted = (ok: boolean): CodiActed => ({ action: "app.open", params: {}, ok, say: ok ? "Listo" : null, error: ok ? null : "no" });

describe("Codi's face", () => {
  it("draws each phase as its look", () => {
    const at = 1234;
    expect(codiActivity({ phase: "off", phaseSince: at })).toEqual({ quiet: true });
    expect(codiActivity({ phase: "idle", phaseSince: at })).toEqual({ phase: "listen" });
    expect(codiActivity({ phase: "hearing", phaseSince: at })).toEqual({ phase: "listen" });
    expect(codiActivity({ phase: "thinking", phaseSince: at })).toEqual({ phase: "think" });
    expect(codiActivity({ phase: "acting", phaseSince: at })).toEqual({ phase: "work" });
    expect(codiActivity({ phase: "speaking", phaseSince: at })).toEqual({ phase: "speak" });
    // Waiting holds the asking pose, from the moment it began — the same `at`, so it does not replay.
    expect(codiActivity({ phase: "waiting", phaseSince: at })).toEqual({ phase: "think", cue: { kind: "ask", at } });
  });

  it("plays the wake cue over the phase it is in, but not with the microphone off", () => {
    expect(codiActivity({ phase: "hearing", phaseSince: 0, wakeAt: 50 })).toEqual({ phase: "listen", cue: { kind: "wake", at: 50 } });
    expect(codiActivity({ phase: "thinking", phaseSince: 0, wakeAt: 50 })).toEqual({ phase: "think", cue: { kind: "wake", at: 50 } });
    expect(codiActivity({ phase: "waiting", phaseSince: 0, wakeAt: 50 })).toEqual({ phase: "think", cue: { kind: "wake", at: 50 } });
    expect(codiActivity({ phase: "off", phaseSince: 0, wakeAt: 50 })).toEqual({ quiet: true });
  });

  it("lets a finish win over everything for its moment", () => {
    expect(codiActivity({ phase: "speaking", phaseSince: 0, flash: "done" })).toEqual({ done: true });
    expect(codiActivity({ phase: "idle", phaseSince: 0, wakeAt: 9, flash: "failed" })).toEqual({ failed: true });
  });
});

describe("what a turn ended in", () => {
  it("is done when its actions all ran, failed on an error or any action that did not", () => {
    expect(turnOutcome({ error: null, actions: [acted(true), acted(true)] })).toBe("done");
    expect(turnOutcome({ error: null, actions: [acted(true), acted(false)] })).toBe("failed");
    expect(turnOutcome({ error: "no engine", actions: [] })).toBe("failed");
  });

  it("is nothing to celebrate for an answer with no action", () => {
    expect(turnOutcome({ error: null, actions: [] })).toBeNull();
  });
});
