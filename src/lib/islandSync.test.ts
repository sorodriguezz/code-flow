import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushBeforeIsland,
  islandOpened,
  islandReturned,
  registerIslandApp,
  resetIslandSyncForTests,
} from "./islandSync";

/**
 * An app sent to an island and brought back must show what the island did: the main window drops
 * its copy while the app is out and reads it again on the way back. Reported as "las notas que creé
 * en la isla desaparecen al volver y reaparecen al volver a sacarla".
 */

function fakeStore(loaded: boolean) {
  const store = {
    loaded,
    calls: [] as string[],
    app: {
      isLoaded: () => store.loaded,
      flush: vi.fn(async () => {
        store.calls.push("flush");
      }),
      release: vi.fn(() => {
        store.calls.push("release");
        store.loaded = false;
      }),
      reload: vi.fn(async () => {
        store.calls.push("reload");
        store.loaded = true;
      }),
    },
  };
  return store;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => resetIslandSyncForTests());

describe("islandSync", () => {
  it("flushes and drops a loaded copy when the island opens, and reads it again when it returns", async () => {
    const notes = fakeStore(true);
    registerIslandApp(["notes"], notes.app);

    await flushBeforeIsland("notes");
    islandOpened("notes");
    await settle();
    expect(notes.loaded).toBe(false);

    islandReturned("notes");
    await settle();
    expect(notes.calls).toEqual(["flush", "flush", "release", "reload"]);
    expect(notes.loaded).toBe(true);
  });

  it("leaves alone a store this window never loaded", async () => {
    const flows = fakeStore(false);
    registerIslandApp(["flows"], flows.app);

    await flushBeforeIsland("flows");
    islandOpened("flows");
    islandReturned("flows");
    await settle();
    expect(flows.calls).toEqual([]);
  });

  it("reloads a store with nothing to release, and only the app that came back", async () => {
    const remote = fakeStore(true);
    const agents = fakeStore(true);
    registerIslandApp(["remote"], {
      isLoaded: remote.app.isLoaded,
      reload: remote.app.reload,
    });
    registerIslandApp(["agents"], agents.app);

    islandOpened("remote");
    islandReturned("remote");
    await settle();
    expect(remote.calls).toEqual(["reload"]);
    expect(agents.calls).toEqual([]);
  });

  it("reloads a store this window loaded again while the island was out", async () => {
    const api = fakeStore(false);
    registerIslandApp(["api:requests"], api.app);

    islandOpened("api:requests");
    // Something in the main window — the `.http` lens — needed the client and loaded it.
    api.loaded = true;
    islandReturned("api:requests");
    await settle();
    expect(api.calls).toEqual(["reload"]);
  });
});
