import { describe, expect, it } from "vitest";
import { SETTINGS_MIN, settingsFrame } from "./useSettingsFrame";

describe("the settings frame", () => {
  const viewport = { width: 1600, height: 1000 };

  it("covers the central sheet edge to edge when it has room", () => {
    const sheet = { top: 40, left: 260, width: 1280, height: 900 };
    expect(settingsFrame(sheet, viewport)).toEqual(sheet);
  });

  it("spans the central sheet and the AI panel, the rail between them included, while the panel is open", () => {
    const sheet = { top: 40, left: 260, width: 900, height: 940 };
    const panel = { top: 40, left: 1220, width: 360, height: 940 };
    expect(settingsFrame(sheet, viewport, panel)).toEqual({ top: 40, left: 260, width: 1320, height: 940 });
    // A terminal dock shortens the central sheet only: the frame still holds the whole chat.
    expect(settingsFrame({ ...sheet, height: 600 }, viewport, panel)).toEqual({ top: 40, left: 260, width: 1320, height: 940 });
    // A sheet too narrow on its own is enough once the chat's room is added to it.
    expect(settingsFrame({ ...sheet, width: SETTINGS_MIN.width - 100 }, viewport, panel)).toEqual({ top: 40, left: 260, width: 1320, height: 940 });
  });

  it("never builds the frame from the panel alone", () => {
    expect(settingsFrame(null, viewport, { top: 40, left: 1220, width: 360, height: 940 })).toEqual({ top: 44, left: 24, width: 1552, height: 932 });
  });

  it("takes the whole window, less a margin, under the title bar, when the sheet is too small or missing", () => {
    expect(settingsFrame({ top: 40, left: 900, width: SETTINGS_MIN.width - 1, height: 900 }, viewport)).toEqual({ top: 40, left: 24, width: 1552, height: 936 });
    expect(settingsFrame({ top: 40, left: 260, width: 1280, height: SETTINGS_MIN.height - 1 }, viewport)).toEqual({ top: 40, left: 24, width: 1552, height: 936 });
    expect(settingsFrame(null, viewport)).toEqual({ top: 44, left: 24, width: 1552, height: 932 });
  });

  it("uses every pixel of a phone-sized window", () => {
    expect(settingsFrame(null, { width: 390, height: 800 })).toEqual({ top: 0, left: 0, width: 390, height: 800 });
  });
});

describe("the settings frame with the terminal dock open", () => {
  const viewport = { width: 1600, height: 1000 };
  const sheet = { top: 40, left: 260, width: 1280, height: 560 };
  const dock = { top: 606, left: 260, width: 1280, height: 374 };

  it("covers the dock under the central sheet as well", () => {
    expect(settingsFrame(sheet, viewport, null, dock)).toEqual({ top: 40, left: 260, width: 1280, height: 940 });
  });

  it("holds the sheet, the chat and the dock together", () => {
    const panel = { top: 40, left: 1220, width: 360, height: 940 };
    expect(settingsFrame({ ...sheet, width: 900 }, viewport, panel, { ...dock, width: 900 })).toEqual({
      top: 40,
      left: 260,
      width: 1320,
      height: 940,
    });
  });
});

describe("the settings frame beside the projects panel", () => {
  const viewport = { width: 1600, height: 1000 };

  it("runs over the unfolded panel too — no blurred strip beside it — with the rail's air on both sides", () => {
    const sheet = { top: 40, left: 308, width: 1240, height: 940 };
    const side = { top: 0, left: 0, width: 300, height: 1000 };
    // The rail leaves 52 px on the right; the left gets the same.
    expect(settingsFrame(sheet, viewport, null, null, side)).toEqual({ top: 40, left: 52, width: 1496, height: 940 });
  });

  it("and over the folded one, centred the same way", () => {
    const sheet = { top: 40, left: 64, width: 1484, height: 940 };
    const side = { top: 0, left: 0, width: 56, height: 1000 };
    expect(settingsFrame(sheet, viewport, null, null, side)).toEqual({ top: 40, left: 52, width: 1496, height: 940 });
  });

  it("never pushes past the sheet's own left edge", () => {
    const sheet = { top: 40, left: 20, width: 1000, height: 940 };
    const side = { top: 0, left: 0, width: 12, height: 1000 };
    expect(settingsFrame(sheet, viewport, null, null, side).left).toBe(20);
  });
});
