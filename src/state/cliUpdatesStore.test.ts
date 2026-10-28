import { beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({
  cliUpdatesCheck: vi.fn(),
  cliUpdatesInstall: vi.fn(),
  cliUpdatesSkip: vi.fn(),
}));
vi.mock("../lib/tauri/commands", () => commands);
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("./powerSaveStore", () => ({ saving: () => false }));

import { useCliUpdatesStore } from "./cliUpdatesStore";

const claude = { provider: "claude", label: "Claude", binary: "claude", installed: "2.1.310", latest: "2.1.312" };
const grok = { provider: "grok", label: "Grok", binary: "grok", installed: "1.0.62", latest: "1.0.70" };
const done = { provider: "claude", outcome: "done", versionAfter: "2.1.312", errorKind: null, reference: null, details: "" };

beforeEach(() => {
  vi.useRealTimers();
  Object.values(commands).forEach((fn) => fn.mockReset());
  commands.cliUpdatesSkip.mockResolvedValue(undefined);
  useCliUpdatesStore.setState({ cards: {}, closed: {} });
});

describe("cliUpdatesStore", () => {
  it("shows a card per CLI with a newer version", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude, grok]);
    await useCliUpdatesStore.getState().check();
    expect(Object.keys(useCliUpdatesStore.getState().cards)).toEqual(["claude", "grok"]);
    expect(useCliUpdatesStore.getState().cards.claude.state).toBe("available");
  });

  it("a failed check shows nothing and raises no error", async () => {
    commands.cliUpdatesCheck.mockRejectedValue(new Error("offline"));
    await useCliUpdatesStore.getState().check();
    expect(useCliUpdatesStore.getState().cards).toEqual({});
  });

  it("closing a card hides it until a forced check, and does nothing else", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    useCliUpdatesStore.getState().close("claude");
    expect(useCliUpdatesStore.getState().cards).toEqual({});
    await useCliUpdatesStore.getState().check();
    expect(useCliUpdatesStore.getState().cards).toEqual({});
    expect(commands.cliUpdatesSkip).not.toHaveBeenCalled();
    await useCliUpdatesStore.getState().check(true);
    expect(useCliUpdatesStore.getState().cards.claude).toBeDefined();
  });

  it("skipping remembers the version the card showed", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    useCliUpdatesStore.getState().skip("claude");
    expect(commands.cliUpdatesSkip).toHaveBeenCalledWith("claude", "2.1.312");
    expect(useCliUpdatesStore.getState().cards).toEqual({});
  });

  it("installs with the version the card showed, and a success closes the card after a moment", async () => {
    vi.useFakeTimers();
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    commands.cliUpdatesInstall.mockResolvedValue(done);
    await useCliUpdatesStore.getState().install("claude");
    expect(commands.cliUpdatesInstall).toHaveBeenCalledWith("claude", "2.1.310");
    expect(useCliUpdatesStore.getState().cards.claude.state).toBe("done");
    vi.advanceTimersByTime(4_100);
    expect(useCliUpdatesStore.getState().cards.claude).toBeUndefined();
  });

  it("waits, then tries again, while a task is still running", async () => {
    vi.useFakeTimers();
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    commands.cliUpdatesInstall.mockResolvedValueOnce({ ...done, outcome: "busy", versionAfter: "" });
    await useCliUpdatesStore.getState().install("claude");
    expect(useCliUpdatesStore.getState().cards.claude.state).toBe("waiting");
    commands.cliUpdatesInstall.mockResolvedValueOnce(done);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(commands.cliUpdatesInstall).toHaveBeenCalledTimes(2);
    expect(useCliUpdatesStore.getState().cards.claude.state).toBe("done");
  });

  it("a failure keeps the card, with what the backend said about it", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    commands.cliUpdatesInstall.mockResolvedValue({
      ...done,
      outcome: "failed",
      errorKind: "permission",
      reference: "errno/EACCES",
      details: "npm error code EACCES",
    });
    await useCliUpdatesStore.getState().install("claude");
    const card = useCliUpdatesStore.getState().cards.claude;
    expect(card.state).toBe("failed");
    expect(card.result?.reference).toBe("errno/EACCES");
  });

  it("a command that throws is a failed card, not an unhandled rejection", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude]);
    await useCliUpdatesStore.getState().check();
    commands.cliUpdatesInstall.mockRejectedValue(new Error("ipc down"));
    await useCliUpdatesStore.getState().install("claude");
    expect(useCliUpdatesStore.getState().cards.claude.state).toBe("failed");
  });

  it("'update all' goes one CLI at a time", async () => {
    commands.cliUpdatesCheck.mockResolvedValue([claude, grok]);
    await useCliUpdatesStore.getState().check();
    const order: string[] = [];
    let running = 0;
    let overlapped = false;
    commands.cliUpdatesInstall.mockImplementation(async (provider: string) => {
      running += 1;
      overlapped ||= running > 1;
      order.push(provider);
      await Promise.resolve();
      running -= 1;
      return { ...done, provider };
    });
    await useCliUpdatesStore.getState().installAll();
    expect(order).toEqual(["claude", "grok"]);
    expect(overlapped).toBe(false);
  });
});
