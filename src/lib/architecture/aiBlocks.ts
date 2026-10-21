/**
 * What comes back from Arquitectura's assistant, read: an `arch-patch` block (changes the person
 * applies one by one), an `arch-doc` block (a whole document, for "design from an idea"), and the
 * prose around them. Also what goes out: the review findings and the simulation, summarised as
 * text the model can use without recomputing them.
 *
 * Tolerant on the way in, like the chat's question blocks: a model asked for one shape writes a
 * near one, and a block that does not parse stays in the text as the code it is.
 */
import { appendAt, rangeOf, removeAt, setAt, type JsonPath } from "./jsonEdit";
import { jsoncToJson, parseArchText, findZone } from "./parse";
import type { Finding } from "./rules";
import type { SimResult } from "./sim";
import type { ArchDoc, ResolvedComponents } from "./types";

export type PatchOp =
  | { op: "set"; path: JsonPath; value: unknown }
  | { op: "add"; path: JsonPath; value: unknown }
  | { op: "remove"; path: JsonPath }
  | { op: "place"; id: string; zone?: string };

export interface PatchChange {
  title: string;
  why: string;
  ops: PatchOp[];
}

const FENCE = (name: string) => new RegExp("```" + name + "[^\\S\\n]*\\n([\\s\\S]*?)```", "gi");

function readOp(raw: unknown): PatchOp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const path = Array.isArray(o.path) ? (o.path.filter((k) => typeof k === "string" || typeof k === "number") as JsonPath) : null;
  switch (o.op) {
    case "set":
    case "replace":
      return path && "value" in o ? { op: "set", path, value: o.value } : null;
    case "add":
    case "append":
      return path && "value" in o ? { op: "add", path, value: o.value } : null;
    case "remove":
    case "delete":
      return path && path.length ? { op: "remove", path } : null;
    case "place":
      return typeof o.id === "string" ? { op: "place", id: o.id, zone: typeof o.zone === "string" ? o.zone : undefined } : null;
    default:
      return null;
  }
}

/** The answer's text without its blocks, the changes it proposes and the document it wrote. */
export function splitAnswer(text: string): { text: string; changes: PatchChange[]; doc: ArchDoc | null } {
  const changes: PatchChange[] = [];
  let doc: ArchDoc | null = null;
  let rest = text.replace(FENCE("arch-patch"), (block, body: string) => {
    let parsed: unknown;
    try { parsed = JSON.parse(jsoncToJson(body.trim())); } catch { return block; }
    const list = Array.isArray(parsed) ? parsed : (parsed as { changes?: unknown[] })?.changes;
    if (!Array.isArray(list)) return block;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const ops = (Array.isArray(c.ops) ? c.ops : []).map(readOp).filter((x): x is PatchOp => !!x);
      if (!ops.length) continue;
      changes.push({ title: String(c.title ?? "").trim() || "—", why: String(c.why ?? "").trim(), ops });
    }
    return "";
  });
  rest = rest.replace(FENCE("arch-doc"), (block, body: string) => {
    const r = parseArchText(body.trim());
    if (!r.ok) return block;
    doc = r.doc;
    return "";
  });
  return { text: rest.replace(/\n{3,}/g, "\n\n").trim(), changes, doc };
}

/**
 * An op that edits *inside* a component or a connection the document does not have. A model that
 * misremembers an id would otherwise conjure one — `components.api.sim.replicas = 2` against a
 * document with no `api` writes a component that is nothing but a replica count.
 */
function missingOwner(text: string, path: JsonPath): string | null {
  if ((path[0] !== "components" && path[0] !== "connections") || path.length < 3) return null;
  return rangeOf(text, path.slice(0, 2)) ? null : `${path[0]}.${path[1]}`;
}

/** Applies changes to the document's text, in order, as targeted edits. Throws on an op the text can't take. */
export function applyChanges(text: string, changes: PatchChange[]): string {
  let out = text;
  for (const change of changes) {
    for (const op of change.ops) {
      const missing = op.op === "place" ? null : missingOwner(out, op.path);
      if (missing) throw new Error(`${missing} is not in the document`);
      if (op.op === "set") out = setAt(out, op.path, op.value);
      else if (op.op === "add") out = appendAt(out, op.path, op.value);
      else if (op.op === "remove") out = removeAt(out, op.path);
      else {
        const r = parseArchText(out);
        if (!r.ok) throw new Error("document does not parse");
        const zonePath = op.zone ? zonePathIn(r.doc, op.zone) : null;
        out = appendAt(out, zonePath ? [...zonePath, "children"] : ["layout"], op.id);
      }
    }
  }
  return out;
}

function zonePathIn(doc: ArchDoc, zone: string): JsonPath | null {
  if (!findZone(doc.layout, zone)) return null;
  const walk = (nodes: unknown[] | undefined, base: JsonPath): JsonPath | null => {
    for (let i = 0; i < (nodes ?? []).length; i++) {
      const n = nodes![i] as Record<string, unknown>;
      if (!n || typeof n !== "object") continue;
      if (Array.isArray(n.children)) {
        if (n.id === zone) return [...base, i];
        const inner = walk(n.children as unknown[], [...base, i, "children"]);
        if (inner) return inner;
      } else {
        const key = Array.isArray(n.row) ? "row" : Array.isArray(n.column) ? "column" : null;
        if (key) { const inner = walk(n[key] as unknown[], [...base, i, key]); if (inner) return inner; }
      }
    }
    return null;
  };
  return walk(doc.layout as unknown[], ["layout"]);
}

/** A one-line description of an op, for the proposal card's diff. */
export function describeOp(op: PatchOp): { sign: "+" | "-" | "~"; text: string } {
  if (op.op === "remove") return { sign: "-", text: op.path.join(".") };
  if (op.op === "place") return { sign: "+", text: `layout${op.zone ? ` › ${op.zone}` : ""} ← ${op.id}` };
  const value = JSON.stringify(op.value);
  return { sign: op.op === "add" ? "+" : "~", text: `${op.path.join(".")}${op.op === "add" ? " +=" : " ="} ${value.length > 90 ? value.slice(0, 88) + "…" : value}` };
}

/** What the app already knows about the document, for the model: findings, then the capacity model. */
export function contextFor(findings: Finding[], sim: SimResult, comps: ResolvedComponents, describeFinding: (f: Finding) => string): string {
  const name = (id: string) => comps[id]?.name ?? id;
  const lines: string[] = [];
  lines.push("Review findings (rule-based):");
  if (!findings.length) lines.push("- none");
  for (const f of findings.slice(0, 30)) lines.push(`- [${f.severity}] ${describeFinding(f)}${f.affects.length ? ` (${f.affects.map(name).join(", ")})` : ""}`);
  lines.push("");
  lines.push(`Simulation at ×1 traffic: verdict ${sim.verdict}; entry ${Math.round(sim.entry)} rps; synchronous part ${Math.round(sim.syncMs)} ms; flow error ${Math.round(sim.flowError * 100)} %.`);
  if (sim.firstToBreak) lines.push(`First to saturate: ${name(sim.firstToBreak)} at about ×${sim.breakAt.toFixed(1)}.`);
  const hot = Object.entries(sim.metrics).filter(([id, m]) => comps[id]?.category !== "actor" && m.load > 0).sort((a, b) => b[1].util - a[1].util).slice(0, 6);
  if (hot.length) lines.push(`Busiest: ${hot.map(([id, m]) => `${name(id)} ${Math.round(m.util * 100)} %`).join(", ")}.`);
  return lines.join("\n");
}
