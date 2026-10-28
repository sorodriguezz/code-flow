import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../state/languageStore", () => ({ translate: (key: string) => (key === "common.undo" ? "Undo" : key) }));

import { useToastStore } from "../state/toastStore";
import { deleteWithUndo, UNDO_WINDOW_MS } from "./undoableDelete";

function setup() {
  const calls = { hide: vi.fn(), restore: vi.fn(), commit: vi.fn() };
  deleteWithUndo({ message: "Task deleted", ...calls });
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("deleteWithUndo", () => {
  it("hides at once and deletes nothing until the window closes", () => {
    const { hide, commit } = setup();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("says so in a card that outlasts the window and whose action is Undo", () => {
    setup();
    const [toast] = useToastStore.getState().toasts;
    expect(toast.message).toBe("Task deleted");
    expect(toast.action?.label).toBe("Undo");
    expect(toast.lifetimeMs).toBe(UNDO_WINDOW_MS);
  });

  it("Undo restores and the deletion never happens", () => {
    const { restore, commit } = setup();
    useToastStore.getState().toasts[0].action?.run();
    expect(restore).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    expect(commit).not.toHaveBeenCalled();
  });

  it("a deletion that fails for real is swallowed, not an unhandled rejection", async () => {
    const commit = vi.fn().mockRejectedValue(new Error("db locked"));
    deleteWithUndo({ message: "x", hide: vi.fn(), restore: vi.fn(), commit });
    vi.advanceTimersByTime(UNDO_WINDOW_MS + 1);
    await Promise.resolve();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("two deletions are two cards, each with its own Undo", () => {
    deleteWithUndo({ message: "Task deleted", hide: vi.fn(), restore: vi.fn(), commit: vi.fn() });
    deleteWithUndo({ message: "Task deleted", hide: vi.fn(), restore: vi.fn(), commit: vi.fn() });
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
});
