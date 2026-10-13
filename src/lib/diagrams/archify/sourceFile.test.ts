import { describe, expect, it } from "vitest";
import { archifyEntities, archifyRelations, parseArchify, type ArchifyDocument } from "./ir";
import { archifySourceFile, storedDocument, toArchifyJson } from "./sourceFile";
import { SAMPLES } from "./__fixtures__/samples";

/**
 * The keys archify's schemas allow on each object they validate — every level sets
 * `additionalProperties: false`, so one stray key fails the whole file. Copied from archify 3.0.1's
 * schemas rather than imported: the point is to notice if this module starts writing something
 * archify would refuse.
 */
const ALLOWED: Record<string, Record<string, string[]>> = {
  architecture: {
    root: ["schema_version", "diagram_type", "meta", "layout", "components", "boundaries", "connections", "cards"],
    components: ["id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "row", "col", "pos", "size"],
    boundaries: ["kind", "label", "wraps", "pad"],
    connections: ["id", "from", "to", "label", "variant", "fromSide", "toSide", "route", "via", "labelAt", "labelDx", "labelDy", "labelSegment", "width"],
  },
  workflow: {
    root: ["schema_version", "diagram_type", "meta", "lanes", "phases", "groups", "mainPath", "semanticChecks", "nodes", "edges", "cards"],
    lanes: ["id", "label", "variant"],
    phases: ["id", "label", "fromCol", "toCol", "variant"],
    groups: ["id", "label", "lane", "fromCol", "toCol", "variant"],
    nodes: ["id", "lane", "col", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "width", "height", "yOffset"],
    edges: ["id", "from", "to", "label", "variant", "role", "fromSide", "toSide", "route", "via", "labelAt", "labelDx", "labelDy", "labelSegment", "channelX", "channelY", "bias", "width"],
  },
  sequence: {
    root: ["schema_version", "diagram_type", "meta", "participants", "segments", "messages", "activations", "cards"],
    participants: ["id", "type", "label", "sublabel", "icon", "brand", "sources"],
    segments: ["from", "to", "label"],
    messages: ["id", "from", "to", "y", "label", "variant", "note"],
    activations: ["participant", "from", "to", "type"],
  },
  dataflow: {
    root: ["schema_version", "diagram_type", "meta", "stages", "nodes", "flows", "cards"],
    stages: ["label"],
    nodes: ["id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "stage", "row", "width", "height", "yOffset"],
    flows: ["id", "from", "to", "label", "classification", "variant", "route", "fromSide", "toSide", "channelX", "channelY", "labelAt", "labelDx", "labelDy", "labelSegment", "via", "width"],
  },
  lifecycle: {
    root: ["schema_version", "diagram_type", "meta", "lanes", "states", "transitions", "cards"],
    lanes: ["id", "label"],
    states: ["id", "type", "label", "sublabel", "tag", "icon", "brand", "sources", "step", "lane", "col", "width", "height", "yOffset"],
    transitions: ["id", "from", "to", "label", "note", "variant", "route", "fromSide", "toSide", "channelX", "channelY", "cornerRadius", "labelAt", "labelDx", "labelDy", "labelSegment", "via", "width"],
  },
};
const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const TYPES = ["frontend", "backend", "database", "cloud", "security", "messagebus", "external"];
const STATES = ["start", "active", "waiting", "decision", "success", "failure", "neutral", "external"];

function onlyAllowed(value: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(value)) expect(allowed, `${where} has "${key}"`).toContain(key);
}

/** The constraints of archify's schemas this module can break, checked on a file it wrote. */
function expectArchifyAccepts(file: string) {
  const doc = JSON.parse(file) as Record<string, unknown> & { diagram_type: string; meta: Record<string, unknown> };
  const allowed = ALLOWED[doc.diagram_type];
  expect(allowed, doc.diagram_type).toBeTruthy();
  onlyAllowed(doc, allowed.root, "document");
  expect(doc.meta.output).toMatch(/^[^/]+(?:\/[^/]+)*\.html$/);
  expect(String(doc.meta.title).length).toBeGreaterThan(0);
  const pinned = !!doc.meta.repository;
  const ids = new Set<string>();
  const list = (key: string) => (doc[key] ?? []) as Record<string, unknown>[];
  for (const key of Object.keys(allowed).filter((k) => k !== "root")) {
    for (const item of list(key)) {
      onlyAllowed(item, allowed[key], `${key} item`);
      if (typeof item.id === "string") expect(item.id).toMatch(ID);
      if ("type" in item) expect([...TYPES, ...STATES]).toContain(item.type);
      if ("sources" in item) {
        expect(pinned, "sources need a pinned repository").toBe(true);
        expect((item.sources as unknown[]).length).toBeLessThanOrEqual(3);
      }
    }
  }
  const entities = list(doc.diagram_type === "architecture" ? "components" : doc.diagram_type === "sequence" ? "participants" : doc.diagram_type === "lifecycle" ? "states" : "nodes");
  entities.forEach((e) => ids.add(String(e.id)));
  const relations = list(doc.diagram_type === "architecture" ? "connections" : doc.diagram_type === "workflow" ? "edges" : doc.diagram_type === "sequence" ? "messages" : doc.diagram_type === "dataflow" ? "flows" : "transitions");
  for (const r of relations) expect(ids.has(String(r.from)) && ids.has(String(r.to)), "ends exist").toBe(true);

  const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  if (doc.diagram_type === "architecture") for (const c of entities) expect(Array.isArray(c.pos), `${c.id} placed`).toBe(true);
  if (doc.diagram_type === "workflow") for (const n of entities) { expect(int(n.col) && (n.col as number) <= 5).toBe(true); expect(typeof n.lane).toBe("string"); }
  if (doc.diagram_type === "lifecycle") for (const s of entities) { expect(int(s.col) && (s.col as number) <= 4).toBe(true); expect(STATES).toContain(s.type); }
  if (doc.diagram_type === "dataflow") for (const n of entities) expect(int(n.stage) && int(n.row)).toBe(true);
  if (doc.diagram_type === "sequence") {
    const ys = relations.map((m) => m.y as number);
    expect(ys.every((y) => y >= 160)).toBe(true);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  }
}

function parsed(raw: unknown): ArchifyDocument {
  const result = parseArchify(JSON.stringify(raw), "Sample");
  if ("error" in result) throw new Error(result.error);
  return result.ir;
}

describe.each(Object.entries(SAMPLES))("the %s sample as an archify file", (_name, sample) => {
  const ir = parsed(sample);

  it("is a file archify's schema accepts", () => {
    expectArchifyAccepts(archifySourceFile(JSON.stringify(sample), ir));
  });

  it("round-trips: read back, it holds the same entities, relations and labels", () => {
    const again = parsed(JSON.parse(archifySourceFile(JSON.stringify(sample), ir)));
    expect(archifyEntities(again).map((e) => [e.id, e.kind, e.label])).toEqual(archifyEntities(ir).map((e) => [e.id, e.kind, e.label]));
    expect(archifyRelations(again).map((r) => [r.from, r.to, r.label, r.style])).toEqual(archifyRelations(ir).map((r) => [r.from, r.to, r.label, r.style]));
  });

  it("is what a repository keeps: the same, and it reads back the same", () => {
    const stored = storedDocument(ir);
    const again = parsed(JSON.parse(stored));
    expect(archifyEntities(again).map((e) => e.id)).toEqual(archifyEntities(ir).map((e) => e.id));
    expect(archifyRelations(again).length).toBe(archifyRelations(ir).length);
  });
});

describe("what an export may and may not carry", () => {
  it("leaves the sources out until a repository is pinned, and keeps them after", () => {
    const ir = parsed(SAMPLES.ARCHITECTURE);
    expect(archifySourceFile("{}", ir)).not.toContain('"sources"');
    if (ir.diagram_type !== "architecture") throw new Error();
    ir.meta.repository = { url: "https://github.com/example/shop.git", revision: "a".repeat(40), provider: "github", link_mode: "web" };
    const file = archifySourceFile("{}", ir);
    expect(file).toContain('"sources"');
    expectArchifyAccepts(file);
  });

  it("names the output after the title, never a name Windows reserves", () => {
    const ir = parsed({ meta: { title: "CON" }, components: [{ id: "a", type: "backend", label: "A" }] });
    expect(JSON.parse(archifySourceFile("{}", ir)).meta.output).toBe("con-map.html");
  });

  it("hands back an archify file that needs nothing, byte for byte, unknown fields and all", () => {
    const original =
      '{\n  "schema_version": 1,\n  "diagram_type": "architecture",\n  "meta": { "title": "Web", "output": "web.html" },\n' +
      '  "components": [\n    { "id": "users", "type": "external", "label": "Users", "icon": "person", "pos": [40, 300], "size": [120, 60] }\n  ]\n}\n';
    expect(archifySourceFile(original, parsed(JSON.parse(original)))).toBe(original);
  });

  it("stores an architecture without positions, so a better layout can still reach it", () => {
    const stored = JSON.parse(storedDocument(parsed(SAMPLES.ARCHITECTURE)));
    expect(stored.components.every((c: Record<string, unknown>) => !("pos" in c))).toBe(true);
    expect(toArchifyJson(parsed(SAMPLES.ARCHITECTURE)).components).toBeTruthy();
  });
});
