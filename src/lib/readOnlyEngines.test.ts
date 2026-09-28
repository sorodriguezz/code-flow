import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.fn<() => Promise<string[]>>();
vi.mock("./tauri/commands", () => ({ aiReadOnlyEngines: () => probe() }));

describe("readOnlyEngines", () => {
  beforeEach(() => {
    vi.resetModules();
    probe.mockReset();
  });

  it("asks the backend once per window and keeps its answer", async () => {
    probe.mockResolvedValue(["claude", "codex", "grok"]);
    const { readOnlyEngines } = await import("./readOnlyEngines");
    expect(await readOnlyEngines()).toEqual(["claude", "codex", "grok"]);
    expect(await readOnlyEngines()).toEqual(["claude", "codex", "grok"]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("answers 'none' when the probe fails, and asks again next time", async () => {
    // Saying a guarantee is only a request is the smaller lie of the two.
    probe.mockRejectedValueOnce(new Error("no backend")).mockResolvedValueOnce(["claude"]);
    const { readOnlyEngines } = await import("./readOnlyEngines");
    expect(await readOnlyEngines()).toEqual([]);
    expect(await readOnlyEngines()).toEqual(["claude"]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
