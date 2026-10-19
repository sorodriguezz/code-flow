import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ContextReading } from "./ContextMeter";

/**
 * The chip is the whole contract of this control: a number, and whether that number is exact.
 *
 * A measurement the engine took on an earlier turn is not exact any more — the turns since are not
 * in it — and the meter used to present it with the same confidence as a fresh one. That is what a
 * frozen context reading looked like from the outside, so the `~` is pinned here.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { ContextMeter } = await import("./ContextMeter");

function reading(patch: Partial<ContextReading> = {}): ContextReading {
  return {
    tokens: 39_000,
    measured: true,
    window: 1_000_000,
    resumes: true,
    compactedTurns: 0,
    autoCompacts: false,
    summary: "",
    compacting: false,
    onUncompact: () => {},
    ...patch,
  };
}

const chip = (patch: Partial<ContextReading> = {}) =>
  renderToStaticMarkup(<ContextMeter reading={reading(patch)} />);

describe("ContextMeter", () => {
  it("shows a fresh measurement as exact", () => {
    const html = chip();
    expect(html).toContain("39k");
    expect(html).not.toContain("~39k");
  });

  it("shows a measurement from an earlier turn as an approximation", () => {
    expect(chip({ stale: true })).toContain("~39k");
  });

  it("shows an estimate as an approximation", () => {
    expect(chip({ measured: false })).toContain("~39k");
  });

  it("draws no ring when the window is unknown", () => {
    expect(chip({ window: null })).not.toContain("<circle");
    expect(chip()).toContain("<circle");
  });
});
