import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerSelection, RuntimeInfo } from "../types/containers";

const containersDetect = vi.fn<() => Promise<RuntimeInfo[]>>();
const containersAct = vi.fn<(args: { runtime: string; context: string | null }) => Promise<string>>();

vi.mock("../lib/tauri/containersCommands", () => ({
  containersDetect: () => containersDetect(),
  containersAct: (args: { runtime: string; context: string | null }) => containersAct(args),
  containersList: vi.fn(() => Promise.resolve([])),
  containersNamespaces: vi.fn(() => Promise.resolve([])),
  containersReach: vi.fn(() => Promise.resolve("v1.33.1")),
  containersKubeTest: vi.fn(() => Promise.resolve({ ok: true, version: "v1.34.6", error: null, hint: null })),
  containersKubeOrigins: vi.fn(() => Promise.resolve([])),
  containersForwards: vi.fn(() => Promise.resolve([])),
  containersForwardOpen: vi.fn(),
  containersForwardClose: vi.fn(),
  containersStartRuntime: vi.fn(),
  containersStats: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../lib/tauri/commands", () => ({ getSetting: vi.fn(), setSetting: vi.fn(() => Promise.resolve()) }));
vi.mock("./toastStore", () => ({ pushErrorToast: vi.fn(), pushSuccessToast: vi.fn() }));

const { useContainersStore } = await import("./containersStore");

/** kubectl with two contexts, kubeconfig's current one being `current`. */
const kubernetes = (current: string): RuntimeInfo => ({
  id: "kubernetes",
  provider: null,
  binary: "/usr/local/bin/kubectl",
  version: "v1.33.1",
  serverVersion: null,
  running: true,
  problem: null,
  contexts: [
    { name: "staging", detail: "staging", namespace: "" },
    { name: "prod", detail: "prod", namespace: "" },
  ],
  currentContext: current,
  start: null,
});

const pod = (context: string): ContainerSelection => ({ runtime: "kubernetes", context, namespace: "shop", object: "pods", id: "api-1", name: "api-1" });

describe("an action goes where its rows came from", () => {
  beforeEach(() => {
    containersDetect.mockReset();
    containersAct.mockReset();
    containersAct.mockResolvedValue("");
    // Nothing picked: the panel follows kubeconfig's current context.
    useContainersStore.setState({ runtimes: [kubernetes("staging")], prefs: { open: [], nav: { runtime: "kubernetes", section: "pods" }, context: {}, namespace: {} }, selection: null, busy: {} });
  });

  it("a selection made under a context is let go when a terminal switches it", async () => {
    useContainersStore.getState().select(pod("staging"));
    expect(useContainersStore.getState().selection?.context).toBe("staging");

    containersDetect.mockResolvedValueOnce([kubernetes("staging")]);
    await useContainersStore.getState().detect();
    expect(useContainersStore.getState().selection).not.toBeNull();

    // `kubectl config use-context prod`, in a terminal.
    containersDetect.mockResolvedValueOnce([kubernetes("prod")]);
    await useContainersStore.getState().detect();
    expect(useContainersStore.getState().selection).toBeNull();
  });

  it("a context picked in the panel holds whatever kubeconfig says", async () => {
    useContainersStore.setState({ prefs: { open: [], nav: { runtime: "kubernetes", section: "pods" }, context: { kubernetes: "staging" }, namespace: {} } });
    useContainersStore.getState().select(pod("staging"));
    containersDetect.mockResolvedValueOnce([kubernetes("prod")]);
    await useContainersStore.getState().detect();
    expect(useContainersStore.getState().selection?.context).toBe("staging");
  });

  it("a row of a frame drawn before the switch is not selected", () => {
    useContainersStore.setState({ runtimes: [kubernetes("prod")] });
    useContainersStore.getState().select(pod("staging"));
    expect(useContainersStore.getState().selection).toBeNull();
  });

  it("the action is sent to the context it was given, not the current one", async () => {
    // The pane was opened under staging; kubeconfig moved to prod before the click.
    useContainersStore.setState({ runtimes: [kubernetes("prod")] });
    await useContainersStore.getState().act({ runtime: "kubernetes", context: "staging", object: "pods", action: "delete", ids: ["api-1"], namespace: "shop", label: "Deleted api-1", refresh: [] });
    expect(containersAct).toHaveBeenCalledTimes(1);
    expect(containersAct.mock.calls[0][0].context).toBe("staging");
  });
});

describe("the manager's page", () => {
  const docker: RuntimeInfo = { ...kubernetes("staging"), id: "docker", contexts: [{ name: "orbstack", detail: "", namespace: "" }], currentContext: "orbstack" };

  it("falls back to the first engine that answers when the one remembered is gone", () => {
    useContainersStore.setState({ runtimes: [kubernetes("staging"), docker], prefs: { open: [], nav: { runtime: "podman", section: "images" }, context: {}, namespace: {} } });
    expect(useContainersStore.getState().nav()).toEqual({ runtime: "docker", section: "containers" });
    useContainersStore.setState({ runtimes: [kubernetes("staging")] });
    expect(useContainersStore.getState().nav()).toEqual({ runtime: "kubernetes", section: "pods" });
  });

  it("keeps the page remembered while its runtime is there", () => {
    useContainersStore.setState({ runtimes: [docker], prefs: { open: [], nav: { runtime: "docker", section: "volumes" }, context: {}, namespace: {} } });
    expect(useContainersStore.getState().nav()).toEqual({ runtime: "docker", section: "volumes" });
  });

  it("closes a detail when another page is picked", () => {
    useContainersStore.setState({ runtimes: [docker], prefs: { open: [], nav: { runtime: "docker", section: "containers" }, context: {}, namespace: {} } });
    useContainersStore.getState().select({ runtime: "docker", context: "orbstack", namespace: null, object: "container", id: "abc", name: "web" });
    expect(useContainersStore.getState().selection).not.toBeNull();
    useContainersStore.getState().setNav({ runtime: "docker", section: "images" });
    expect(useContainersStore.getState().selection).toBeNull();
    expect(useContainersStore.getState().prefs.nav.section).toBe("images");
  });
});

describe("a cluster's answer is kept, and disconnecting is the panel's", () => {
  beforeEach(() => {
    useContainersStore.setState({
      runtimes: [kubernetes("staging")],
      prefs: { open: [], nav: { runtime: "kubernetes", section: "pods" }, context: {}, namespace: {} },
      selection: null,
      reach: {},
      kubeTests: {},
      namespaces: {},
      lists: {},
      forwards: [],
    });
  });

  it("asks a cluster once while its answer is fresh, and again when told to", async () => {
    const { containersReach } = await import("../lib/tauri/containersCommands");
    const reach = vi.mocked(containersReach);
    reach.mockClear();
    await useContainersStore.getState().checkReach("staging");
    await useContainersStore.getState().checkReach("staging");
    expect(reach).toHaveBeenCalledTimes(1);
    expect(useContainersStore.getState().reach.staging).toMatchObject({ ok: true, text: "v1.33.1" });
    await useContainersStore.getState().checkReach("staging", { force: true });
    expect(reach).toHaveBeenCalledTimes(2);
  });

  it("asks again once the answer has gone stale", async () => {
    const { containersReach } = await import("../lib/tauri/containersCommands");
    const reach = vi.mocked(containersReach);
    reach.mockClear();
    const { KUBE_CHECK_FRESH_MS } = await import("./containersStore");
    useContainersStore.setState({ reach: { staging: { ok: true, text: "v1.33.1", at: Date.now() - KUBE_CHECK_FRESH_MS - 1 } } });
    await useContainersStore.getState().checkReach("staging");
    expect(reach).toHaveBeenCalledTimes(1);
  });

  it("a connection test answers the navigation's question too", async () => {
    await useContainersStore.getState().testKube("prod");
    expect(useContainersStore.getState().kubeTests.prod).toMatchObject({ testing: false, result: { ok: true, version: "v1.34.6" } });
    expect(useContainersStore.getState().reach.prod).toMatchObject({ ok: true, text: "v1.34.6" });
  });

  it("disconnected, it reads nothing and does not fall back to kubeconfig's current context", async () => {
    useContainersStore.setState({
      lists: { "kubernetes|staging||pods": { rows: [{}], error: null, at: 1, loading: false }, "docker|default||containers": { rows: [], error: null, at: 1, loading: false } },
      forwards: [
        { id: "f1", context: "staging", namespace: "shop", kind: "pod", name: "api-1", localPort: 8080, remotePort: 80, status: "active", error: null },
        { id: "f2", context: "prod", namespace: "shop", kind: "pod", name: "api-1", localPort: 8081, remotePort: 80, status: "active", error: null },
      ],
    });
    const { containersForwardClose } = await import("../lib/tauri/containersCommands");
    const close = vi.mocked(containersForwardClose);
    close.mockClear();
    close.mockResolvedValue(undefined as never);
    useContainersStore.getState().select(pod("staging"));

    await useContainersStore.getState().disconnectKube();
    const state = useContainersStore.getState();
    expect(state.contextOf("kubernetes")).toBeNull();
    expect(state.selection).toBeNull();
    expect(state.prefs.nav).toEqual({ runtime: "kubernetes", section: "overview" });
    expect(Object.keys(state.lists)).toEqual(["docker|default||containers"]);
    // Only the cluster's own port-forwards.
    expect(close.mock.calls.map(([id]) => id)).toEqual(["f1"]);

    // A terminal switching kubeconfig's context does not connect it again; picking a cluster does.
    containersDetect.mockResolvedValueOnce([kubernetes("prod")]);
    await useContainersStore.getState().detect();
    expect(useContainersStore.getState().contextOf("kubernetes")).toBeNull();
    useContainersStore.getState().setContext("kubernetes", "prod");
    expect(useContainersStore.getState().contextOf("kubernetes")).toBe("prod");
  });
});

describe("a disconnected panel stays so across launches", () => {
  it("reads the choice back from its preferences", async () => {
    const { getSetting } = await import("../lib/tauri/commands");
    vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify({ open: [], nav: { runtime: "kubernetes", section: "overview" }, context: {}, namespace: {}, kubeDisconnected: true }));
    useContainersStore.setState({ prefsLoaded: false, runtimes: [kubernetes("staging")] });
    await useContainersStore.getState().loadPrefs();
    expect(useContainersStore.getState().contextOf("kubernetes")).toBeNull();
  });

  it("an answer that lands after the disconnect is not kept", async () => {
    const { containersList } = await import("../lib/tauri/containersCommands");
    let answer: (rows: unknown[]) => void = () => {};
    vi.mocked(containersList).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve as (rows: unknown[]) => void)));
    useContainersStore.setState({ prefs: { open: [], nav: { runtime: "kubernetes", section: "pods" }, context: { kubernetes: "staging" }, namespace: {} }, lists: {}, forwards: [] });
    const read = useContainersStore.getState().refreshList("kubernetes", "pods");
    await useContainersStore.getState().disconnectKube();
    answer([{ name: "api-1" }]);
    await read;
    expect(Object.keys(useContainersStore.getState().lists)).toEqual([]);
  });
});
