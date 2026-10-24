import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri/commands", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
  powerSaveSet: vi.fn(async () => undefined),
  powerStatus: vi.fn(async () => null),
}));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => () => undefined }));

const { autoLevel, effectiveLevel } = await import("./powerSaveStore");

const battery = (percent: number, plugged_in: boolean) => ({ percent, plugged_in, charging: false, minutes_left: null });

describe("battery saving levels", () => {
  it("follows the battery under automatic: unplugged, 20 %, 10 %, charger", () => {
    expect(autoLevel(battery(80, true))).toBe(0);
    expect(autoLevel(battery(5, true))).toBe(0);
    expect(autoLevel(battery(80, false))).toBe(1);
    expect(autoLevel(battery(20, false))).toBe(2);
    expect(autoLevel(battery(10, false))).toBe(3);
  });

  it("keeps a level picked by hand, charger or not, and saves nothing without a battery", () => {
    expect(effectiveLevel(2, battery(90, true))).toBe(2);
    expect(effectiveLevel(0, battery(5, false))).toBe(0);
    expect(effectiveLevel("auto", battery(15, false))).toBe(2);
    expect(effectiveLevel(3, null)).toBe(0);
  });
});
