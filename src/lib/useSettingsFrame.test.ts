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
    expect(settingsFrame(null, viewport, { top: 40, left: 1220, width: 360, height: 940 })).toEqual({ top: 12, left: 12, width: 1576, height: 976 });
  });

  it("takes the whole window, less a margin, when the sheet is too small or missing", () => {
    expect(settingsFrame({ top: 40, left: 900, width: SETTINGS_MIN.width - 1, height: 900 }, viewport)).toEqual({ top: 12, left: 12, width: 1576, height: 976 });
    expect(settingsFrame({ top: 40, left: 260, width: 1280, height: SETTINGS_MIN.height - 1 }, viewport)).toEqual({ top: 12, left: 12, width: 1576, height: 976 });
    expect(settingsFrame(null, viewport)).toEqual({ top: 12, left: 12, width: 1576, height: 976 });
  });

  it("uses every pixel of a phone-sized window", () => {
    expect(settingsFrame(null, { width: 390, height: 800 })).toEqual({ top: 0, left: 0, width: 390, height: 800 });
  });
});
