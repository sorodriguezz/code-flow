import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The crash journal for unsaved editor buffers. A project switch and a quit now write and clear it
 * directly (see `EditorView`), so what it keeps and what it refuses is pinned here.
 */

const settings = vi.hoisted(() => new Map<string, string>());

vi.mock("./tauri/commands", () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => {
    settings.set(key, value);
  }),
}));

import { clearDrafts, mergeDrafts, readDrafts, updateDrafts, writeDrafts } from "./editorDrafts";

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => settings.clear());

describe("editor drafts", () => {
  it("keeps one row per repository, so one project's drafts never come back in another", async () => {
    await writeDrafts("/repos/a", [{ path: "x.ts", content: "a", at: NOW }]);
    await writeDrafts("/repos/b", [{ path: "x.ts", content: "b", at: NOW }]);
    expect(await readDrafts("/repos/a", NOW)).toEqual([{ path: "x.ts", content: "a", at: NOW }]);
    expect(await readDrafts("/repos/b", NOW)).toEqual([{ path: "x.ts", content: "b", at: NOW }]);
  });

  it("replaces the whole list — a file that stopped being dirty leaves it", async () => {
    await writeDrafts("/r", [
      { path: "a.ts", content: "1", at: NOW },
      { path: "b.ts", content: "2", at: NOW },
    ]);
    await writeDrafts("/r", [{ path: "b.ts", content: "2", at: NOW }]);
    expect((await readDrafts("/r", NOW)).map((d) => d.path)).toEqual(["b.ts"]);
  });

  it("skips a buffer over the per-file cap rather than keeping half of it", async () => {
    const huge = "x".repeat(512 * 1024 + 1);
    await writeDrafts("/r", [
      { path: "huge.log", content: huge, at: NOW },
      { path: "small.ts", content: "ok", at: NOW },
    ]);
    expect((await readDrafts("/r", NOW)).map((d) => d.path)).toEqual(["small.ts"]);
  });

  it("drops the oldest work first when the total cap binds", async () => {
    const chunk = "x".repeat(400 * 1024);
    const drafts = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.ts`, content: chunk, at: NOW + i }));
    await writeDrafts("/r", drafts);
    const kept = (await readDrafts("/r", NOW + 10)).map((d) => d.path);
    // 2 MB holds five of these; the one left out is the oldest.
    expect(kept).toHaveLength(5);
    expect(kept).not.toContain("f0.ts");
  });

  it("offers nothing older than a week, and nothing out of a corrupted row", async () => {
    await writeDrafts("/r", [
      { path: "old.ts", content: "1", at: NOW - 8 * DAY },
      { path: "new.ts", content: "2", at: NOW - DAY },
    ]);
    expect((await readDrafts("/r", NOW)).map((d) => d.path)).toEqual(["new.ts"]);

    settings.set("editor_drafts:/bad", "{not json");
    expect(await readDrafts("/bad", NOW)).toEqual([]);
    settings.set("editor_drafts:/bad", JSON.stringify([{ path: 1 }, null, { path: "ok.ts", content: "c", at: NOW }]));
    expect(await readDrafts("/bad", NOW)).toEqual([{ path: "ok.ts", content: "c", at: NOW }]);
  });

  it("clears a repository's row — what quitting without saving does", async () => {
    await writeDrafts("/r", [{ path: "a.ts", content: "1", at: NOW }]);
    await clearDrafts("/r");
    expect(await readDrafts("/r", NOW)).toEqual([]);
  });
});

/**
 * Two writers on one row: the main window, and a floating editor holding one of the repository's
 * files in a webview of its own. Each replaces only what it owns, so neither can drop the other's
 * unsaved text from the journal — a whole-list write from the main window used to be exactly that.
 */
describe("editor drafts shared with a floating editor", () => {
  const draft = (path: string, content: string) => ({ path, content, at: NOW });

  it("keeps the other window's entries and replaces its own", () => {
    const stored = [draft("main.ts", "old"), draft("floating.ts", "theirs"), draft("gone.ts", "x")];
    // The main window: a floating editor holds `floating.ts`, everything else is its own.
    const merged = mergeDrafts(stored, (path) => path === "floating.ts", [draft("main.ts", "new")]);
    expect(merged).toEqual([draft("floating.ts", "theirs"), draft("main.ts", "new")]);
  });

  it("lets a floating editor take its own entry out when the file is clean again", () => {
    const stored = [draft("main.ts", "mine"), draft("floating.ts", "dirty")];
    expect(mergeDrafts(stored, (path) => path !== "floating.ts", [])).toEqual([draft("main.ts", "mine")]);
  });

  it("writes through the row a launch reads back", async () => {
    // `updateDrafts` reads the row as of now, so these are stamped now rather than at `NOW`.
    const at = Date.now();
    await writeDrafts("/r", [{ path: "a.ts", content: "main", at }]);
    await updateDrafts("/r", (path) => path !== "b.ts", [{ path: "b.ts", content: "floating", at }]);
    expect(await readDrafts("/r", at)).toEqual(
      expect.arrayContaining([
        { path: "a.ts", content: "main", at },
        { path: "b.ts", content: "floating", at },
      ]),
    );
  });
});
