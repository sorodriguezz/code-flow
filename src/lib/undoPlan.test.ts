import { describe, expect, it } from "vitest";
import type { UndoPlan } from "./tauri/gitCommands";
import { describeUndo, reflogSubject } from "./undoPlan";

const t = (key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const plan = (over: Partial<UndoPlan>): UndoPlan => ({
  op: "commit",
  strategy: "soft",
  target_oid: "a".repeat(40),
  target_summary: "previous",
  checkout_to: null,
  branch: "main",
  message: "commit: Fix the header",
  head_oid: "b".repeat(40),
  ...over,
});

describe("describeUndo", () => {
  it("names the undone commit and says its changes stay staged", () => {
    const out = describeUndo(plan({}), t, "HEAD");
    expect(out.message).toBe("undo.confirm.commit(branch=main,sha=aaaaaaa,subject=Fix the header)");
    expect(out.danger).toBe(true);
  });

  it("tells an amend apart from a commit", () => {
    expect(describeUndo(plan({ op: "amend" }), t, "HEAD").message).toMatch(/^undo\.confirm\.amend/);
  });

  it("picks the sentence for each kind of move back", () => {
    expect(describeUndo(plan({ op: "merge", strategy: "keep" }), t, "HEAD").message).toMatch(/^undo\.confirm\.merge/);
    expect(describeUndo(plan({ op: "pull", strategy: "keep" }), t, "HEAD").message).toMatch(/^undo\.confirm\.merge/);
    expect(describeUndo(plan({ op: "rebase", strategy: "keep" }), t, "HEAD").message).toMatch(/^undo\.confirm\.rebase/);
    expect(describeUndo(plan({ op: "reset", strategy: "keep" }), t, "HEAD").message).toMatch(/^undo\.confirm\.resetKeep/);
    expect(describeUndo(plan({ op: "reset", strategy: "mixed" }), t, "HEAD").message).toMatch(/^undo\.confirm\.resetMixed/);
  });

  it("says where a checkout goes back to, and is not a danger", () => {
    const branch = describeUndo(plan({ op: "checkout", strategy: "checkout", checkout_to: "develop" }), t, "HEAD");
    expect(branch.message).toBe("undo.confirm.checkout(target=develop)");
    expect(branch.danger).toBe(false);
    const commit = describeUndo(plan({ op: "checkout", strategy: "checkout", checkout_to: "c".repeat(40) }), t, "HEAD");
    expect(commit.message).toBe("undo.confirm.checkout(target=ccccccc)");
  });

  it("names a detached HEAD instead of a branch", () => {
    expect(describeUndo(plan({ branch: null }), t, "detached").message).toContain("branch=detached");
  });
});

describe("reflogSubject", () => {
  it("drops the operation prefix", () => {
    expect(reflogSubject("commit (amend): Fix: the header")).toBe("Fix: the header");
    expect(reflogSubject("no prefix here")).toBe("no prefix here");
  });
});
