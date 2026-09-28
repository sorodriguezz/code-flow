import { afterEach, describe, expect, it, vi } from "vitest";
import type { UnsavedProvider } from "./unsavedWork";

/**
 * The registry a quit asks "is anything unsaved?". Its failures are all quiet ones — a provider
 * whose work is not listed is work lost without a question — so the rules are pinned here.
 */

type Handler = (message: { kind: string; [key: string]: unknown }, from: string) => void;

async function load(main: boolean) {
  vi.resetModules();
  const sent: Array<{ kind: string; [key: string]: unknown }> = [];
  let handler: Handler | null = null;
  vi.doMock("./windowBus", () => ({
    broadcast: (message: { kind: string }) => sent.push(message),
    onWindowMessage: (h: Handler) => {
      handler = h;
      return () => {};
    },
  }));
  vi.doMock("./windowIdentity", () => ({ WINDOW: { main, label: main ? "main" : "sat-repo-1" } }));
  const registry = await import("./unsavedWork");
  const deliver = (message: { kind: string; [key: string]: unknown }) => handler?.(message, "main");
  return { ...registry, sent, deliver };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function provider(id: string, over: Partial<UnsavedProvider> = {}): UnsavedProvider {
  return { id, unsaved: () => [{ label: `${id}.ts` }], ...over };
}

afterEach(() => {
  vi.doUnmock("./windowBus");
  vi.doUnmock("./windowIdentity");
});

describe("collectUnsaved", () => {
  it("lists every provider's work, and a provider that cannot say as its id", async () => {
    const { registerUnsavedProvider, collectUnsaved } = await load(true);
    registerUnsavedProvider(provider("editor", { unsaved: () => [{ label: "a.ts", detail: "app" }] }));
    registerUnsavedProvider(
      provider("notes", {
        unsaved: () => {
          throw new Error("store not loaded");
        },
      }),
    );
    expect(collectUnsaved()).toEqual([{ label: "a.ts", detail: "app" }, { label: "notes" }]);
  });

  it("forgets only its own registration when a newer one took the id", async () => {
    const { registerUnsavedProvider, collectUnsaved } = await load(true);
    const stopOld = registerUnsavedProvider(provider("editor", { unsaved: () => [{ label: "old" }] }));
    registerUnsavedProvider(provider("editor", { unsaved: () => [{ label: "new" }] }));
    stopOld();
    expect(collectUnsaved()).toEqual([{ label: "new" }]);
  });
});

describe("saveAllUnsaved", () => {
  it("resolves to what could not be saved — reported, never dropped", async () => {
    const { registerUnsavedProvider, saveAllUnsaved } = await load(true);
    const quiet = vi.fn(async () => []);
    registerUnsavedProvider(provider("editor", { saveAll: async () => ["changed.ts"] }));
    // Work with no way to save it can only be kept or thrown away.
    registerUnsavedProvider(provider("notes"));
    registerUnsavedProvider(
      provider("diagrams", {
        saveAll: async () => {
          throw new Error("disk full");
        },
      }),
    );
    // Nothing unsaved: not asked to save at all.
    registerUnsavedProvider(provider("clean", { unsaved: () => [], saveAll: quiet }));

    expect(await saveAllUnsaved()).toEqual(["changed.ts", "notes.ts", "diagrams.ts"]);
    expect(quiet).not.toHaveBeenCalled();
  });

  it("is empty when everything saved", async () => {
    const { registerUnsavedProvider, saveAllUnsaved } = await load(true);
    registerUnsavedProvider(provider("editor", { saveAll: async () => [] }));
    expect(await saveAllUnsaved()).toEqual([]);
  });
});

describe("discardAllUnsaved", () => {
  it("tells every provider to forget, even after one fails to", async () => {
    const { registerUnsavedProvider, discardAllUnsaved } = await load(true);
    const second = vi.fn();
    registerUnsavedProvider(
      provider("editor", {
        discard: () => {
          throw new Error("journal locked");
        },
      }),
    );
    registerUnsavedProvider(provider("notes", { discard: second }));
    await discardAllUnsaved();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("a satellite's report to the main window", () => {
  it("never comes from the main window, which is the one asking", async () => {
    const { registerUnsavedProvider, notifyUnsavedChanged, sent } = await load(true);
    registerUnsavedProvider(provider("editor"));
    notifyUnsavedChanged();
    expect(sent).toEqual([]);
  });

  it("goes out when the list changes and when the main window asks again", async () => {
    const { registerUnsavedProvider, notifyUnsavedChanged, sent, deliver } = await load(false);
    let items = [{ label: "a.ts", detail: "app" }];
    registerUnsavedProvider(provider("editor", { unsaved: () => items }));
    expect(sent[sent.length - 1]).toEqual({ kind: "unsaved-state", items: [{ label: "a.ts", detail: "app" }] });

    items = [];
    notifyUnsavedChanged();
    expect(sent[sent.length - 1]).toEqual({ kind: "unsaved-state", items: [] });

    items = [{ label: "b.ts", detail: "app" }];
    deliver({ kind: "unsaved-refresh" });
    expect(sent[sent.length - 1]).toEqual({ kind: "unsaved-state", items: [{ label: "b.ts", detail: "app" }] });
  });

  it("saves or discards when addressed, answers with the same request id, and ignores other windows' requests", async () => {
    const { registerUnsavedProvider, sent, deliver } = await load(false);
    const saveAll = vi.fn(async () => ["changed.ts"]);
    const discard = vi.fn();
    registerUnsavedProvider(provider("editor", { saveAll, discard }));

    deliver({ kind: "unsaved-save", to: "sat-other", requestId: "r0" });
    await settle();
    expect(saveAll).not.toHaveBeenCalled();

    deliver({ kind: "unsaved-save", to: "sat-repo-1", requestId: "r1" });
    await settle();
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ kind: "unsaved-done", requestId: "r1", failed: ["changed.ts"] });

    deliver({ kind: "unsaved-discard", to: "sat-repo-1", requestId: "r2" });
    await settle();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ kind: "unsaved-done", requestId: "r2", failed: [] });
  });
});
