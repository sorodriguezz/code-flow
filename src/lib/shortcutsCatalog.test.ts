import { describe, expect, it, vi } from "vitest";

/**
 * The Shortcuts section is one pane per command group, and the panes come from the settings catalog.
 * Its old hand-written group list had already fallen behind the table — the API client's, the
 * vault's and the chat's groups were never listed, so four shortcuts could not be rebound at all.
 * These hold the catalog and the table to each other in both directions.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { SHORTCUT_COMMANDS, SHORTCUT_GROUP_LABELS } = await import("./shortcuts");
const { tabsFor } = await import("./settingsCatalog");

const panes = tabsFor("keybindings");

describe("the Shortcuts panes", () => {
  it("give every group that has a command a pane", () => {
    const groups = new Set(SHORTCUT_COMMANDS.map((command) => command.group));
    for (const group of groups) {
      expect(panes.some((pane) => pane.id === group), `no pane for the "${group}" shortcuts`).toBe(true);
    }
  });

  it("are groups, named the way the groups name themselves", () => {
    for (const pane of panes) {
      expect(pane.id in SHORTCUT_GROUP_LABELS, `"${pane.id}" is not a shortcut group`).toBe(true);
      expect(pane.labelKey).toBe(SHORTCUT_GROUP_LABELS[pane.id as keyof typeof SHORTCUT_GROUP_LABELS]);
    }
  });
});
