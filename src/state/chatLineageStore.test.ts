import { describe, expect, it } from "vitest";
import { nestByLineage, parentMap } from "./chatLineageStore";
import { chatIslandRefId, parseChatIslandRef } from "../lib/chatIslandSync";
import type { ChatLink } from "../lib/tauri/chatLineage";

const link = (conversationId: string, parentId: string): ChatLink => ({
  conversationId,
  parentId,
  surface: "panel",
  kind: "new",
  scopeId: "p1",
  branchedTurn: null,
  createdAt: "",
});

const order = (ids: string[], links: ChatLink[]) =>
  nestByLineage(ids, (id) => id, parentMap(links)).map(({ item, depth }) => `${item}:${depth}`);

describe("subchat nesting", () => {
  it("puts each subchat right after its parent, siblings in their own order", () => {
    // Opened as: a, x, a2 (sub of a), a1 (sub of a), a1b (sub of a1)
    expect(order(["a", "x", "a2", "a1", "a1b"], [link("a2", "a"), link("a1", "a"), link("a1b", "a1")])).toEqual([
      "a:0",
      "a2:1",
      "a1:1",
      "a1b:2",
      "x:0",
    ]);
  });

  it("stands a subchat on its own when its parent is not in the list", () => {
    expect(order(["b", "c"], [link("b", "gone")])).toEqual(["b:0", "c:0"]);
  });

  it("caps the depth it reports and survives a cycle", () => {
    const deep = order(["a", "b", "c", "d", "e"], [link("b", "a"), link("c", "b"), link("d", "c"), link("e", "d")]);
    expect(deep).toEqual(["a:0", "b:1", "c:2", "d:3", "e:3"]);
    expect(order(["p", "q"], [link("p", "q"), link("q", "p")]).sort()).toEqual(["p:0", "q:1"].sort());
  });

  it("marks the ones with subchats", () => {
    const rows = nestByLineage(["a", "b"], (id) => id, parentMap([link("b", "a")]));
    expect(rows.map((r) => r.hasChildren)).toEqual([true, false]);
  });
});

describe("chat island refs", () => {
  it("round-trips both surfaces", () => {
    const panel = { surface: "panel" as const, projectId: "p1", conversationId: "conv-1" };
    const ws = { surface: "ws" as const, workspaceId: "w1", conversationId: "c-2" };
    expect(parseChatIslandRef(chatIslandRefId(panel))).toEqual(panel);
    expect(parseChatIslandRef(chatIslandRefId(ws))).toEqual(ws);
  });

  it("refuses what it cannot read", () => {
    expect(parseChatIslandRef("notes")).toBeNull();
    expect(parseChatIslandRef("other:a:b")).toBeNull();
    expect(parseChatIslandRef("panel::b")).toBeNull();
  });
});

describe("tearing a chat tab out", () => {
  it("counts only a release past the window's edges", async () => {
    const { outsideViewport } = await import("../lib/chatIslandSync");
    expect(outsideViewport(10, 10, 800, 600)).toBe(false);
    expect(outsideViewport(-1, 10, 800, 600)).toBe(true);
    expect(outsideViewport(10, 600, 800, 600)).toBe(true);
    expect(outsideViewport(800, 10, 800, 600)).toBe(true);
  });
});
