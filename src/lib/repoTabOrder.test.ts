import { describe, expect, it } from "vitest";
import { moveVisibleRepoTab, orderedRepoTabs } from "./repoTabOrder";

const tabs = ["graph", "changes", "editor", "reviewer", "codemap", "env", "pipelines"].map((id) => ({ id }));
const ids = (items: typeof tabs) => items.map((tab) => tab.id);

describe("repository tab order", () => {
  it("keeps the default order until the user rearranges it", () => {
    expect(ids(orderedRepoTabs(tabs, []))).toEqual(ids(tabs));
  });

  it("ignores retired ids and keeps new tabs available without duplicates", () => {
    expect(ids(orderedRepoTabs(tabs, ["retired", "reviewer", "reviewer", "graph"])))
      .toEqual(["reviewer", "graph", "changes", "editor", "codemap", "env", "pipelines"]);
  });

  it("moves in both directions without mutating the tab registry", () => {
    const original = ids(tabs);
    const order = moveVisibleRepoTab(tabs, tabs, 3, 0);
    expect(order).toEqual(["reviewer", "graph", "changes", "editor", "codemap", "env", "pipelines"]);
    const reordered = orderedRepoTabs(tabs, order);
    expect(moveVisibleRepoTab(reordered, reordered, 0, 3)).toEqual(original);
    expect(ids(tabs)).toEqual(original);
  });

  it("preserves hidden tabs' positions when the visible tabs move", () => {
    const visible = tabs.filter((tab) => tab.id !== "reviewer" && tab.id !== "pipelines");
    const order = moveVisibleRepoTab(tabs, visible, 4, 0);
    expect(order).toEqual(["env", "graph", "changes", "reviewer", "editor", "codemap", "pipelines"]);
    expect(ids(orderedRepoTabs(tabs, order))).toEqual(order);
  });
});
