import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedPr } from "./prWatchStore";

/**
 * "Waiting on you" is written to disk per workspace, and the first write of a session used to
 * happen before anything had been read — so opening a pull request (a link review in particular,
 * which never even asked for the read) replaced the saved backlog with that one entry.
 */

let settings: Record<string, string> = {};
let written: Record<string, string> = {};

function entry(prId: number, at: number): TrackedPr {
  return {
    key: `p-1:${prId}`,
    kind: "project",
    projectId: "p-1",
    workspaceId: "ws-1",
    prId,
    title: `PR ${prId}`,
    repoLabel: "",
    pr: {
      id: prId,
      title: `PR ${prId}`,
      description: "",
      status: "open",
      source_branch: "feature",
      target_branch: "main",
      author: "ana",
      created_at: "2026-09-23T10:00:00Z",
      url: `https://git.example.com/acme/web/pull/${prId}`,
      provider: "github",
    },
    decision: "none",
    reviewed: false,
    at,
  };
}

async function boot() {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: async (name: string, args: { key: string; value?: string }) => {
      if (name === "get_setting") return settings[args.key] ?? null;
      if (name === "set_setting") written[args.key] = args.value ?? "";
      return null;
    },
  }));
  return import("./prWatchStore");
}

beforeEach(() => {
  settings = {};
  written = {};
});

describe("prWatchStore", () => {
  it("tracking before the list was read keeps the saved backlog", async () => {
    settings["pr_watchlist_ws-1"] = JSON.stringify([entry(1, 100), entry(2, 90), entry(3, 80)]);
    const { usePrWatchStore } = await boot();
    // No `load` first — exactly what a link review did on mount.
    usePrWatchStore.getState().track(entry(9, 200));
    await vi.waitFor(() => expect(written["pr_watchlist_ws-1"]).toBeDefined());
    const saved = (JSON.parse(written["pr_watchlist_ws-1"]) as TrackedPr[]).map((e) => e.prId);
    expect(saved).toEqual([9, 1, 2, 3]);
  });

  it("untracking before the read removes only that entry", async () => {
    settings["pr_watchlist_ws-1"] = JSON.stringify([entry(1, 100), entry(2, 90)]);
    const { usePrWatchStore } = await boot();
    usePrWatchStore.getState().untrack("ws-1", "p-1:2");
    await vi.waitFor(() => expect(written["pr_watchlist_ws-1"]).toBeDefined());
    expect((JSON.parse(written["pr_watchlist_ws-1"]) as TrackedPr[]).map((e) => e.prId)).toEqual([1]);
  });

  it("applies writes in the order they were asked for", async () => {
    const { usePrWatchStore } = await boot();
    usePrWatchStore.getState().track(entry(5, 100));
    usePrWatchStore.getState().untrack("ws-1", "p-1:5");
    await vi.waitFor(() => expect(written["pr_watchlist_ws-1"]).toBe("[]"));
    expect(usePrWatchStore.getState().byWorkspace["ws-1"]).toEqual([]);
  });
});
