import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The main window's answer to a held quit. Nothing unsaved must cost nothing — no window shown, no
 * question — and every other path must end in exactly one of: quit, or stay with the work intact.
 */

type BusMessage = { kind: string; [key: string]: unknown };

const h = vi.hoisted(() => ({
  quitHandler: null as null | (() => void),
  busHandler: null as null | ((message: BusMessage, from: string) => void),
  sent: [] as BusMessage[],
  satellites: [] as Array<{ label: string }>,
  /** How each satellite answers an addressed request: the failed labels, or `null` for silence. */
  satelliteAnswers: new Map<string, string[] | null>(),
}));

const commands = vi.hoisted(() => ({
  quitAppConfirmed: vi.fn(async () => {}),
  quitGuardAck: vi.fn(async () => {}),
  quitGuardArm: vi.fn(async (_armed: boolean) => {}),
  quitGuardCancel: vi.fn(async () => {}),
}));
const work = vi.hoisted(() => ({
  collectUnsaved: vi.fn((): Array<{ label: string; detail?: string }> => []),
  saveAllUnsaved: vi.fn(async (): Promise<string[]> => []),
  discardAllUnsaved: vi.fn(async () => {}),
}));
const ui = vi.hoisted(() => ({
  chooseAction: vi.fn(async (_args: { message: string; items?: string[] }): Promise<string | null> => null),
  pushErrorToast: vi.fn(),
  showMainWindow: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: () => void) => {
    h.quitHandler = handler;
    return () => {
      h.quitHandler = null;
    };
  }),
}));
vi.mock("./tauri/commands", () => commands);
vi.mock("./tauri/windows", () => ({ showMainWindow: ui.showMainWindow }));
vi.mock("./unsavedWork", () => work);
vi.mock("../state/confirmStore", () => ({ chooseAction: ui.chooseAction }));
vi.mock("../state/toastStore", () => ({ pushErrorToast: ui.pushErrorToast }));
vi.mock("../state/languageStore", () => ({
  translate: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}));
vi.mock("../state/windowStore", () => ({
  useWindowStore: { getState: () => ({ satellites: h.satellites }) },
}));
vi.mock("./windowBus", () => ({
  broadcast: (message: BusMessage) => {
    h.sent.push(message);
    if ((message.kind === "unsaved-save" || message.kind === "unsaved-discard") && typeof message.to === "string") {
      const answer = h.satelliteAnswers.get(message.to);
      if (answer !== null) {
        queueMicrotask(() =>
          h.busHandler?.({ kind: "unsaved-done", requestId: message.requestId, failed: answer ?? [] }, message.to as string),
        );
      }
    }
  },
  onWindowMessage: (handler: (message: BusMessage, from: string) => void) => {
    h.busHandler = handler;
    return () => {
      h.busHandler = null;
    };
  },
}));

import { installQuitGuard } from "./quitGuard";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let teardown: (() => void) | null = null;

async function install() {
  teardown = installQuitGuard();
  await flush();
}

async function quit() {
  h.quitHandler?.();
  await flush();
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.sent = [];
  h.satellites = [];
  h.satelliteAnswers = new Map();
  work.collectUnsaved.mockReturnValue([]);
  work.saveAllUnsaved.mockResolvedValue([]);
  ui.chooseAction.mockResolvedValue(null);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

describe("installQuitGuard", () => {
  it("arms only once it listens, disarms on the way out, and asks satellites to report again", async () => {
    await install();
    expect(commands.quitGuardArm).toHaveBeenCalledWith(true);
    expect(h.sent).toContainEqual({ kind: "unsaved-refresh" });
    teardown?.();
    teardown = null;
    expect(commands.quitGuardArm).toHaveBeenLastCalledWith(false);
  });

  it("quits at once when nothing is unsaved — no window, no question", async () => {
    await install();
    await quit();
    expect(commands.quitGuardAck).toHaveBeenCalled();
    expect(commands.quitAppConfirmed).toHaveBeenCalledTimes(1);
    expect(ui.chooseAction).not.toHaveBeenCalled();
    expect(ui.showMainWindow).not.toHaveBeenCalled();
  });

  it("shows the window and lists the unsaved work before asking", async () => {
    work.collectUnsaved.mockReturnValue([{ label: "src/a.ts", detail: "app" }]);
    await install();
    await quit();
    expect(ui.showMainWindow).toHaveBeenCalled();
    expect(ui.chooseAction.mock.calls[0][0].items).toEqual(["src/a.ts — app"]);
    // Cancelled: the app stays, and the backend is told the question is over.
    expect(commands.quitGuardCancel).toHaveBeenCalledTimes(1);
    expect(commands.quitAppConfirmed).not.toHaveBeenCalled();
  });

  it("saves everything and then quits", async () => {
    work.collectUnsaved.mockReturnValue([{ label: "a.ts" }]);
    ui.chooseAction.mockResolvedValue("save");
    await install();
    await quit();
    expect(work.saveAllUnsaved).toHaveBeenCalledTimes(1);
    expect(commands.quitAppConfirmed).toHaveBeenCalledTimes(1);
  });

  it("stays open when anything failed to save, and says which", async () => {
    work.collectUnsaved.mockReturnValue([{ label: "a.ts" }]);
    work.saveAllUnsaved.mockResolvedValue(["a.ts"]);
    ui.chooseAction.mockResolvedValue("save");
    await install();
    await quit();
    expect(commands.quitAppConfirmed).not.toHaveBeenCalled();
    expect(commands.quitGuardCancel).toHaveBeenCalledTimes(1);
    expect(ui.pushErrorToast.mock.calls[0][0]).toContain("a.ts");
  });

  it("discards — here and in every satellite — before quitting without saving", async () => {
    work.collectUnsaved.mockReturnValue([{ label: "a.ts" }]);
    ui.chooseAction.mockResolvedValue("discard");
    h.satellites = [{ label: "sat-repo-1" }];
    await install();
    h.busHandler?.({ kind: "unsaved-state", items: [{ label: "b.ts", detail: "lib" }] }, "sat-repo-1");
    await quit();
    expect(work.discardAllUnsaved).toHaveBeenCalledTimes(1);
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "unsaved-discard", to: "sat-repo-1" }));
    expect(commands.quitAppConfirmed).toHaveBeenCalledTimes(1);
  });

  it("counts a satellite's reported work, and forgets a satellite that has closed", async () => {
    h.satellites = [{ label: "sat-repo-1" }];
    await install();
    h.busHandler?.({ kind: "unsaved-state", items: [{ label: "b.ts", detail: "lib" }] }, "sat-repo-1");
    h.busHandler?.({ kind: "unsaved-state", items: [{ label: "c.ts" }] }, "sat-repo-gone");
    await quit();
    expect(ui.chooseAction.mock.calls[0][0].items).toEqual(["b.ts — lib"]);
  });

  it("has a satellite save its own buffers, and stays open when it does not answer", async () => {
    h.satellites = [{ label: "sat-repo-1" }];
    ui.chooseAction.mockResolvedValue("save");
    await install();
    h.busHandler?.({ kind: "unsaved-state", items: [{ label: "b.ts" }] }, "sat-repo-1");

    h.satelliteAnswers.set("sat-repo-1", []);
    await quit();
    expect(h.sent).toContainEqual(expect.objectContaining({ kind: "unsaved-save", to: "sat-repo-1" }));
    expect(commands.quitAppConfirmed).toHaveBeenCalledTimes(1);

    commands.quitAppConfirmed.mockClear();
    h.satelliteAnswers.set("sat-repo-1", null);
    await quit();
    expect(commands.quitAppConfirmed).not.toHaveBeenCalled();
    const toasts = ui.pushErrorToast.mock.calls;
    expect(toasts[toasts.length - 1]?.[0]).toContain("b.ts");
  });

  it("brings an open question forward rather than asking twice", async () => {
    work.collectUnsaved.mockReturnValue([{ label: "a.ts" }]);
    let answer: (value: string | null) => void = () => {};
    ui.chooseAction.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    await install();
    h.quitHandler?.();
    await flush();
    h.quitHandler?.();
    await flush();
    expect(ui.chooseAction).toHaveBeenCalledTimes(1);
    expect(ui.showMainWindow).toHaveBeenCalledTimes(2);
    answer(null);
    await flush();
    expect(commands.quitGuardCancel).toHaveBeenCalledTimes(1);
  });
});
