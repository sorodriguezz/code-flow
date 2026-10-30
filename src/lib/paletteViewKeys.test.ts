import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));

import { SHORTCUT_BY_ID } from "./shortcuts";
import { VIEW_ITEMS, viewRowKeys, viewShortcutId } from "./paletteItems";

describe("palette view rows → shortcut ids", () => {
  it("maps every view row to a real shortcut, or to none (toolbox only)", () => {
    for (const row of VIEW_ITEMS) {
      const id = viewShortcutId(row.id, row.workspace);
      if (id) expect(SHORTCUT_BY_ID.has(id)).toBe(true);
      else expect(row.id).toBe("toolbox");
    }
  });

  it("splits the API tab's two halves", () => {
    expect(viewShortcutId("api", "requests")).toBe("view.api");
    expect(viewShortcutId("api", "database")).toBe("view.database");
  });

  it("shows the default chord, the user's rebinding, and nothing for a cleared or missing one", () => {
    expect(viewRowKeys("graph", undefined, {})?.length).toBeGreaterThan(0);
    expect(viewRowKeys("graph", undefined, { "view.graph": "Mod+Shift+9" })?.slice(-1)[0]).toBe("9");
    expect(viewRowKeys("graph", undefined, { "view.graph": null })).toBeUndefined();
    expect(viewRowKeys("toolbox", undefined, {})).toBeUndefined();
  });
});
