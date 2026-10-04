import { describe, expect, it } from "vitest";
import type { FlowNodeDescriptor } from "../tauri/flowsCommands";
import {
  LOOP_TYPE,
  addNode,
  autoLayout,
  connect,
  connectionKey,
  connectionProblem,
  copyFragment,
  emptySpec,
  hasErrorOutput,
  moveElements,
  outputCount,
  parseFragment,
  parseSpec,
  pasteFragment,
  removeElements,
  renameNode,
  serializeSpec,
  setNodeParam,
  setNodeSettings,
  uniqueName,
  type Catalog,
  type FlowSpec,
} from "./spec";

const descriptor = (typeId: string, inputs: number, outputs: number): FlowNodeDescriptor => ({
  typeId,
  family: typeId.split(".")[0] as FlowNodeDescriptor["family"],
  icon: "box",
  inputs,
  outputs,
  inputLabels: [],
  outputLabels: [],
  milestone: 1,
  params: [],
});

/** The shapes the tests need — the real list comes from Rust (`flows_node_catalog`). */
const CATALOG: Catalog = new Map(
  [
    descriptor("trigger.manual", 0, 1),
    descriptor("trigger.schedule", 0, 1),
    descriptor("net.http", 1, 1),
    descriptor("logic.if", 1, 2),
    descriptor("logic.merge", 2, 1),
    descriptor("logic.stop", 1, 0),
    descriptor(LOOP_TYPE, 1, 2),
  ].map((d) => [d.typeId, d]),
);

function build(...types: [string, string][]): FlowSpec {
  let spec = emptySpec();
  for (const [type, name] of types) spec = addNode(spec, type, name, [0, 0]).spec;
  return spec;
}

const idOf = (spec: FlowSpec, name: string) => spec.nodes.find((n) => n.name === name)!.id;

describe("the flow document", () => {
  it("reads what Rust writes and keeps fields it does not know", () => {
    const text = '{"schema":1,"nodes":[{"id":"n1","type":"net.http","name":"API","pos":[10,20],"color":"red"}],"future":true}';
    const spec = parseSpec(text);
    expect(spec.nodes[0]).toMatchObject({ id: "n1", name: "API", pos: [10, 20], params: {}, settings: {} });
    expect((spec.nodes[0] as unknown as Record<string, unknown>).color).toBe("red");
    expect(JSON.parse(serializeSpec(spec)).future).toBe(true);
    expect(parseSpec('{"schema":1}')).toEqual(emptySpec());
    expect(() => parseSpec("[1,2]")).toThrow();
  });

  it("names nodes uniquely, counting on from a trailing number", () => {
    expect(uniqueName("HTTP", [])).toBe("HTTP");
    expect(uniqueName("HTTP", ["HTTP"])).toBe("HTTP 2");
    expect(uniqueName("HTTP 2", ["HTTP", "HTTP 2"])).toBe("HTTP 3");
    const spec = build(["net.http", "HTTP"], ["net.http", "HTTP"]);
    expect(spec.nodes.map((n) => n.name)).toEqual(["HTTP", "HTTP 2"]);
    expect(new Set(spec.nodes.map((n) => n.id)).size).toBe(2);
  });

  it("refuses the connections the backend would refuse", () => {
    const spec = build(["trigger.manual", "T"], ["net.http", "A"], ["net.http", "B"], ["logic.stop", "S"]);
    const [t, a, b, s] = ["T", "A", "B", "S"].map((n) => idOf(spec, n));
    expect(connectionProblem(spec, CATALOG, { from: a, out: 0, to: t, in: 0 })).toBe("port");
    expect(connectionProblem(spec, CATALOG, { from: s, out: 0, to: a, in: 0 })).toBe("port");
    expect(connectionProblem(spec, CATALOG, { from: a, out: 0, to: a, in: 0 })).toBe("self");
    const once = connect(spec, CATALOG, { from: a, out: 0, to: b, in: 0 })!;
    expect(connectionProblem(once, CATALOG, { from: a, out: 0, to: b, in: 0 })).toBe("duplicate");
    expect(connectionProblem(once, CATALOG, { from: b, out: 0, to: a, in: 0 })).toBe("cycle");
    expect(connect(once, CATALOG, { from: t, out: 0, to: a, in: 0 })?.connections).toHaveLength(2);
  });

  it("lets a loop node close a cycle", () => {
    const spec = build(["trigger.manual", "T"], [LOOP_TYPE, "Lotes"], ["net.http", "Cada uno"]);
    const [t, l, h] = ["T", "Lotes", "Cada uno"].map((n) => idOf(spec, n));
    let next = connect(spec, CATALOG, { from: t, out: 0, to: l, in: 0 })!;
    next = connect(next, CATALOG, { from: l, out: 0, to: h, in: 0 })!;
    expect(connect(next, CATALOG, { from: h, out: 0, to: l, in: 0 })).not.toBeNull();
  });

  it("takes a node's connections with it, and keeps the names unambiguous", () => {
    let spec = build(["net.http", "A"], ["net.http", "B"]);
    const [a, b] = ["A", "B"].map((n) => idOf(spec, n));
    spec = connect(spec, CATALOG, { from: a, out: 0, to: b, in: 0 })!;
    expect(removeElements(spec, { nodes: [a] }).connections).toEqual([]);
    expect(removeElements(spec, { connections: [connectionKey(spec.connections[0])] }).nodes).toHaveLength(2);
    expect(renameNode(spec, a, "B")).toBeNull();
    expect(renameNode(spec, a, "  ")).toBeNull();
    expect(renameNode(spec, a, " Pagos ")!.nodes[0].name).toBe("Pagos");
  });

  it("moves only what changed, so the rest keep their identity", () => {
    const spec = build(["net.http", "A"], ["net.http", "B"]);
    const moved = moveElements(spec, new Map([[spec.nodes[0].id, [40, 80] as [number, number]]]));
    expect(moved.nodes[0].pos).toEqual([40, 80]);
    expect(moved.nodes[1]).toBe(spec.nodes[1]);
  });
});

describe("copy and paste", () => {
  it("pastes fresh ids, unique names and only the connections inside the selection", () => {
    let spec = build(["net.http", "A"], ["net.http", "B"], ["net.http", "C"]);
    const [a, b, c] = ["A", "B", "C"].map((n) => idOf(spec, n));
    spec = connect(spec, CATALOG, { from: a, out: 0, to: b, in: 0 })!;
    spec = connect(spec, CATALOG, { from: b, out: 0, to: c, in: 0 })!;

    const fragment = parseFragment(JSON.stringify(copyFragment(spec, [a, b], [])))!;
    expect(fragment.connections).toHaveLength(1);

    const pasted = pasteFragment(spec, fragment, CATALOG, [40, 40]);
    expect(pasted.nodeIds).toHaveLength(2);
    expect(pasted.spec.nodes.map((n) => n.name)).toEqual(["A", "B", "C", "A 2", "B 2"]);
    const copies = pasted.spec.nodes.slice(3);
    expect(copies.every((n) => !spec.nodes.some((o) => o.id === n.id))).toBe(true);
    expect(pasted.spec.connections[pasted.spec.connections.length - 1]).toMatchObject({ from: copies[0].id, to: copies[1].id });
    expect(copies[0].pos).toEqual([40, 40]);
  });

  it("ignores text that is not a fragment, and nodes this build does not know", () => {
    expect(parseFragment("hola")).toBeNull();
    expect(parseFragment('{"kind":"other"}')).toBeNull();
    const fragment = parseFragment(
      JSON.stringify({ kind: "codeflow/flow-fragment", version: 1, nodes: [{ id: "x", type: "net.pigeon", name: "P", pos: [0, 0] }] }),
    )!;
    expect(pasteFragment(emptySpec(), fragment, CATALOG, [0, 0]).nodeIds).toEqual([]);
  });
});

describe("tidy", () => {
  it("lays nodes out in columns by dependency depth", () => {
    let spec = build(["trigger.manual", "T"], ["logic.if", "Si"], ["net.http", "Sí"], ["net.http", "No"], ["logic.merge", "Unir"]);
    const [t, si, yes, no, merge] = ["T", "Si", "Sí", "No", "Unir"].map((n) => idOf(spec, n));
    for (const c of [
      { from: t, out: 0, to: si, in: 0 },
      { from: si, out: 0, to: yes, in: 0 },
      { from: si, out: 1, to: no, in: 0 },
      { from: yes, out: 0, to: merge, in: 0 },
      { from: no, out: 0, to: merge, in: 1 },
    ]) spec = connect(spec, CATALOG, c)!;
    spec = moveElements(spec, new Map([[no, [0, 50] as [number, number]]]));

    const laid = autoLayout(spec);
    const x = (id: string) => laid.nodes.find((n) => n.id === id)!.pos[0];
    const y = (id: string) => laid.nodes.find((n) => n.id === id)!.pos[1];
    expect([x(t), x(si), x(yes), x(merge)]).toEqual([0, 200, 400, 600]);
    expect(x(no)).toBe(400);
    // The two branches keep the order they had: "No" was moved below "Sí".
    expect(y(no)).toBeGreaterThan(y(yes));
  });

  it("does not run away on a loop", () => {
    let spec = build(["trigger.manual", "T"], [LOOP_TYPE, "Lotes"], ["net.http", "Cada uno"]);
    const [t, l, h] = ["T", "Lotes", "Cada uno"].map((n) => idOf(spec, n));
    for (const c of [
      { from: t, out: 0, to: l, in: 0 },
      { from: l, out: 0, to: h, in: 0 },
      { from: h, out: 0, to: l, in: 0 },
    ]) spec = connect(spec, CATALOG, c)!;
    const laid = autoLayout(spec);
    expect(laid.nodes.map((n) => n.pos[0])).toEqual([0, 200, 400]);
  });

  it("gives a node an error port while it routes failures there, and takes its wires when it stops", () => {
    let spec = build(["trigger.manual", "Start"], ["net.http", "API"], ["net.http", "Fallback"], ["logic.stop", "Stop"]);
    const api = idOf(spec, "API");
    const http = CATALOG.get("net.http");
    expect(outputCount(spec.nodes[1], http)).toBe(1);
    expect(connect(spec, CATALOG, { from: api, out: 1, to: idOf(spec, "Fallback"), in: 0 })).toBeNull();

    spec = setNodeSettings(spec, CATALOG, api, { onError: "errorOutput" });
    const routed = spec.nodes.find((n) => n.id === api)!;
    expect(hasErrorOutput(routed, http)).toBe(true);
    expect(outputCount(routed, http)).toBe(2);
    spec = connect(spec, CATALOG, { from: api, out: 1, to: idOf(spec, "Fallback"), in: 0 })!;
    expect(spec.connections).toHaveLength(1);

    // Stop never gets one, whatever its settings say.
    const stop = setNodeSettings(spec, CATALOG, idOf(spec, "Stop"), { onError: "errorOutput" });
    expect(outputCount(stop.nodes.find((n) => n.name === "Stop")!, CATALOG.get("logic.stop"))).toBe(0);

    // Back to stopping: the error port goes, and the wire from it with it.
    spec = setNodeSettings(spec, CATALOG, api, { onError: "stop" });
    expect(spec.connections).toHaveLength(0);
    expect(spec.nodes.find((n) => n.id === api)!.settings).toEqual({ onError: "stop" });
  });

  it("drops a setting set back to its default and a parameter set to undefined", () => {
    let spec = build(["net.http", "API"]);
    const api = idOf(spec, "API");
    spec = setNodeSettings(spec, CATALOG, api, { retryOnFail: true, timeoutSec: 5 });
    spec = setNodeSettings(spec, CATALOG, api, { retryOnFail: false });
    expect(spec.nodes[0].settings).toEqual({ timeoutSec: 5 });
    spec = setNodeParam(spec, api, "url", "={{ $vars.API }}/items");
    expect(spec.nodes[0].params).toEqual({ url: "={{ $vars.API }}/items" });
    spec = setNodeParam(spec, api, "url", undefined);
    expect(spec.nodes[0].params).toEqual({});
  });
});
