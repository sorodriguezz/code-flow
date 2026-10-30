import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Persisting layout, against a fake `set_setting` whose answers can be held back or refused.
 *
 * What these hold down: a failed write keeps the change on screen and says it was not saved (it used
 * to be an unhandled rejection and a layout that quietly reverted on relaunch); and quick successive
 * writes to one row reach the disk in order, so the value the user ended on is the one that stays.
 */

const writes: { key: string; value: string }[] = [];
const releases: (() => void)[] = [];
let failNext = false;
let holdWrites = false;
let stored: Record<string, string> = {};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown> = {}) => {
    if (name === "get_settings") return Promise.resolve({ ...stored });
    if (name !== "set_setting") return Promise.resolve(null);
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("database is locked"));
    }
    const write = { key: String(args.key), value: String(args.value) };
    if (!holdWrites) {
      writes.push(write);
      stored[write.key] = write.value;
      return Promise.resolve(null);
    }
    return new Promise<null>((resolve) =>
      releases.push(() => {
        writes.push(write);
        stored[write.key] = write.value;
        resolve(null);
      }),
    );
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));

const { useLayoutStore } = await import("./layoutStore");
const { useToastStore } = await import("./toastStore");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  writes.length = 0;
  releases.length = 0;
  failNext = false;
  holdWrites = false;
  stored = {};
  useToastStore.setState({ toasts: [] });
  useLayoutStore.setState({ flags: { sidebarCollapsed: false, notesTagsByCount: false }, railOrder: [], repoTabOrder: [] });
});

describe("persisting layout", () => {
  it("restores the repository tab order after reloading settings", async () => {
    const order = ["reviewer", "graph", "changes", "editor"];
    useLayoutStore.getState().setRepoTabOrder(order);
    await flush();
    useLayoutStore.setState({ repoTabOrder: [] });
    await useLayoutStore.getState().init();
    expect(useLayoutStore.getState().repoTabOrder).toEqual(order);
    expect(writes).toEqual([{ key: "layout_repo_tab_order", value: JSON.stringify(order) }]);
  });

  it("uses the default order for invalid saved data", async () => {
    stored.layout_repo_tab_order = "invalid json";
    await useLayoutStore.getState().init();
    expect(useLayoutStore.getState().repoTabOrder).toEqual([]);
  });

  it("keeps a flag flipped when the write fails, and says it was not saved", async () => {
    failNext = true;
    useLayoutStore.getState().toggleFlag("sidebarCollapsed");
    await flush();
    expect(useLayoutStore.getState().flags.sidebarCollapsed).toBe(true);
    expect(useToastStore.getState().toasts.map((toast) => toast.type)).toEqual(["error"]);
  });

  it("lands quick successive writes to one row in order, ending on the last value", async () => {
    holdWrites = true;
    useLayoutStore.getState().setRailOrder(["a"]);
    useLayoutStore.getState().setRailOrder(["b"]);
    useLayoutStore.getState().setRailOrder(["c"]);
    // One write in flight; the other two wait behind it, coalesced to the newest.
    expect(releases).toHaveLength(1);

    releases.shift()?.();
    await flush();
    releases.shift()?.();
    await flush();
    expect(releases).toHaveLength(0);
    expect(writes.map((write) => write.value)).toEqual(['["a"]', '["c"]']);
    expect(useLayoutStore.getState().railOrder).toEqual(["c"]);
  });

  it("writes the next value after a failed one", async () => {
    failNext = true;
    useLayoutStore.getState().commitSize("sidebarWidth", 300);
    useLayoutStore.getState().commitSize("sidebarWidth", 320);
    await flush();
    expect(writes).toEqual([{ key: "layout_sidebar_width", value: "320" }]);
  });
});
