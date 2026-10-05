import { describe, expect, it } from "vitest";
import { diffSpecs } from "./diff";
import type { FlowNodeSpec, FlowSpec } from "./spec";

const node = (id: string, type: string, params: Record<string, unknown> = {}, x = 0): FlowNodeSpec => ({
  id,
  type,
  name: id,
  pos: [x, 0],
  params,
  settings: {},
  disabled: false,
});

const spec = (nodes: FlowNodeSpec[], wires: [string, string][]): FlowSpec => ({
  schema: 1,
  nodes,
  connections: wires.map(([from, to]) => ({ from, out: 0, to, in: 0 })),
  notes: [],
  settings: {},
});

describe("diffSpecs", () => {
  const before = spec(
    [node("go", "trigger.manual"), node("fetch", "net.http", { url: "https://example.com", method: "GET" }), node("old", "app.notify")],
    [
      ["go", "fetch"],
      ["fetch", "old"],
    ],
  );

  it("marks what was added, changed and removed, and draws the removed back in", () => {
    const after = spec(
      [
        node("go", "trigger.manual", {}, 40),
        node("fetch", "net.http", { method: "POST", url: "https://example.com" }),
        node("slack", "net.connector"),
      ],
      [
        ["go", "fetch"],
        ["fetch", "slack"],
      ],
    );
    const diff = diffSpecs(before, after);
    expect(diff.nodes.get("go")).toBeUndefined(); // moved only
    expect(diff.nodes.get("fetch")).toBe("changed");
    expect(diff.nodes.get("slack")).toBe("added");
    expect(diff.nodes.get("old")).toBe("removed");
    expect(diff.counts).toEqual({ added: 1, changed: 1, removed: 1 });
    expect(diff.shown.nodes.map((n) => n.id)).toEqual(["go", "fetch", "slack", "old"]);
    expect(diff.connections.get("fetch:0>slack:0")).toBe("added");
    expect(diff.connections.get("fetch:0>old:0")).toBe("removed");
    expect(diff.connections.has("go:0>fetch:0")).toBe(false);
    expect(diff.shown.connections).toHaveLength(3);
  });

  it("sees no change in parameters written in another order", () => {
    const after = spec(
      [node("go", "trigger.manual"), node("fetch", "net.http", { method: "GET", url: "https://example.com" }), node("old", "app.notify")],
      [
        ["go", "fetch"],
        ["fetch", "old"],
      ],
    );
    const diff = diffSpecs(before, after);
    expect(diff.nodes.size).toBe(0);
    expect(diff.connections.size).toBe(0);
  });
});
