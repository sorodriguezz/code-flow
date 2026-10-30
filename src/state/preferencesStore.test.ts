import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({} as Record<string, string>));
vi.mock("../lib/tauri/commands", () => ({
  getSettings: async () => ({ ...settings }),
  getLockedBranchRules: async () => [],
  setSetting: async (key: string, value: string) => { settings[key] = value; },
}));
vi.mock("./repoStore", () => ({ useRepoStore: { getState: () => ({}) } }));
vi.mock("./windowStore", () => ({ DEFAULT_SATELLITE_LIMIT: 4, useWindowStore: { getState: () => ({ setLimit: () => {} }) } }));
vi.mock("../lib/settingsSync", () => ({ watchSettings: () => {} }));

const { usePreferencesStore } = await import("./preferencesStore");

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
});

describe("reviewer visibility", () => {
  it("is enabled before settings have loaded", () => {
    expect(usePreferencesStore.getInitialState().reviewerEnabled).toBe(true);
  });

  it("is enabled when no preference has been saved", async () => {
    usePreferencesStore.setState({ reviewerEnabled: false });
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().reviewerEnabled).toBe(true);
  });

  it("remembers an explicit choice to hide it, and allows enabling it again", async () => {
    await usePreferencesStore.getState().setReviewerEnabled(false);
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().reviewerEnabled).toBe(false);
    await usePreferencesStore.getState().setReviewerEnabled(true);
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().reviewerEnabled).toBe(true);
  });
});

describe("interface density", () => {
  it("is comfortable before settings load and when nothing is saved", async () => {
    expect(usePreferencesStore.getInitialState().density).toBe("comfortable");
    usePreferencesStore.setState({ density: "compact" });
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().density).toBe("comfortable");
  });

  it("round-trips a choice through the settings row", async () => {
    await usePreferencesStore.getState().setDensity("compact");
    expect(settings.ui_density).toBe("compact");
    usePreferencesStore.setState({ density: "comfortable" });
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().density).toBe("compact");
  });

  it("reads an unknown stored value as comfortable", async () => {
    settings.ui_density = "ultra";
    await usePreferencesStore.getState().init();
    expect(usePreferencesStore.getState().density).toBe("comfortable");
  });
});

describe("density on the root element", () => {
  const fakeRoot = () => {
    const attrs = new Map<string, string>();
    return {
      attrs,
      setAttribute: (k: string, v: string) => void attrs.set(k, v),
      removeAttribute: (k: string) => void attrs.delete(k),
    };
  };

  it("stamps data-density only for compact", async () => {
    const { applyDensity, densityAttribute, normalizeDensity } = await import("./preferencesStore");
    const root = fakeRoot();
    applyDensity("compact", root);
    expect(root.attrs.get("data-density")).toBe("compact");
    applyDensity("comfortable", root);
    expect(root.attrs.has("data-density")).toBe(false);
    expect(densityAttribute("comfortable")).toBeNull();
    expect(normalizeDensity(undefined)).toBe("comfortable");
    expect(normalizeDensity("compact")).toBe("compact");
  });
});
