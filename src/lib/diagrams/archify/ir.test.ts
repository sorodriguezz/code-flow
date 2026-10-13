import { describe, expect, it } from "vitest";
import {
  activationsOf,
  archifyDocKind,
  archifyEntities,
  archifyRelations,
  archifyType,
  isArchifyHtml,
  lifecycleType,
  parseArchify,
  type ArchifyDocument,
  type ArchifySequence,
} from "./ir";
import { SAMPLES } from "./__fixtures__/samples";

function parsed(raw: unknown): ArchifyDocument {
  const result = parseArchify(typeof raw === "string" ? raw : JSON.stringify(raw), "Fallback");
  if ("error" in result) throw new Error(result.error);
  return result.ir;
}

describe("parseArchify: architecture", () => {
  const engine = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: { title: "Shop", subtitle: "Orders flow from the web app to the API.", generator: "model" },
    components: [
      { id: "web app", type: "ui", label: "Web app", sublabel: "React", description: "not archify's" },
      { id: "api", type: "service", label: "API", sources: [{ path: "src/api.ts", line: 3, end_line: 9 }, "../etc/passwd"] },
      { id: "jobs", type: "queue", label: "Jobs" },
      { id: "db", type: "cache", label: "Redis", pos: "nowhere" },
      { id: "users", type: "user", label: "Customers" },
      { label: "" },
    ],
    boundaries: [
      { kind: "trust boundary", label: "Backend", wraps: ["api", "jobs", "ghost"] },
      { kind: "zone", label: "Empty", wraps: ["ghost"] },
    ],
    connections: [
      { from: "users", to: "web app", label: "browses", variant: "main" },
      { from: "web app", to: "api", label: "HTTPS", kind: "sync" },
      { from: "api", to: "jobs", label: "enqueue", variant: "async" },
      { from: "api", to: "db", label: "cache" },
      { from: "api", to: "api", label: "self" },
      { from: "api", to: "ghost" },
      { from: "web app", to: "api", label: "HTTPS" },
    ],
    cards: [{ dot: "pink", title: "Flow", items: ["Orders are queued"] }, { title: "No items", items: [] }],
  };
  const ir = parsed(engine);

  it("maps an engine's own words onto archify's seven types", () => {
    expect(archifyType("service")).toBe("backend");
    expect(archifyType("queue")).toBe("messagebus");
    expect(archifyType("cache")).toBe("database");
    expect(archifyType("user")).toBe("external");
    expect(archifyType("ui")).toBe("frontend");
    expect(archifyType("oauth")).toBe("security");
    expect(archifyType("cdn")).toBe("cloud");
    expect(archifyType("something else")).toBe("backend");
    if (ir.diagram_type !== "architecture") throw new Error();
    expect(ir.components.map((c) => c.type)).toEqual(["frontend", "backend", "messagebus", "database", "external"]);
  });

  it("repairs ids, follows them into boundaries and connections, and drops what archify would refuse", () => {
    if (ir.diagram_type !== "architecture") throw new Error();
    expect(ir.components.map((c) => c.id)).toEqual(["web-app", "api", "jobs", "db", "users"]);
    expect(ir.boundaries).toEqual([{ kind: "security-group", label: "Backend", wraps: ["api", "jobs"] }]);
    expect(ir.connections.map((c) => `${c.from}>${c.to}:${c.variant ?? "default"}`)).toEqual([
      "users>web-app:emphasis",
      "web-app>api:emphasis",
      "api>jobs:dashed",
      "api>db:default",
    ]);
    expect(ir.components[0]).not.toHaveProperty("description");
    expect(ir.components[3]).not.toHaveProperty("pos");
    expect(ir.components[1].sources).toEqual([{ path: "src/api.ts", line: 3, end_line: 9 }]);
    expect(ir.cards).toEqual([{ dot: "cyan", title: "Flow", items: ["Orders are queued"] }]);
    expect(ir.meta).toEqual({ title: "Shop", subtitle: "Orders flow from the web app to the API." });
  });
});

describe("parseArchify: the other four types", () => {
  it("reads a workflow: lanes by id or by name, a node in an unknown lane lands in the first", () => {
    const ir = parsed({
      diagram_type: "workflow",
      lanes: ["Customer", { name: "API" }],
      nodes: [
        { id: "a", lane: "Customer", col: 0, label: "Order", type: "ui" },
        { id: "b", lane: "API", col: 1, label: "Validate" },
        { id: "c", lane: "nowhere", label: "Done" },
      ],
      edges: [{ from: "a", to: "b", role: "main" }, { from: "b", to: "c", role: "teleport" }],
      mainPath: ["a", "b", "missing"],
    });
    if (ir.diagram_type !== "workflow") throw new Error();
    expect(ir.lanes.map((l) => l.id)).toEqual(["Customer", "API"]);
    expect(ir.nodes.map((n) => n.lane)).toEqual(["Customer", "API", "Customer"]);
    expect(ir.nodes[0].type).toBe("frontend");
    expect(ir.nodes[2].col).toBeUndefined();
    expect(ir.edges[1].role).toBeUndefined();
    expect(ir.mainPath).toEqual(["a", "b"]);
  });

  it("reads a sequence in the order it was written, keeping a retry and a self-call", () => {
    const ir = parsed(SAMPLES.SEQUENCE) as ArchifySequence;
    expect(ir.messages.map((m) => m.label)).toEqual(["POST /orders", "verify JWT", "claims", "validate body", "INSERT order", "order id", "enqueue fulfilment", "201 Created"]);
    expect(ir.messages[3]).toMatchObject({ from: "api", to: "api" });
    expect(ir.messages[7].note).toBe("Fulfilment continues asynchronously.");
    expect(ir.phases).toEqual([{ label: "Authenticate", from: 1, to: 2 }, { label: "Persist", from: 4, to: 6 }]);
    const again = parsed({ ...SAMPLES.SEQUENCE, messages: [...SAMPLES.SEQUENCE.messages.slice(0, 2), SAMPLES.SEQUENCE.messages[1]] }) as ArchifySequence;
    expect(again.messages).toHaveLength(3);
  });

  it("reads archify's own y-based sequence: order by y, bands and activations by y", () => {
    const ir = parsed({
      diagram_type: "sequence",
      participants: [{ id: "a", type: "frontend", label: "A" }, { id: "b", type: "backend", label: "B" }],
      messages: [
        { from: "b", to: "a", y: 240, label: "late", variant: "return" },
        { from: "a", to: "b", y: 180, label: "early" },
      ],
      segments: [{ from: 170, to: 200, label: "First" }],
      activations: [{ participant: "b", from: 170, to: 250 }],
    }) as ArchifySequence;
    expect(ir.messages.map((m) => m.label)).toEqual(["early", "late"]);
    expect(ir.phases).toEqual([{ label: "First", from: 0, to: 0 }]);
    expect(activationsOf(ir)).toEqual([{ participant: "b", from: 0, to: 1 }]);
  });

  it("derives activations from calls and their replies", () => {
    const ir = parsed(SAMPLES.SEQUENCE) as ArchifySequence;
    // The API is on for the whole request — from the call into it to its 201 — and the two it calls
    // are on for the span of their own call and reply.
    expect(activationsOf(ir)).toEqual([
      { participant: "api", from: 0, to: 7 },
      { participant: "auth", from: 1, to: 2 },
      { participant: "db", from: 4, to: 5 },
    ]);
  });

  it("reads a dataflow: stage labels as strings or objects, a flow's classification kept", () => {
    const ir = parsed({
      diagram_type: "dataflow",
      stages: ["Sources", { label: "Serve" }],
      nodes: [{ id: "a", label: "A", type: "db", stage: 0, row: 0 }, { id: "b", label: "B", stage: 1 }],
      flows: [{ from: "a", to: "b", label: "rows", classification: "PII" }],
    });
    if (ir.diagram_type !== "dataflow") throw new Error();
    expect(ir.stages.map((s) => s.label)).toEqual(["Sources", "Serve"]);
    expect(ir.nodes[0].type).toBe("database");
    expect(ir.nodes[1].row).toBeUndefined();
    expect(ir.flows[0].classification).toBe("PII");
  });

  it("reads a lifecycle: the words become state types, a self-loop survives", () => {
    expect(lifecycleType("pending")).toBe("waiting");
    expect(lifecycleType("Cancelled")).toBe("failure");
    expect(lifecycleType("completed")).toBe("success");
    expect(lifecycleType("whatever")).toBe("neutral");
    const ir = parsed(SAMPLES.LIFECYCLE);
    if (ir.diagram_type !== "lifecycle") throw new Error();
    expect(ir.transitions.some((t) => t.from === "shipped" && t.to === "shipped")).toBe(true);
    expect(ir.states.find((s) => s.id === "review")!.type).toBe("decision");
  });

  it("infers the type when the document does not say", () => {
    expect(parsed({ participants: [{ id: "a", label: "A" }, { id: "b", label: "B" }], messages: [{ from: "a", to: "b", label: "hi" }] }).diagram_type).toBe("sequence");
    expect(parseArchify(JSON.stringify({ participants: [{ id: "a", label: "A" }], messages: [] }))).toEqual({ error: "entities" });
    expect(parsed({ states: [{ id: "a", label: "A" }] }).diagram_type).toBe("lifecycle");
    expect(parsed({ stages: ["x"], nodes: [{ id: "a", label: "A" }] }).diagram_type).toBe("dataflow");
    expect(parsed({ nodes: [{ id: "a", label: "A" }] }).diagram_type).toBe("workflow");
  });
});

describe("what every type gives the viewer", () => {
  it.each(Object.entries(SAMPLES))("%s: entities and relations, ids unique, ends that exist", (_name, sample) => {
    const ir = parsed(sample);
    const entities = archifyEntities(ir);
    const relations = archifyRelations(ir);
    expect(new Set(entities.map((e) => e.id)).size).toBe(entities.length);
    const ids = new Set(entities.map((e) => e.id));
    for (const r of relations) {
      expect(ids.has(r.from) && ids.has(r.to)).toBe(true);
    }
    expect(relations.length).toBeGreaterThan(3);
  });
});

describe("telling what a diagram holds", () => {
  it("separates a rendered page from a document, and says why a text is neither", () => {
    const page = '<!doctype html><html><head><meta name="generator" content="archify 3.0.1"></head></html>';
    expect(archifyDocKind(page)).toEqual({ kind: "html" });
    expect(isArchifyHtml(page)).toBe(true);
    expect(isArchifyHtml("<!doctype html><html><head></head></html>")).toBe(false);
    expect(archifyDocKind(JSON.stringify(SAMPLES.WORKFLOW)).kind).toBe("document");
    expect(parseArchify("")).toEqual({ error: "empty" });
    expect(parseArchify("{nope")).toEqual({ error: "json" });
    expect(parseArchify("[]")).toEqual({ error: "json" });
    expect(parseArchify('{"components": []}')).toEqual({ error: "entities" });
    expect(parseArchify('{"diagram_type": "pie", "slices": []}')).toEqual({ error: "mode", mode: "pie" });
  });
});
