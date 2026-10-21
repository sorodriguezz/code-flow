import { describe, expect, it } from "vitest";
import { applyChanges, splitAnswer } from "./aiBlocks";
import { addComponentAt, addZoneAt, clearPositions, connect, moveNode, parentZoneOf, removeElements } from "./canvasOps";
import { categoryFor } from "./catalog";
import { appendAt, formatDoc, pathAt, rangeOf, removeAt, setAt } from "./jsonEdit";
import { layoutDoc } from "./layout";
import { jsoncToJson, parseArchText, validateDoc } from "./parse";
import { detectPatterns } from "./patterns";
import { review } from "./rules";
import { simulate } from "./sim";
import { renderSvg, LIGHT_PALETTE } from "./svg";
import { exampleDoc as templateDoc, EXAMPLE_IDS as TEMPLATE_IDS } from "./examples.fixture";
import { blankDoc } from "./templates";
import { resolveComponents, resourceFor, variesByEnvironment, type ArchDoc } from "./types";

const META = { version: "Version", date: "Date", environment: "Environment", owner: "Owner", author: "Author" };
const bookings = () => templateDoc("azureAks", "en", "2026-10-21");

describe("reading", () => {
  it("accepts comments and trailing commas without moving positions", () => {
    const src = '{\n  // a note\n  "a": 1, /* inline */\n  "b": [1, 2,],\n}\n';
    expect(jsoncToJson(src).length).toBe(src.length);
    const r = parseArchText(src);
    expect(r.ok && r.doc).toEqual({ a: 1, b: [1, 2] });
  });

  it("reports where a missing comma is", () => {
    const r = parseArchText('{\n  "a": 1\n  "b": 2\n}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.line).toBe(3);
      expect(["missingComma", "unexpectedToken", "invalid"]).toContain(r.error.code);
    }
  });

  it("refuses a document that is not an object", () => {
    const r = parseArchText("[1, 2]");
    expect(r.ok).toBe(false);
  });

  it("warns about references the drawing cannot honour", () => {
    const doc: ArchDoc = {
      layout: ["a", "ghost", "a"],
      components: { a: { name: "A" }, lonely: { name: "L" } },
      connections: [{ from: "a", to: "nobody", step: 3 }],
      notes: [{ id: "N1", on: "nowhere" }],
    };
    const codes = validateDoc(doc).map((w) => w.code).sort();
    expect(codes).toEqual(["noteTarget", "notPlaced", "placedTwice", "stepWithoutText", "unknownEndpoint", "unknownInLayout"].sort());
  });

  it("fills {env} or picks the environment's own name", () => {
    expect(resourceFor("aks-{env}-x", "prd")).toBe("aks-prd-x");
    expect(resourceFor({ dev: "d", prd: "p" }, "dev")).toBe("d");
  });
});

describe("text edits", () => {
  const src = '{\n  // keep me\n  "components": {\n    "a": { "name": "A" }\n  },\n  "connections": []\n}\n';

  it("replaces one value and keeps comments", () => {
    const out = setAt(src, ["components", "a", "name"], "Alpha");
    expect(out).toContain("// keep me");
    expect(JSON.parse(jsoncToJson(out)).components.a.name).toBe("Alpha");
  });

  it("adds a missing key, a new object and an array item", () => {
    let out = setAt(src, ["components", "a", "sim", "replicas"], 2);
    out = setAt(out, ["components", "b"], { name: "B" });
    out = appendAt(out, ["connections"], { from: "a", to: "b" });
    const doc = JSON.parse(jsoncToJson(out));
    expect(doc.components.a.sim).toEqual({ replicas: 2 });
    expect(doc.components.b).toEqual({ name: "B" });
    expect(doc.connections).toEqual([{ from: "a", to: "b" }]);
    expect(out).toContain("// keep me");
  });

  it("removes a property or an item with its comma", () => {
    let out = setAt(src, ["components", "b"], { name: "B" });
    out = removeAt(out, ["components", "a"]);
    expect(JSON.parse(jsoncToJson(out)).components).toEqual({ b: { name: "B" } });
    const arr = '{ "x": [1, 2, 3] }';
    expect(JSON.parse(removeAt(arr, ["x", 1])).x).toEqual([1, 3]);
    expect(JSON.parse(removeAt(arr, ["x", 2])).x).toEqual([1, 2]);
  });

  it("knows what the caret is inside", () => {
    const text = formatDoc(bookings());
    const at = text.indexOf('"Integration Core"');
    expect(pathAt(text, at).slice(0, 2)).toEqual(["components", "core_integration"]);
    const r = rangeOf(text, ["components", "redis"]);
    expect(r && text.slice(r.start, r.start + 1)).toBe("{");
  });
});

describe("layout", () => {
  for (const id of TEMPLATE_IDS) {
    it(`places ${id} without overlaps and inside its zones`, () => {
      const doc = templateDoc(id, "en", "2026-10-21");
      const comps = resolveComponents(doc);
      const scene = layoutDoc(doc, comps, { env: "prd", metaLabels: META });
      expect(scene.cards.length).toBe(Object.keys(doc.components ?? {}).length);
      for (let i = 0; i < scene.cards.length; i++)
        for (let j = i + 1; j < scene.cards.length; j++) {
          const [a, b] = [scene.cards[i].box, scene.cards[j].box];
          const overlap = a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
          expect(overlap, `${scene.cards[i].id} × ${scene.cards[j].id}`).toBe(false);
        }
      for (const c of scene.cards) {
        expect(c.box[0] + c.box[2]).toBeLessThanOrEqual(scene.width);
        expect(c.box[1] + c.box[3]).toBeLessThanOrEqual(scene.height);
      }
      const routable = (doc.connections ?? []).filter((e) => e.from !== e.to && comps[e.from] && comps[e.to]).length;
      expect(scene.edges.length).toBe(routable);
      for (const e of scene.edges) expect(e.points.length).toBeGreaterThanOrEqual(2);
    });
  }

  it("keeps every card of a zone inside that zone", () => {
    const doc = bookings();
    const scene = layoutDoc(doc, resolveComponents(doc), { env: "prd", metaLabels: META });
    const pool = scene.zones.find((z) => z.id === "pool")!;
    for (const id of ["db_catalog", "db_bookings", "db_rules"]) {
      const b = scene.cards.find((c) => c.id === id)!.box;
      expect(b[0]).toBeGreaterThanOrEqual(pool.box[0]);
      expect(b[0] + b[2]).toBeLessThanOrEqual(pool.box[0] + pool.box[2]);
      expect(b[1] + b[3]).toBeLessThanOrEqual(pool.box[1] + pool.box[3]);
    }
    expect(scene.zones.find((z) => z.id === "aks")!.title).toBe("aks-prd-bookings");
  });

  it("renders an SVG with the cards, arrows and panels", () => {
    const doc = bookings();
    const scene = layoutDoc(doc, resolveComponents(doc), { env: "prd", metaLabels: META });
    const labels = { flow: "Data flow", notes: "Notes", legend: "Legend", sync: "Sync call", async: "Async / event", step: "Flow step", own: "Project component", shared: "Shared component", note: "Note", categories: { actor: "People", compute: "Compute", data: "Data", messaging: "Messaging", network: "Network", identity: "Identity", security: "Security", observability: "Observability", external: "External" } };
    const svg = renderSvg(scene, { palette: LIGHT_PALETTE, missingLabel: "missing", panels: { doc, labels }, background: true });
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/class="card"/g) ?? []).length).toBe(scene.cards.length);
    expect(svg).toContain("Data flow");
    expect(svg).not.toMatch(/undefined|NaN/);
  });
});

describe("capacity model", () => {
  it("holds the bookings template at 1× and names its first bottleneck", () => {
    const doc = bookings();
    const s = simulate(doc, resolveComponents(doc), 1, new Set());
    expect(s.verdict).toBe("ok");
    expect(s.entry).toBe(135);
    expect(s.firstToBreak).toBe("core_integration");
    expect(s.breakAt).toBeGreaterThan(1.2);
    expect(s.breakAt).toBeLessThan(1.6);
    expect(s.syncSteps).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("fails part of the bookings when the integration core is off, and queues the rest", () => {
    const doc = bookings();
    const s = simulate(doc, resolveComponents(doc), 1, new Set(["core_integration"]));
    expect(s.verdict).toBe("fails");
    expect(s.flowError).toBeGreaterThan(0.25);
    expect(s.flowError).toBeLessThan(0.35);
    expect(s.backlogs.some((b) => b.queue === "queue_out")).toBe(true);
  });

  it("splits a router's traffic and lets a service call each dependency", () => {
    const doc: ArchDoc = {
      components: { u: { category: "actor", sim: { rps: 100 } }, lb: { category: "network" }, a: { category: "compute" }, b: { category: "compute" }, db: { category: "data" } },
      connections: [{ from: "u", to: "lb" }, { from: "lb", to: "a" }, { from: "lb", to: "b" }, { from: "a", to: "db" }],
    };
    const s = simulate(doc, resolveComponents(doc), 1, new Set());
    expect(s.metrics.a.load).toBeCloseTo(50);
    expect(s.metrics.b.load).toBeCloseTo(50);
    expect(s.metrics.db.load).toBeCloseTo(50);
  });
});

describe("review and patterns", () => {
  it("finds what the reference diagram is missing", () => {
    const doc = bookings();
    const rules = review(doc, resolveComponents(doc)).map((f) => f.rule);
    expect(rules).toContain("observabilityNoted");
    expect(rules).toContain("singlePoint");
    expect(rules).toContain("longChain");
    expect(rules).toContain("sharedDatabase");
    expect(rules).toContain("notTwice");
    expect(rules).toContain("noDeadLetter");
    expect(rules).toContain("riskHigh");
    expect(rules).not.toContain("noWaf");
  });

  it("recognises the patterns it uses", () => {
    const doc = bookings();
    const ids = detectPatterns(doc, resolveComponents(doc), "and").map((p) => p.id);
    for (const id of ["gateway", "bff", "outbox", "cacheAside", "loadLeveling", "asyncRequestReply", "antiCorruption"]) expect(ids).toContain(id);
  });

  it("starts every template clean of reference warnings", () => {
    for (const id of TEMPLATE_IDS) {
      const doc = templateDoc(id, "es", "2026-10-21");
      expect(validateDoc(doc), id).toEqual([]);
    }
  });
});

describe("the assistant's proposals", () => {
  const answer = (ops: unknown[]) => "Text before.\n\n```arch-patch\n" + JSON.stringify([{ title: "T", why: "W", ops }]) + "\n```\n";

  it("reads a patch block out of the prose", () => {
    const r = splitAnswer(answer([{ op: "set", path: ["components", "core_rules", "sim", "replicas"], value: 2 }]));
    expect(r.text).toBe("Text before.");
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].ops[0]).toEqual({ op: "set", path: ["components", "core_rules", "sim", "replicas"], value: 2 });
  });

  it("applies a change in place and keeps the comments around it", () => {
    const text = '{\n  // the services\n  "components": {\n    "api": { "name": "API" } // the only one\n  }\n}\n';
    const out = applyChanges(text, splitAnswer(answer([{ op: "set", path: ["components", "api", "sim", "replicas"], value: 2 }])).changes);
    expect(out).toContain("// the services");
    expect(out).toContain("// the only one");
    const r = parseArchText(out);
    expect(r.ok && r.doc.components?.api.sim?.replicas).toBe(2);
  });

  it("refuses to edit inside a component the document does not have", () => {
    const text = formatDoc(bookings());
    const { changes } = splitAnswer(answer([{ op: "set", path: ["components", "api", "sim", "replicas"], value: 2 }]));
    expect(() => applyChanges(text, changes)).toThrow(/components\.api/);
    // A whole new component is a different thing, and allowed.
    const add = splitAnswer(answer([{ op: "set", path: ["components", "api"], value: { name: "API" } }])).changes;
    expect(parseArchText(applyChanges(text, add)).ok).toBe(true);
  });
});

describe("the canvas", () => {
  const small = (): ArchDoc => ({
    layout: [{ id: "cloud", title: "Cloud", style: "cloud", children: [{ id: "k8s", title: "Cluster", style: "cluster", children: ["api", "worker"] }, "db"] }, "user"],
    components: { user: { name: "User", category: "actor" }, api: { name: "API", category: "compute" }, worker: { name: "Worker", category: "compute" }, db: { name: "DB", category: "data" } },
    connections: [{ from: "user", to: "api" }, { from: "api", to: "db" }, { from: "worker", to: "db" }],
  });
  const scene = (doc: ArchDoc) => layoutDoc(doc, resolveComponents(doc), { env: "prd", metaLabels: META });
  const box = (doc: ArchDoc, id: string) => { const s = scene(doc); return (s.cards.find((c) => c.id === id) ?? s.zones.find((z) => z.id === id))!.box; };

  it("puts a placed card where it was dropped, relative to its zone", () => {
    const doc = small();
    const k8s = box(doc, "k8s");
    const moved = moveNode(doc, "api", "k8s", { x: 300, y: 200 });
    expect(box(moved, "api").slice(0, 2)).toEqual([k8s[0] + 300, k8s[1] + 200]);
    // The zone grew to hold it.
    expect(box(moved, "k8s")[2]).toBeGreaterThan(300 + 228);
  });

  it("moves what is inside a zone with it", () => {
    const doc = small();
    const before = box(doc, "worker"), zone = box(doc, "k8s"), cloud = box(doc, "cloud");
    const moved = moveNode(doc, "k8s", "cloud", { x: zone[0] - cloud[0] + 100, y: zone[1] - cloud[1] + 40 });
    expect(box(moved, "worker").slice(0, 2)).toEqual([before[0] + 100, before[1] + 40]);
  });

  it("moves a card into another zone and back out, and «Ordenar» forgets where", () => {
    let doc = moveNode(small(), "db", "k8s", { x: 20, y: 300 });
    expect(parentZoneOf(doc.layout, "db")).toBe("k8s");
    doc = moveNode(doc, "db", null, { x: 1400, y: 120 });
    expect(parentZoneOf(doc.layout, "db")).toBe(null);
    expect(clearPositions(doc).positions).toBeUndefined();
    expect(validateDoc(doc)).toEqual([]);
  });

  it("never moves a zone into itself", () => {
    const doc = moveNode(small(), "cloud", "k8s", { x: 10, y: 10 });
    expect(parentZoneOf(doc.layout, "cloud")).toBe(null);
    expect(parentZoneOf(doc.layout, "k8s")).toBe("cloud");
  });

  it("drops new components and zones where they were let go", () => {
    const { doc, id } = addZoneAt(small(), { title: "Data", style: "tier" }, "cloud", { x: 40, y: 400 });
    const added = addComponentAt(doc, { name: "Cache", category: "data" }, id, { x: 20, y: 30 });
    expect(parentZoneOf(added.doc.layout, added.id)).toBe(id);
    expect(added.id).toBe("cache");
    expect(validateDoc(added.doc)).toEqual([]);
  });

  it("connects once, and deletes a zone handing its contents to the parent", () => {
    const first = connect(small(), { from: "user", to: "db" });
    expect(connect(first.doc, { from: "user", to: "db" }).index).toBe(first.index);
    const unwrapped = removeElements(first.doc, { zones: ["k8s"] });
    expect(parentZoneOf(unwrapped.layout, "api")).toBe("cloud");
    expect(unwrapped.connections).toHaveLength(4);
    const gone = removeElements(first.doc, { zones: ["k8s"], withContent: true });
    expect(gone.components?.api).toBeUndefined();
    expect(gone.connections?.every((e) => e.from !== "api" && e.to !== "api" && e.from !== "worker")).toBe(true);
    expect(validateDoc(gone)).toEqual([]);
  });

  it("reads a provider icon's category from its group and its name", () => {
    expect(categoryFor("Azure SQL", "databases")).toBe("data");
    expect(categoryFor("Web Application Firewall Policies(WAF)", "networking")).toBe("security");
    expect(categoryFor("Cloud Pub/Sub", "products")).toBe("messaging");
    expect(categoryFor("Cloud Run", "products")).toBe("compute");
    expect(categoryFor("Application Gateway for Containers", "networking")).toBe("network");
  });
});

describe("a new document", () => {
  it("is an empty sheet that lays out and validates", () => {
    const doc = blankDoc("New", "es", "2026-10-21");
    expect(Object.keys(doc.components ?? {})).toEqual([]);
    expect(validateDoc(doc)).toEqual([]);
    const scene = layoutDoc(doc, resolveComponents(doc), { env: "prd", metaLabels: META });
    expect(scene.cards).toEqual([]);
  });
});

describe("the environment switch", () => {
  const envs = { meta: { environments: { dev: "Desarrollo", prd: "Producción" } } };
  it("has nothing to switch on a document whose names do not depend on the environment", () => {
    expect(variesByEnvironment({ ...envs, components: { api: { name: "API", resource: "api-main" } } })).toBe(false);
    expect(variesByEnvironment({ ...envs, components: { api: { resource: { dev: "same", prd: "same" } } } })).toBe(false);
  });
  it("switches a resource with {env} in it, one named per environment, or a zone title", () => {
    expect(variesByEnvironment({ components: { api: { resource: "api-{env}" } } })).toBe(true);
    expect(variesByEnvironment({ components: { api: { resource: { dev: "api-d", prd: "api-p" } } } })).toBe(true);
    expect(variesByEnvironment({ layout: [{ row: [{ id: "rg", title: "rg-{env}", children: ["api"] }] }] })).toBe(true);
  });
});
