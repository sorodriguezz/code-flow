import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The API client's refreshes, against a fake backend whose answers can be held back.
 *
 * What these hold down: a refresh asked in one workspace that answers after a switch is dropped,
 * rather than leaving the store saying B while holding A's collections, environments, history or
 * cookies — and the same after A → B → A, where the workspace id matches again but the answer was
 * asked under the first visit and would overwrite what the second one loaded.
 */

type Args = Record<string, unknown>;

/** Per command, the answers still to be released; a held call resolves only when the test says so. */
const held: Record<string, ((value: unknown) => void)[]> = {};
let holding: Set<string> = new Set();

/** What each command answers, as a function of its workspace — so a stale answer is recognisable. */
function answer(name: string, args: Args): unknown {
  const ws = String(args.workspaceId ?? "");
  switch (name) {
    case "api_load_tree":
      return { collections: [{ id: `col-${ws}`, name: ws }], folders: [], requests: [] };
    case "api_list_environments":
      return [{ id: `env-${ws}`, name: ws }];
    case "api_list_history_meta":
      return [{ id: `hist-${ws}` }];
    case "api_list_cookies":
      return [{ id: `cookie-${ws}` }];
    default:
      return null;
  }
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Args = {}) => {
    if (holding.has(name)) {
      return new Promise((resolve) => {
        (held[name] ??= []).push(() => resolve(answer(name, args)));
      });
    }
    return Promise.resolve(answer(name, args));
  },
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

// `setWorkspace` refreshes the conflict list after loading; that store's own backend is not the
// subject here.
vi.mock("./collabStore", () => ({
  useCollabStore: { getState: () => ({ refresh: () => Promise.resolve() }) },
}));

const { useApiStore } = await import("./apiStore");

/** Lets the next call to `name` hang until `release(name)`. */
const hold = (name: string) => holding.add(name);

/** Answers the oldest held call to `name`, then lets the microtasks it schedules run. */
async function release(name: string) {
  const resolve = held[name]?.shift();
  if (!resolve) throw new Error(`nothing held for ${name}`);
  resolve(undefined);
  await new Promise((r) => setTimeout(r, 0));
}

let resets = 0;

beforeEach(async () => {
  holding = new Set();
  for (const key of Object.keys(held)) delete held[key];
  // The store dedupes a switch to the workspace it is already loading or loaded (`pendingLoad`, a
  // module latch). Passing through a workspace no test uses is what makes each test's first switch
  // to A a real load.
  await useApiStore.getState().setWorkspace(`reset-${resets++}`);
  useApiStore.setState({
    workspaceId: null,
    loading: false,
    collections: [],
    environments: [],
    history: [],
    cookies: [],
  });
});

/** Every refresh, its command, and how to read what it wrote. */
const REFRESHES = [
  { name: "reloadTree", command: "api_load_tree", read: () => useApiStore.getState().collections[0]?.id, prefix: "col" },
  {
    name: "reloadEnvironments",
    command: "api_list_environments",
    read: () => useApiStore.getState().environments[0]?.id,
    prefix: "env",
  },
  { name: "reloadHistory", command: "api_list_history_meta", read: () => useApiStore.getState().history[0]?.id, prefix: "hist" },
  { name: "reloadCookies", command: "api_list_cookies", read: () => useApiStore.getState().cookies[0]?.id, prefix: "cookie" },
] as const;

describe("a refresh answering after a workspace switch", () => {
  for (const refresh of REFRESHES) {
    it(`${refresh.name}: drops A's answer once the store is on B`, async () => {
      await useApiStore.getState().setWorkspace("A");
      expect(refresh.read()).toBe(`${refresh.prefix}-A`);

      hold(refresh.command);
      const pending = useApiStore.getState()[refresh.name]();
      holding.delete(refresh.command);

      await useApiStore.getState().setWorkspace("B");
      expect(refresh.read()).toBe(`${refresh.prefix}-B`);

      await release(refresh.command);
      await pending;
      expect(useApiStore.getState().workspaceId).toBe("B");
      expect(refresh.read()).toBe(`${refresh.prefix}-B`);
    });

    it(`${refresh.name}: drops the first visit's answer after A → B → A`, async () => {
      await useApiStore.getState().setWorkspace("A");

      hold(refresh.command);
      const pending = useApiStore.getState()[refresh.name]();
      holding.delete(refresh.command);

      await useApiStore.getState().setWorkspace("B");
      await useApiStore.getState().setWorkspace("A");
      // What the second visit loaded, marked so the first visit's answer would be visible if taken.
      useApiStore.setState({
        collections: [{ id: "col-A2" } as never],
        environments: [{ id: "env-A2" } as never],
        history: [{ id: "hist-A2" } as never],
        cookies: [{ id: "cookie-A2" } as never],
      });

      await release(refresh.command);
      await pending;
      expect(refresh.read()).toBe(`${refresh.prefix}-A2`);
    });
  }

  it("still applies an answer when nothing moved", async () => {
    await useApiStore.getState().setWorkspace("A");
    useApiStore.setState({ collections: [] });
    hold("api_load_tree");
    const pending = useApiStore.getState().reloadTree();
    await release("api_load_tree");
    await pending;
    expect(useApiStore.getState().collections[0]?.id).toBe("col-A");
  });

  it("drops the first visit's initial load after A → B → A", async () => {
    hold("api_load_tree");
    const first = useApiStore.getState().setWorkspace("A");
    // Let `init` reach the held tree read.
    await new Promise((r) => setTimeout(r, 0));
    holding.delete("api_load_tree");

    await useApiStore.getState().setWorkspace("B");
    await useApiStore.getState().setWorkspace("A");
    useApiStore.setState({ collections: [{ id: "col-A2" } as never] });

    await release("api_load_tree");
    await first;
    expect(useApiStore.getState().collections[0]?.id).toBe("col-A2");
  });
});
