import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES } from "./templates";

// The node types the Rust catalogue declares, read from its source — the templates must only use those.
const catalog = readFileSync(new URL("../../../src-tauri/src/flows/catalog.rs", import.meta.url), "utf8");
const known = new Set([...catalog.matchAll(/(?:node|branching|terminal)\(\s*"([a-z]+\.[a-zA-Z]+)"/g)].map((m) => m[1]));
known.add("logic.loop");
known.add("logic.merge");

describe("flow templates", () => {
  it("build valid documents of known nodes", () => {
    expect(known.size).toBeGreaterThan(60);
    for (const template of FLOW_TEMPLATES) {
      const spec = template.build((key) => key);
      const ids = spec.nodes.map((n) => n.id);
      const names = spec.nodes.map((n) => n.name);
      expect(new Set(ids).size, template.id).toBe(ids.length);
      expect(new Set(names).size, template.id).toBe(names.length);
      for (const node of spec.nodes) expect(known.has(node.type), `${template.id}: ${node.type}`).toBe(true);
      for (const wire of spec.connections) {
        expect(ids, template.id).toContain(wire.from);
        expect(ids, template.id).toContain(wire.to);
      }
      expect(spec.nodes.some((n) => n.type.startsWith("trigger.")), template.id).toBe(true);
    }
  });
});
