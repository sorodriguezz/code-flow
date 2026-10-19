import { describe, expect, it } from "vitest";
import {
  leaf,
  paneAt,
  paneIds,
  parseLayout,
  reconcile,
  removePane,
  serializeLayout,
  splitPane,
  terminalIds,
  viewPaneId,
  type PaneNode,
} from "./layout";

/**
 * The bench's arrangement, now that a pane may be a **view** and not only a shell.
 *
 * Two things carry the whole feature and both are invisible until they break:
 *
 * - `reconcile` compares the tree against the terminals that exist. A view pane has no terminal
 *   anywhere, so a reconcile that treated it as one would delete every view on the next load.
 * - the tree is JSON on disk and read back as untrusted input, so a view written by a newer build —
 *   or a corrupt one — has to degrade to something drawable rather than throwing in the renderer.
 */

const DIFF = { kind: "diff" as const, taskId: "task-1" };

describe("a view pane in the tree", () => {
  it("is split in like any other pane", () => {
    const tree = splitPane(leaf("term-1"), "term-1", "view-1", "row", DIFF);
    expect(paneIds(tree)).toEqual(["term-1", "view-1"]);
    expect(paneAt(tree, "view-1")?.view).toEqual(DIFF);
    expect(paneAt(tree, "term-1")?.view).toBeUndefined();
  });

  it("is not counted among the shells", () => {
    const tree = splitPane(leaf("term-1"), "term-1", "view-1", "row", DIFF);
    expect(terminalIds(tree)).toEqual(["term-1"]);
  });

  it("closes like any other pane, leaving its sibling the whole space", () => {
    const tree = splitPane(leaf("term-1"), "term-1", "view-1", "row", DIFF);
    expect(removePane(tree, "view-1")).toEqual(leaf("term-1"));
  });

  it("gets an id that cannot be mistaken for a terminal's", () => {
    expect(viewPaneId()).toMatch(/^view:/);
    expect(viewPaneId()).not.toBe(viewPaneId());
  });
});

describe("reconcile", () => {
  const tree = splitPane(leaf("term-1"), "term-1", "view-1", "row", DIFF);

  it("keeps a view pane although no terminal answers for it", () => {
    const next = reconcile(tree, ["term-1"]);
    expect(paneIds(next)).toEqual(["term-1", "view-1"]);
  });

  it("still prunes a shell whose terminal is gone", () => {
    const next = reconcile(tree, []);
    expect(paneIds(next)).toEqual(["view-1"]);
  });

  it("still appends a terminal the tree never mentioned", () => {
    const next = reconcile(tree, ["term-1", "term-2"]);
    expect(paneIds(next)).toContain("term-2");
  });
});

describe("parseLayout", () => {
  it("reads a stored view back", () => {
    const tree = splitPane(leaf("term-1"), "term-1", "view-1", "row", DIFF);
    const read = parseLayout(serializeLayout(tree));
    expect(read).toEqual(tree);
  });

  /** A kind this build does not know — a newer version's pane. The arrangement survives; the pane
   *  becomes a shell, and `reconcile` then prunes that one pane because no terminal answers for it. */
  it("degrades an unrecognised view to a shell rather than dropping the branch", () => {
    const raw = JSON.stringify({
      kind: "split",
      dir: "row",
      ratio: 0.5,
      a: { kind: "leaf", id: "term-1" },
      b: { kind: "leaf", id: "view-1", view: { kind: "hologram", url: "x" } },
    });
    const read = parseLayout(raw) as PaneNode;
    expect(paneIds(read)).toEqual(["term-1", "view-1"]);
    expect(paneAt(read, "view-1")?.view).toBeUndefined();
    expect(terminalIds(read)).toEqual(["term-1", "view-1"]);
  });

  it("drops a view with no task behind it", () => {
    const raw = JSON.stringify({ kind: "leaf", id: "view-1", view: { kind: "diff", taskId: "" } });
    expect(paneAt(parseLayout(raw), "view-1")?.view).toBeUndefined();
  });

  it("is null for a corrupt tree, so the tab is rebuilt from its terminals", () => {
    expect(parseLayout("{oops")).toBeNull();
    expect(parseLayout(JSON.stringify({ kind: "split", a: { kind: "leaf", id: "a" } }))).toBeNull();
  });
});
