import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalExecState } from "../lib/tauri/localExecCommands";

/**
 * Every click in Settings › AI assistant › Local model used to wait on a full re-resolution, and the
 * re-resolution on the servers — on Windows, about two seconds for each port nobody listens on. These
 * hold the pane to drawing a click at once, asking the servers again only when the click changed
 * which server it asks, and never letting a slower, older answer overwrite a newer one.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { useLocalExecStore, withChoice } = await import("./localExecStore");
const { LOCAL_EXEC_KEYS } = await import("../lib/tauri/localExecCommands");

function state(patch: Partial<LocalExecState> = {}): LocalExecState {
  return {
    backend: "bundled",
    backend_chosen: true,
    url: "",
    remote: false,
    detected: { ollama: false, ollama_version: null, lmstudio: false },
    reachable: true,
    server_version: null,
    error: null,
    error_code: null,
    models: [],
    model: "qwen2.5-coder-7b-instruct",
    model_chosen: false,
    details: { max_ctx: 32_768, ctx_fixed_by_server: false, kv_bytes_per_token: 57_344, params_b: 7.6, size_bytes: 4_683_073_536, thinking: false },
    ctx: 16_384,
    ctx_chosen: false,
    ctx_options: [8_192, 16_384, 32_768],
    budget: { ctx: 16_384, output: 4_096, input: 11_776 },
    machine: {
      ram_bytes: 34_359_738_368,
      ram_bandwidth: 40e9,
      gpu: "integrated",
      gpu_bytes: null,
      gpu_name: "Intel(R) UHD Graphics 770",
      gpu_bandwidth: null,
    },
    need_bytes: 6_160_000_000,
    also_resident_bytes: 0,
    fit: "comfortable",
    write_tps: 6.6,
    pace: "slow",
    delegate: "medium",
    delegate_suggested: "medium",
    delegate_chosen: false,
    on_fail: "review",
    unload: true,
    review_mode: "local",
    engine: { kind: "off" },
    engine_available: true,
    models_dir: "/tmp/models",
    disk_used: 0,
    has_key: false,
    probe: null,
    pullable: [],
    ...patch,
  } as LocalExecState;
}

/** A promise the test settles by hand — a server that has not answered yet. */
function pending<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const stateCalls = () => calls.filter((call) => call.name === "local_exec_state").map((call) => call.args.fresh);

beforeEach(() => {
  handlers = {};
  calls = [];
  useLocalExecStore.setState({ state: state(), loading: false, refreshing: false, pendingBackend: null, progress: {} });
});

describe("withChoice", () => {
  it("draws each choice the pane reads straight off the setting", () => {
    const base = state();
    expect(withChoice(base, LOCAL_EXEC_KEYS.delegate, "all")).toMatchObject({ delegate: "all", delegate_chosen: true });
    expect(withChoice(base, LOCAL_EXEC_KEYS.onFail, "skip").on_fail).toBe("skip");
    expect(withChoice(base, LOCAL_EXEC_KEYS.reviewMode, "report").review_mode).toBe("report");
    expect(withChoice(base, LOCAL_EXEC_KEYS.unload, "0").unload).toBe(false);
    expect(withChoice(base, LOCAL_EXEC_KEYS.ctx, "32768")).toMatchObject({ ctx: 32_768, ctx_chosen: true });
    expect(withChoice(base, LOCAL_EXEC_KEYS.modelBundled, "qwen2.5-coder-14b-instruct")).toMatchObject({
      model: "qwen2.5-coder-14b-instruct",
      model_chosen: true,
    });
  });

  it("goes back to the suggestion when a choice is cleared", () => {
    const chosen = state({ delegate: "all", delegate_chosen: true, delegate_suggested: "medium", ctx_chosen: true });
    expect(withChoice(chosen, LOCAL_EXEC_KEYS.delegate, "")).toMatchObject({ delegate: "medium", delegate_chosen: false });
    // "Automatic": the window is Rust's to pick; the old one stays drawn until it does.
    expect(withChoice(chosen, LOCAL_EXEC_KEYS.ctx, "")).toMatchObject({ ctx: 16_384, ctx_chosen: false });
  });

  it("leaves alone what it does not know, and another server's model", () => {
    const base = state();
    expect(withChoice(base, LOCAL_EXEC_KEYS.urlOllama, "http://127.0.0.1:11435")).toBe(base);
    expect(withChoice(base, LOCAL_EXEC_KEYS.modelOllama, "qwen3:8b")).toBe(base);
  });
});

describe("set", () => {
  it("shows the click before the backend has answered", async () => {
    const write = pending<void>();
    handlers.set_setting = () => write.promise;
    handlers.local_exec_state = () => state({ delegate: "all", delegate_chosen: true });

    const done = useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.delegate, "all");
    expect(useLocalExecStore.getState().state?.delegate).toBe("all");
    write.settle();
    await done;
    expect(useLocalExecStore.getState().state?.delegate).toBe("all");
  });

  it("asks the servers again only when the click changed which server it asks", async () => {
    handlers.local_exec_state = () => state();
    await useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.ctx, "32768");
    await useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.unload, "0");
    await useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.urlOllama, "http://127.0.0.1:11435");
    await useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.backend, "ollama");
    expect(stateCalls()).toEqual([false, false, true, true]);
  });

  it("moves the server switch at once and keeps the rest until that server answers", async () => {
    const answer = pending<LocalExecState>();
    handlers.local_exec_state = () => answer.promise;

    const done = useLocalExecStore.getState().set(LOCAL_EXEC_KEYS.backend, "ollama");
    await flush();
    expect(useLocalExecStore.getState().pendingBackend).toBe("ollama");
    expect(useLocalExecStore.getState().state?.backend).toBe("bundled");

    answer.settle(state({ backend: "ollama", url: "http://127.0.0.1:11434" }));
    await done;
    expect(useLocalExecStore.getState().pendingBackend).toBeNull();
    expect(useLocalExecStore.getState().state?.backend).toBe("ollama");
  });
});

describe("refresh", () => {
  it("never lets an older answer overwrite a newer one", async () => {
    const slow = pending<LocalExecState>();
    const fast = pending<LocalExecState>();
    const answers = [slow, fast];
    handlers.local_exec_state = () => answers.shift()!.promise;

    const first = useLocalExecStore.getState().refresh(true);
    const second = useLocalExecStore.getState().refresh(false);
    fast.settle(state({ ctx: 32_768 }));
    await second;
    slow.settle(state({ ctx: 8_192 }));
    await first;

    expect(useLocalExecStore.getState().state?.ctx).toBe(32_768);
    expect(useLocalExecStore.getState().refreshing).toBe(false);
  });

  it("asks the servers again when the pane opens", async () => {
    handlers.local_exec_state = () => state();
    await useLocalExecStore.getState().load();
    expect(stateCalls()).toEqual([true]);
  });
});
