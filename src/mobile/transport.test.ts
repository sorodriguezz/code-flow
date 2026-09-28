import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The phone's request layer: every call has a deadline, every mutating call an idempotency key that
 * survives the retry of a call whose answer never came, and a pairing carried across from the old
 * `http://` address is adopted — once, and never over a pairing this origin already has.
 *
 * Each test loads a fresh copy of the module: the keys of unanswered calls are module state.
 */

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}

const ok = (value: unknown = null) =>
  new Response(JSON.stringify({ ok: true, value }), { status: 200, headers: { "content-type": "application/json" } });

let storage: ReturnType<typeof memoryStorage>;
let fetchMock: ReturnType<typeof vi.fn>;

async function load() {
  vi.resetModules();
  return import("./transport");
}

/** The idempotency key a call went out with, or `undefined`. */
function keyOf(call: number): string | undefined {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return (init.headers as Record<string, string>)["idempotency-key"];
}

beforeEach(() => {
  storage = memoryStorage({ "codeflow.remote.token": "device-token" });
  fetchMock = vi.fn(async () => ok());
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("rpc", () => {
  it("keys the calls that change something, and only those", async () => {
    const { rpc } = await load();
    await rpc("get_status", { repoPath: "/r" });
    await rpc("commit", { repoPath: "/r", message: "m" });
    expect(keyOf(0)).toBeUndefined();
    expect(keyOf(1)).toMatch(/^[0-9a-f-]{16,}$/);
  });

  it("reuses the key of a call that timed out, so the retry cannot run it twice", async () => {
    vi.useFakeTimers();
    const { rpc, TimedOut, timeoutFor } = await load();
    fetchMock.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const args = { projectId: "p", prId: 7, runId: "r", items: [] };
    const first = rpc("post_pr_review_comment", args);
    const failure = expect(first).rejects.toBeInstanceOf(TimedOut);
    await vi.advanceTimersByTimeAsync(timeoutFor("post_pr_review_comment"));
    await failure;

    await rpc("post_pr_review_comment", args);
    expect(keyOf(1)).toBe(keyOf(0));

    // Answered now, so the same button pressed again is a new intent with a new key.
    await rpc("post_pr_review_comment", args);
    expect(keyOf(2)).not.toBe(keyOf(1));
  });

  it("sends a keyed call once more when the connection failed before any answer", async () => {
    vi.useFakeTimers();
    const { rpc } = await load();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(ok("abc123"));
    const pending = rpc<string>("commit", { repoPath: "/r", message: "m" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("abc123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("does not resend a read, and keeps the key of a keyed call whose retry failed too", async () => {
    vi.useFakeTimers();
    const { rpc } = await load();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(rpc("list_branches", { repoPath: "/r" })).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const push = rpc("git_push", { repoPath: "/r", setUpstream: true });
    const failure = expect(push).rejects.toThrow("Failed to fetch");
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    fetchMock.mockResolvedValue(ok());
    await rpc("git_push", { repoPath: "/r", setUpstream: true });
    expect(keyOf(3)).toBe(keyOf(1));
  });

  it("gives an engine minutes and a LAN read one", async () => {
    const { timeoutFor } = await load();
    expect(timeoutFor("review_pull_request")).toBeGreaterThanOrEqual(10 * 60_000);
    expect(timeoutFor("git_push")).toBeGreaterThan(timeoutFor("get_status"));
    expect(timeoutFor("get_status")).toBe(60_000);
  });

  it("forgets the token on a 401 and on nothing else", async () => {
    const { rpc, Unpaired } = await load();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "tls_required" }), { status: 503 }));
    await expect(rpc("get_status", {})).rejects.toThrow("tls_required");
    expect(storage.values.get("codeflow.remote.token")).toBe("device-token");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 }));
    await expect(rpc("get_status", {})).rejects.toBeInstanceOf(Unpaired);
    expect(storage.values.has("codeflow.remote.token")).toBe(false);
  });
});

describe("adoptHandoff", () => {
  function at(hash: string) {
    const replaceState = vi.fn();
    vi.stubGlobal("location", { hash, pathname: "/", search: "" });
    vi.stubGlobal("history", { state: null, replaceState });
    return replaceState;
  }

  const carried = (pairing: Record<string, string>) => `#cf-handoff=${encodeURIComponent(JSON.stringify(pairing))}`;

  it("adopts the pairing the plain page carried over, and wipes it from the address", async () => {
    storage.values.clear();
    const replaceState = at(carried({ t: "tok", n: "iPhone", d: "dev-1" }));
    const { adoptHandoff, storedToken, storedDeviceId, storedName } = await load();
    adoptHandoff();
    expect(storedToken()).toBe("tok");
    expect(storedDeviceId()).toBe("dev-1");
    expect(storedName()).toBe("iPhone");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });

  it("never replaces a pairing this origin already has", async () => {
    const replaceState = at(carried({ t: "someone-else", n: "x", d: "y" }));
    const { adoptHandoff, storedToken } = await load();
    adoptHandoff();
    expect(storedToken()).toBe("device-token");
    expect(replaceState).toHaveBeenCalled();
  });

  it("ignores a fragment it did not write", async () => {
    storage.values.clear();
    at("#cf-handoff=%7Bnot-json");
    const { adoptHandoff, storedToken } = await load();
    adoptHandoff();
    expect(storedToken()).toBeNull();

    const untouched = at("#section");
    adoptHandoff();
    expect(untouched).not.toHaveBeenCalled();
  });
});
