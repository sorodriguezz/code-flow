import { describe, expect, it } from "vitest";
import { computeGraphLayout } from "./graphLayout";
import { WORKING_ROW_ID, withPseudoRows } from "./graphRows";
import type { CommitInfo } from "../types/domain";

const commit = (id: string, parents: string[]): CommitInfo => ({
  id,
  short_id: id,
  summary: id,
  author_name: "",
  author_email: "",
  timestamp: 0,
  parent_ids: parents,
  refs: [],
});

describe("pseudo rows", () => {
  const history = [commit("c", ["b"]), commit("b", ["a"]), commit("a", [])];

  it("puts the working tree above HEAD and each stash above its base", () => {
    const { commits, pseudo, side } = withPseudoRows(history, {
      headId: "b",
      workingCount: 3,
      stashes: [{ index: 0, message: "WIP", oid: "s0", base_id: "a", timestamp: 1 }],
    });
    expect(commits.map((c) => c.id)).toEqual(["c", WORKING_ROW_ID, "b", "s0", "a"]);
    expect(pseudo.get(WORKING_ROW_ID)).toEqual({ kind: "working", count: 3 });
    expect(side.has("s0")).toBe(true);
  });

  it("leaves the history alone with nothing to add, or nowhere to hang it", () => {
    const none = withPseudoRows(history, { headId: "b", workingCount: 0, stashes: [] });
    expect(none.commits).toBe(history);
    const lost = withPseudoRows(history, {
      headId: "zz",
      workingCount: 2,
      stashes: [{ index: 0, message: "WIP", oid: "s0", base_id: "zz" }],
    });
    expect(lost.commits).toBe(history);
  });

  it("a stash holds no lane below itself", () => {
    const { commits, side } = withPseudoRows(history, {
      headId: "c",
      workingCount: 0,
      stashes: [{ index: 0, message: "WIP", oid: "s0", base_id: "c" }],
    });
    const layout = computeGraphLayout(commits, side);
    expect(layout.laneCount).toBe(1);
    expect(layout.edges.some((e) => e.fromRow === 0 && e.toRow === 1)).toBe(true);
  });
});
