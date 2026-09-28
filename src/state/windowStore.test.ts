import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The satellite limit. The hotkey ask box is hidden, not closed, between uses — "open" all session —
 * so counting it made a limit of four windows mean three.
 */

const opened: string[] = [];
const toasts: string[] = [];

vi.mock("../lib/tauri/windows", () => ({
  focusSatellite: async () => {},
  listSatellites: async () => [],
  openSatellite: async (_kind: string, refId: string) => {
    opened.push(refId);
    return `sat-app-${refId}`;
  },
}));
vi.mock("./toastStore", () => ({ pushErrorToast: (message: string) => toasts.push(message) }));
vi.mock("./languageStore", () => ({ translate: (key: string) => key }));
vi.mock("./workspaceStore", () => ({ useWorkspaceStore: { getState: () => ({ activeWorkspaceId: "ws-1" }) } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { countedSatellites, useWindowStore } = await import("./windowStore");

const sat = (label: string, kind: "app" | "repo" | "quick", ref_id: string) => ({ label, kind, ref_id, title: "" });

beforeEach(() => {
  opened.length = 0;
  toasts.length = 0;
});

describe("the satellite limit", () => {
  it("does not count the hotkey ask box", async () => {
    useWindowStore.setState({
      satellites: [sat("sat-app-notes", "app", "notes"), sat("sat-quick-ask", "quick", "ask")],
      limit: 2,
    });
    expect(countedSatellites(useWindowStore.getState().satellites)).toBe(1);
    expect(await useWindowStore.getState().detach("app", "agents", "Agents")).toBe(true);
    expect(opened).toEqual(["agents"]);
    expect(toasts).toEqual([]);
  });

  it("still refuses once the real windows reach it", async () => {
    useWindowStore.setState({
      satellites: [
        sat("sat-app-notes", "app", "notes"),
        sat("sat-repo-p1", "repo", "p1"),
        sat("sat-quick-ask", "quick", "ask"),
      ],
      limit: 2,
    });
    expect(await useWindowStore.getState().detach("app", "agents", "Agents")).toBe(false);
    expect(opened).toEqual([]);
    expect(toasts).toEqual(["windows.limitReached"]);
  });
});
