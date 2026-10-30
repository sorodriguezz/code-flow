import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: nativeInvoke }));

import { invoke, setInvokeObserver } from "./invoke";

describe("application IPC observation", () => {
  beforeEach(() => {
    nativeInvoke.mockReset();
    setInvokeObserver(null);
  });

  it("preserves the promise, arguments, options and result of the public Tauri API", async () => {
    const result = { id: "connection" };
    const pending = Promise.resolve(result);
    nativeInvoke.mockReturnValue(pending);
    const observer = vi.fn();
    setInvokeObserver(observer);
    const args = { connectionId: "connection" };
    const options = { headers: { "X-Test": "true" } };

    expect(invoke("db_connect", args, options)).toBe(pending);
    expect(await pending).toBe(result);
    expect(nativeInvoke).toHaveBeenCalledWith("db_connect", args, options);
    expect(observer).toHaveBeenCalledWith("db_connect", args, true, result);
  });

  it("preserves a rejected command and reports its failure once", async () => {
    const failure = new Error("connection failed");
    nativeInvoke.mockRejectedValue(failure);
    const observer = vi.fn();
    setInvokeObserver(observer);

    await expect(invoke("db_connect")).rejects.toBe(failure);
    expect(observer).toHaveBeenCalledExactlyOnceWith("db_connect", {}, false, undefined);
  });

  it.each([true, false])("isolates a broken observer from a command with success=%s", async (ok) => {
    const failure = new Error("backend refused");
    nativeInvoke.mockImplementation(() => ok ? Promise.resolve("saved") : Promise.reject(failure));
    setInvokeObserver(() => { throw new Error("statistics failed"); });

    const pending = invoke("write_editor_file");
    if (ok) expect(await pending).toBe("saved");
    else await expect(pending).rejects.toBe(failure);
    // Flush the observation branch too: an unhandled rejection would fail this test run.
    await Promise.resolve();
  });

  it("does not observe plugin commands or commands made before tracking starts", async () => {
    nativeInvoke.mockResolvedValue(null);
    await invoke("db_connect");
    const observer = vi.fn();
    setInvokeObserver(observer);
    await invoke("plugin:event|listen");
    expect(observer).not.toHaveBeenCalled();
  });
});
