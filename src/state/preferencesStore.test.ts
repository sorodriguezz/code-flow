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
