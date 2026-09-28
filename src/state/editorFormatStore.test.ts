import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  rows: {} as Record<string, string>,
  getSettings: vi.fn(async (keys: string[]) =>
    Object.fromEntries(keys.filter((key) => key in settings.rows).map((key) => [key, settings.rows[key]])),
  ),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.rows[key] = value;
  }),
}));
const watched = vi.hoisted(() => ({ reload: null as null | (() => unknown), keys: [] as string[] }));

vi.mock("../lib/tauri/commands", () => ({ getSettings: settings.getSettings, setSetting: settings.setSetting }));
vi.mock("../lib/settingsSync", () => ({
  watchSettings: (keys: string[], reload: () => unknown) => {
    watched.keys = keys;
    watched.reload = reload;
  },
}));

const { useEditorFormatStore } = await import("./editorFormatStore");

beforeEach(() => {
  settings.rows = {};
  settings.getSettings.mockClear();
});

describe("format on save", () => {
  it("is off until turned on, and reads the row once however often it is asked", async () => {
    await useEditorFormatStore.getState().init();
    await useEditorFormatStore.getState().init();
    expect(useEditorFormatStore.getState().formatOnSave).toBe(false);
    expect(settings.getSettings).toHaveBeenCalledTimes(1);
  });

  it("writes its row, and follows a change made in another window", async () => {
    await useEditorFormatStore.getState().setFormatOnSave(true);
    expect(settings.rows.editor_format_on_save).toBe("true");
    expect(watched.keys).toEqual(["editor_format_on_save"]);

    settings.rows.editor_format_on_save = "false";
    await watched.reload?.();
    expect(useEditorFormatStore.getState().formatOnSave).toBe(false);
  });
});
