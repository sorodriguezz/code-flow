import { describe, expect, it } from "vitest";
import { parseArchify, type ArchifyDocument } from "../ir";
import type { ArchifyScene, Box, Pt } from "../scene";
import { API_SAAS, SAMPLES } from "../__fixtures__/samples";
import { buildScene } from "./build";

function scene(sample: unknown): ArchifyScene {
  const parsed = parseArchify(JSON.stringify(sample), "Sample");
  if ("error" in parsed) throw new Error(parsed.error);
  return buildScene(parsed.ir as ArchifyDocument, { linkSources: false });
}

const overlaps = (a: Box, b: Box, pad = 0) =>
  a[0] < b[0] + b[2] + pad && b[0] < a[0] + a[2] + pad && a[1] < b[1] + b[3] + pad && b[1] < a[1] + a[3] + pad;

/** Whether the open segment a→b passes through the inside of `box`. */
function cuts(a: Pt, b: Pt, box: Box, inset = 1): boolean {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  return x0 < box[0] + box[2] - inset && x1 > box[0] + inset && y0 < box[1] + box[3] - inset && y1 > box[1] + inset;
}

describe.each(Object.entries({ ...SAMPLES, API_SAAS }))("layout of the %s sample", (_name, sample) => {
  const built = scene(sample);

  it("places every entity, none on top of another", () => {
    expect(built.nodes.length).toBeGreaterThan(2);
    const boxes = built.nodes.map((n) => n.box);
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) expect(overlaps(boxes[a], boxes[b]), `${built.nodes[a].id} / ${built.nodes[b].id}`).toBe(false);
    }
    for (const n of built.nodes) for (const v of n.box) expect(Number.isFinite(v)).toBe(true);
  });

  it("fits everything it drew inside its bounds", () => {
    const [bx, by, bw, bh] = built.bounds;
    for (const part of [...built.nodes.map((n) => n.box), ...built.frames.map((f) => f.box)]) {
      expect(part[0]).toBeGreaterThanOrEqual(bx);
      expect(part[1]).toBeGreaterThanOrEqual(by);
      expect(part[0] + part[2]).toBeLessThanOrEqual(bx + bw);
      expect(part[1] + part[3]).toBeLessThanOrEqual(by + bh);
    }
  });
});

describe.each(["ARCHITECTURE", "WORKFLOW", "DATAFLOW", "LIFECYCLE", "API_SAAS"] as const)("routing of the %s sample", (name) => {
  const built = scene(name === "API_SAAS" ? API_SAAS : SAMPLES[name]);
  const byId = new Map(built.nodes.map((n) => [n.id, n]));

  it("routes every relation as straight orthogonal segments", () => {
    expect(built.edges.length).toBeGreaterThan(3);
    for (const edge of built.edges) {
      for (let i = 1; i < edge.points.length; i++) {
        const [a, b] = [edge.points[i - 1], edge.points[i]];
        expect(Math.abs(a[0] - b[0]) < 0.01 || Math.abs(a[1] - b[1]) < 0.01, `${edge.id} turns diagonally`).toBe(true);
      }
    }
  });

  it("never runs through a box that is not one of its two ends", () => {
    for (const edge of built.edges) {
      for (const node of built.nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        for (let i = 1; i < edge.points.length; i++) {
          expect(cuts(edge.points[i - 1], edge.points[i], node.box), `${edge.id} crosses ${node.id}`).toBe(false);
        }
      }
    }
  });

  it("starts and ends on the boxes it connects", () => {
    for (const edge of built.edges) {
      const near = (p: Pt, box: Box) => p[0] >= box[0] - 1 && p[0] <= box[0] + box[2] + 1 && p[1] >= box[1] - 1 && p[1] <= box[1] + box[3] + 1;
      expect(near(edge.points[0], byId.get(edge.from)!.box), `${edge.id} start`).toBe(true);
      expect(near(edge.points[edge.points.length - 1], byId.get(edge.to)!.box), `${edge.id} end`).toBe(true);
    }
  });

  it("keeps labels off the boxes and off each other", () => {
    const labels = built.edges.flatMap((e) => (e.at ? [{ id: e.id, box: e.at }] : []));
    for (const label of labels) {
      for (const node of built.nodes) expect(overlaps(label.box, node.box), `${label.id} over ${node.id}`).toBe(false);
    }
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) expect(overlaps(labels[a].box, labels[b].box), `${labels[a].id} / ${labels[b].id}`).toBe(false);
    }
  });
});

describe("frames", () => {
  it("never hold a box that is not theirs", () => {
    const built = scene(SAMPLES.ARCHITECTURE);
    const members = new Map([
      ["b0", new Set(["api", "db", "cache", "queue", "worker"])],
      ["b1", new Set(["db", "cache"])],
    ]);
    for (const frame of built.frames) {
      for (const node of built.nodes) {
        if (members.get(frame.id)!.has(node.id)) {
          expect(frame.box[0]).toBeLessThan(node.box[0]);
        } else {
          expect(overlaps(frame.box, node.box), `${frame.label} holds ${node.id}`).toBe(false);
        }
      }
    }
  });

  it("nest: the security group sits inside the region", () => {
    const [region, group] = scene(SAMPLES.ARCHITECTURE).frames;
    expect(region.depth).toBeLessThan(group.depth);
    expect(group.box[0]).toBeGreaterThan(region.box[0]);
    expect(group.box[1]).toBeGreaterThan(region.box[1]);
    expect(group.box[0] + group.box[2]).toBeLessThan(region.box[0] + region.box[2]);
    expect(group.box[1] + group.box[3]).toBeLessThan(region.box[1] + region.box[3]);
  });
});

describe("lane grids", () => {
  it("keep every step in its lane and in column order", () => {
    const built = scene(SAMPLES.WORKFLOW);
    const lane = (id: string) => built.frames.find((f) => f.id === `lane-${id}`)!.box;
    const node = (id: string) => built.nodes.find((n) => n.id === id)!.box;
    const inLane = (id: string, laneId: string) => node(id)[1] >= lane(laneId)[1] && node(id)[1] + node(id)[3] <= lane(laneId)[1] + lane(laneId)[3];
    expect(inLane("submit", "customer")).toBe(true);
    expect(inLane("charge", "api")).toBe(true);
    expect(inLane("reject", "failure")).toBe(true);
    const xs = ["submit", "validate", "reserve", "charge", "confirm"].map((id) => node(id)[0]);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(built.frames.some((f) => f.kind === "phase")).toBe(true);
    expect(built.frames.some((f) => f.kind === "group")).toBe(true);
    expect(built.frames.find((f) => f.id === "lane-failure")!.kind).toBe("lane-exception");
  });

  it("put a dataflow's stages in columns left to right", () => {
    const built = scene(SAMPLES.DATAFLOW);
    const x = (id: string) => built.nodes.find((n) => n.id === id)!.box[0];
    expect(x("orders")).toBeLessThan(x("cdc"));
    expect(x("cdc")).toBeLessThan(x("clean"));
    expect(x("clean")).toBeLessThan(x("wh"));
    expect(built.frames.filter((f) => f.kind === "stage").map((f) => f.label)).toEqual(["Sources", "Ingest", "Transform", "Serve"]);
  });
});

describe("sequence", () => {
  const built = scene(SAMPLES.SEQUENCE);

  it("runs its messages down the page in order", () => {
    const ys = built.messages.map((m) => m.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(new Set(ys).size).toBe(ys.length);
  });

  it("gives every lifeline room for the labels between", () => {
    const x = (id: string) => built.nodes.find((n) => n.id === id)!.life![0];
    for (const m of built.messages.filter((m) => !m.self)) {
      expect(Math.abs(x(m.from) - x(m.to))).toBeGreaterThanOrEqual(m.at[2]);
    }
  });

  it("derives an activation for a call and its reply, and loops a self-call", () => {
    expect(built.activations.some((a) => a.participant === "auth")).toBe(true);
    expect(built.activations.some((a) => a.participant === "db")).toBe(true);
    expect(built.messages.find((m) => m.label === "validate body")!.self).toBe(true);
    expect(built.bands.map((b) => b.label)).toEqual(["Authenticate", "Persist"]);
  });
});

describe("the real api-saas map", () => {
  const built = scene(API_SAAS);

  it("packs the five providers into a grid instead of a row, and fits a screen", () => {
    const providers = ["resend", "wa", "dte", "storage", "flow"].map((id) => built.nodes.find((n) => n.id === id)!.box);
    const ys = new Set(providers.map((b) => Math.round(b[1])));
    expect(ys.size).toBe(2);
    const [, , w, h] = built.bounds;
    // The scale it would be fitted at in a window of the app's usual size: legible, not a thumbnail.
    expect(Math.min(1060 / w, 640 / h)).toBeGreaterThan(0.62);
  });

  it("keeps the frames to their own members, nested as the document nests them", () => {
    const frame = (label: string) => built.frames.find((f) => f.label === label)!;
    const tenant = frame("Frontera de tenant");
    const app = frame("Aplicaci\u00f3n NestJS (src/)");
    const providers = frame("Proveedores externos");
    expect(tenant.depth).toBeGreaterThan(app.depth);
    expect(overlaps(app.box, providers.box)).toBe(false);
    for (const node of built.nodes) {
      const inTenant = ["guards", "modules"].includes(node.id);
      const inApp = inTenant || ["nest", "crypto"].includes(node.id);
      const inProviders = ["resend", "wa", "dte", "storage", "flow"].includes(node.id);
      expect(overlaps(tenant.box, node.box), `tenant / ${node.id}`).toBe(inTenant);
      expect(overlaps(app.box, node.box), `app / ${node.id}`).toBe(inApp);
      expect(overlaps(providers.box, node.box), `providers / ${node.id}`).toBe(inProviders);
    }
  });
});
