import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A language picked by hand from the Editor's status line is a setting: it has to come back from
 * disk, survive a corrupt row, and be written the moment it is picked.
 */

let settings: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: { keys?: string[]; key?: string; value?: string }) => {
    if (name === "get_settings") {
      return Object.fromEntries((args.keys ?? []).filter((key) => key in settings).map((key) => [key, settings[key]]));
    }
    if (name === "set_setting" && args.key) settings[args.key] = args.value ?? "";
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { extensionOf, useLanguageOverrideStore } = await import("./languageOverrideStore");

describe("languageOverrideStore", () => {
  beforeEach(() => {
    settings = {};
    useLanguageOverrideStore.setState({ files: {}, extensions: {} });
  });

  it("reads both scopes back, and a corrupt row as empty rather than as a crash", async () => {
    settings = {
      editor_file_languages: JSON.stringify({ "cfmodel://p-1/config": "ini" }),
      editor_extension_languages: "{not json",
    };
    await useLanguageOverrideStore.getState().init();
    expect(useLanguageOverrideStore.getState().files).toEqual({ "cfmodel://p-1/config": "ini" });
    expect(useLanguageOverrideStore.getState().extensions).toEqual({});
  });

  it("writes a pick through, and `null` takes it back out", async () => {
    const store = useLanguageOverrideStore.getState();
    await store.setFileLanguage("cfmodel://p-1/a.conf", "ini");
    await store.setExtensionLanguage(".CONF", "ini");
    expect(JSON.parse(settings.editor_file_languages)).toEqual({ "cfmodel://p-1/a.conf": "ini" });
    // Extensions are filed lower-cased, so `.CONF` and `.conf` are one association.
    expect(JSON.parse(settings.editor_extension_languages)).toEqual({ ".conf": "ini" });

    await useLanguageOverrideStore.getState().setFileLanguage("cfmodel://p-1/a.conf", null);
    expect(JSON.parse(settings.editor_file_languages)).toEqual({});
  });

  it("names an extension only where there is one", () => {
    expect(extensionOf("src/a.TS")).toBe(".ts");
    expect(extensionOf("nginx/site.conf")).toBe(".conf");
    expect(extensionOf("Dockerfile")).toBeNull();
    expect(extensionOf(".env")).toBeNull();
  });
});
