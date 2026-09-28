import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An update installed from the tray (Rust, native dialogs) has to show up in the window's own update
 * notice — and, above all, keep the window from starting a second download of the same release.
 */

type Handler = (event: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
const downloads: string[] = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "2.0.4" }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));

const { useUpdateStore, NATIVE_INSTALL_EVENT } = await import("./updateStore");

const release = {
  version: "2.0.5",
  downloadAndInstall: async () => {
    downloads.push("2.0.5");
  },
} as unknown as NonNullable<ReturnType<typeof useUpdateStore.getState>["update"]>;

/** What the backend emits, delivered the way Tauri delivers it. */
const emit = (payload: unknown) => listeners.get(NATIVE_INSTALL_EVENT)?.({ payload });

beforeEach(() => {
  downloads.length = 0;
  useUpdateStore.setState({ status: "idle", update: null, progress: 0, error: "", installError: "" });
});

describe("an update installed from the tray", () => {
  it("is listened for as soon as the store loads", () => {
    expect(listeners.has(NATIVE_INSTALL_EVENT)).toBe(true);
  });

  it("shows its download in the window's notice", () => {
    emit({ phase: "downloading", done: 0, total: null });
    expect(useUpdateStore.getState().status).toBe("downloading");
    emit({ phase: "downloading", done: 250, total: 1000 });
    expect(useUpdateStore.getState().progress).toBe(25);
    emit({ phase: "installed" });
    expect(useUpdateStore.getState()).toMatchObject({ status: "ready", progress: 100 });
  });

  it("keeps the window from starting a second download or check meanwhile", async () => {
    useUpdateStore.setState({ status: "available", update: release });
    emit({ phase: "downloading", done: 10, total: 100 });
    await useUpdateStore.getState().install();
    expect(downloads).toEqual([]);
    await useUpdateStore.getState().checkNow(true);
    expect(useUpdateStore.getState().status).toBe("downloading");
  });

  it("goes back to what the window can act on when it fails", () => {
    useUpdateStore.setState({ status: "available", update: release });
    emit({ phase: "downloading", done: 10, total: 100 });
    emit({ phase: "failed", error: "offline" });
    expect(useUpdateStore.getState()).toMatchObject({ status: "available", progress: 0, installError: "" });

    // One this window never saw leaves no retry button behind for a release it cannot install.
    useUpdateStore.setState({ status: "idle", update: null });
    emit({ phase: "downloading", done: 0, total: null });
    emit({ phase: "failed", error: "offline" });
    expect(useUpdateStore.getState().status).toBe("idle");
  });

  it("does not stop the window's own install when nothing else is downloading", async () => {
    useUpdateStore.setState({ status: "available", update: release });
    await useUpdateStore.getState().install();
    expect(downloads).toEqual(["2.0.5"]);
    expect(useUpdateStore.getState().status).toBe("ready");
  });
});
