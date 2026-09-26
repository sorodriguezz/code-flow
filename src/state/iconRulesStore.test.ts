import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The profile list is one settings row that several builds of the app may read and write. These pin
 * the three things that decide whether a pack can go missing for good: what a stored list missing
 * packs gets back, what a deletion writes down first, and what an unreadable row is left as.
 */

let settings: Record<string, string> = {};
/** Every key written, in order. */
let writes: string[] = [];
let failReads = false;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: { key?: string; value?: string }) => {
    if (name === "get_setting") {
      if (failReads) throw new Error("database is locked");
      return args.key !== undefined && args.key in settings ? settings[args.key] : null;
    }
    if (name === "set_setting" && args.key !== undefined) {
      settings[args.key] = args.value ?? "";
      writes.push(args.key);
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useIconRulesStore } = await import("./iconRulesStore");
const { BUILT_IN_PROFILES } = await import("../lib/icons/profiles");

const ALL = BUILT_IN_PROFILES.map((profile) => profile.id);
const ref = (id: string, name: string) => ({ id, name, defaultFolderIcon: null, shipped: true });
const storedIds = () => (JSON.parse(settings.editor_icon_profiles) as { id: string }[]).map((entry) => entry.id);

describe("iconRulesStore", () => {
  beforeEach(() => {
    settings = {};
    writes = [];
    failReads = false;
    useIconRulesStore.setState({ profiles: BUILT_IN_PROFILES, activeId: "base", loaded: false, repoPath: null });
  });

  // The rows a real install was left with on 2026-09-24 — an older build had rewritten the list with
  // its three packs, while `offered` still named all eleven.
  it("gives back the packs an older build dropped, and starts the deletion record empty", async () => {
    settings = {
      editor_icon_profiles: JSON.stringify([ref("angular", "Angular"), ref("nestjs", "NestJS"), ref("base", "General")]),
      editor_icon_profiles_offered: JSON.stringify(ALL),
    };
    await useIconRulesStore.getState().init();
    expect(storedIds().sort()).toEqual([...ALL].sort());
    expect(useIconRulesStore.getState().profiles).toHaveLength(ALL.length);
    expect(JSON.parse(settings.editor_icon_profiles_removed)).toEqual([]);
    // The record before the list, so the re-read that write triggers already knows it.
    expect(writes.indexOf("editor_icon_profiles_removed")).toBeLessThan(writes.indexOf("editor_icon_profiles"));
  });

  it("writes a deleted pack down before the list without it, and keeps it deleted", async () => {
    await useIconRulesStore.getState().init();
    writes = [];
    await useIconRulesStore.getState().removeProfile("react");
    expect(JSON.parse(settings.editor_icon_profiles_removed)).toEqual(["react"]);
    expect(writes.indexOf("editor_icon_profiles_removed")).toBeLessThan(writes.indexOf("editor_icon_profiles"));

    await useIconRulesStore.getState().init();
    expect(storedIds()).not.toContain("react");
    expect(useIconRulesStore.getState().profiles.some((profile) => profile.id === "react")).toBe(false);
  });

  it("never writes over a row it cannot read", async () => {
    settings = { editor_icon_profiles: JSON.stringify([{ id: "svelte", name: "Svelte", shipped: true }]) };
    await useIconRulesStore.getState().init();
    expect(writes).toEqual([]);
    expect(useIconRulesStore.getState().loaded).toBe(true);

    settings = { editor_icon_profiles: JSON.stringify([ref("base", "General")]) };
    failReads = true;
    await useIconRulesStore.getState().init();
    expect(writes).toEqual([]);
  });
});
