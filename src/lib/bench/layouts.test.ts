import { describe, expect, it } from "vitest";
import {
  MAX_PANES,
  layoutNamed,
  parseLayouts,
  serializeLayouts,
  withLayout,
  withoutLayout,
  type BenchLayout,
} from "./layouts";

/**
 * Saved arrangements come off a settings row, which is untrusted input like any other stored JSON:
 * a hand-edited row must leave the toolbar drawable rather than throwing inside the menu that lists
 * it. And a layout with no panes is not an arrangement — it would open a tab and nothing in it.
 */

const DEV: BenchLayout = {
  name: "dev",
  panes: [
    { cwd: "/repo", title: "server", command: "pnpm dev" },
    { cwd: "/repo", title: "tests", command: "pnpm test --watch" },
  ],
};

describe("parseLayouts", () => {
  it("reads back what was written", () => {
    expect(parseLayouts(serializeLayouts([DEV]))).toEqual([DEV]);
  });

  it("is empty for nothing, and for anything that is not a list", () => {
    expect(parseLayouts(null)).toEqual([]);
    expect(parseLayouts("   ")).toEqual([]);
    expect(parseLayouts("{oops")).toEqual([]);
    expect(parseLayouts(JSON.stringify({ name: "dev" }))).toEqual([]);
  });

  it("drops a layout with no name and one with no panes", () => {
    const raw = JSON.stringify([
      { name: "  ", panes: [{ cwd: "/repo" }] },
      { name: "empty", panes: [] },
      DEV,
    ]);
    expect(parseLayouts(raw).map((layout) => layout.name)).toEqual(["dev"]);
  });

  it("drops the blank halves of a pane rather than storing empty strings", () => {
    const raw = JSON.stringify([{ name: "one", panes: [{ cwd: "/repo", title: "  ", command: "" }] }]);
    expect(parseLayouts(raw)).toEqual([{ name: "one", panes: [{ cwd: "/repo" }] }]);
  });

  /** A pane may have no folder: it is then a shell wherever the backend starts one, which is home. */
  it("keeps a pane with no folder", () => {
    const raw = JSON.stringify([{ name: "one", panes: [{ command: "htop" }] }]);
    expect(parseLayouts(raw)).toEqual([{ name: "one", panes: [{ cwd: "", command: "htop" }] }]);
  });

  it("caps how many panes a hand-edited row can ask for", () => {
    const panes = Array.from({ length: MAX_PANES + 12 }, () => ({ cwd: "/repo" }));
    expect(parseLayouts(JSON.stringify([{ name: "big", panes }]))[0].panes).toHaveLength(MAX_PANES);
  });
});

describe("withLayout", () => {
  it("appends a new one", () => {
    expect(withLayout([], DEV)).toEqual([DEV]);
  });

  /** "Dev" and "dev" in one menu are two rows nobody can tell apart. */
  it("replaces one of the same name, whatever its case, in place", () => {
    const edited = { ...DEV, name: "Dev", panes: [{ cwd: "/other" }] };
    const next = withLayout([DEV, { name: "ci", panes: [{ cwd: "/repo" }] }], edited);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(edited);
  });
});

describe("withoutLayout and layoutNamed", () => {
  it("find and remove by name, case-insensitively", () => {
    expect(layoutNamed([DEV], "DEV")).toEqual(DEV);
    expect(layoutNamed([DEV], "nope")).toBeNull();
    expect(withoutLayout([DEV], "Dev")).toEqual([]);
  });
});
