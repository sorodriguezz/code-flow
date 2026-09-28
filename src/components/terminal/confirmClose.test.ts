import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Closing a terminal tab ends everything it started, so a tab running something asks first — and a
 * shell at its prompt, or one already gone, closes without a word.
 */

let foreground: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string) => {
    if (name === "terminal_foreground") {
      if (foreground === "gone") throw "no such terminal session";
      return foreground;
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { confirmCloseTerminal } = await import("./confirmClose");
const { useConfirmStore } = await import("../../state/confirmStore");

/** Lets the pending `invoke` resolve and the question be asked. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("confirmCloseTerminal", () => {
  beforeEach(() => useConfirmStore.setState({ request: null }));

  it("closes an idle shell, or a session already gone, without asking", async () => {
    foreground = null;
    await expect(confirmCloseTerminal("t1")).resolves.toBe(true);
    foreground = "gone";
    await expect(confirmCloseTerminal("t1")).resolves.toBe(true);
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("names what is running and waits for the answer", async () => {
    foreground = "node";
    const answer = confirmCloseTerminal("t1");
    await tick();
    const request = useConfirmStore.getState().request;
    expect(request?.message).toContain("node");
    expect(request?.danger).toBe(true);
    useConfirmStore.getState().respond(false);
    await expect(answer).resolves.toBe(false);

    const again = confirmCloseTerminal("t1");
    await tick();
    useConfirmStore.getState().respond(true);
    await expect(again).resolves.toBe(true);
  });
});
