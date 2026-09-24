import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A busy repository means *wait*, not *fail*: a chat turn, an analysis or a fix refused with
 * `REPO_BUSY::` is tried again when a run ends (or on a timer), stays marked as queued while it
 * waits, and a stop while it waits hands the request back untouched.
 */

async function boot() {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: async () => false }));
  vi.doMock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
  const queue = await import("./repoQueue");
  const runs = await import("../state/aiRunStore");
  return { queue, runs };
}

const BUSY = "REPO_BUSY::web";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("whenRepoFree", () => {
  it("waits while the repository is busy, then runs", async () => {
    const { queue, runs } = await boot();
    runs.useAiRunStore.getState().start("holder", { kindKey: "agents.liveKindChat", detail: "¿Dónde?", workspaceId: null, target: { projectId: "p-1" } });
    let attempts = 0;
    const done = queue.whenRepoFree("p-1", "mine", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error(BUSY);
      return "answer";
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.useRepoQueueStore.getState().queued.mine?.holder).toContain("¿Dónde?");
    // The holder finishing is the lease most likely to have been released: try again at once.
    runs.useAiRunStore.getState().finish("holder");
    await vi.advanceTimersByTimeAsync(0);
    // And, with nothing observable finishing, on the timer.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBe("answer");
    expect(attempts).toBe(3);
    expect(queue.useRepoQueueStore.getState().queued.mine).toBeUndefined();
  });

  it("a stop while queued hands the request back as a queued cancellation", async () => {
    const { queue, runs } = await boot();
    const done = queue.whenRepoFree("p-1", "mine", async () => {
      throw new Error(BUSY);
    });
    const outcome = done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    await runs.useAiRunStore.getState().cancel("mine");
    await vi.advanceTimersByTimeAsync(0);
    const error = await outcome;
    expect(queue.isQueuedCancellation(error)).toBe(true);
    expect(runs.isCancellation(error)).toBe(true);
    expect(queue.useRepoQueueStore.getState().queued.mine).toBeUndefined();
  });

  it("any other failure is the caller's, untouched", async () => {
    const { queue } = await boot();
    await expect(
      queue.whenRepoFree("p-1", "mine", async () => {
        throw new Error("quota exceeded");
      }),
    ).rejects.toThrow("quota exceeded");
  });
});
