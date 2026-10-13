/**
 * Mermaid in, archify out.
 *
 * Archify takes a pasted Mermaid `flowchart`, `sequenceDiagram` or `stateDiagram` and has its agent
 * author fresh IR from it. Here the conversion is deterministic \u2014 the topology and the words are all
 * there already, and a model's rewording of them is the one thing a conversion should not add:
 *
 * - `flowchart` / `graph` \u2192 a **workflow** (a `subgraph` becomes a lane);
 * - `sequenceDiagram` \u2192 a **sequence** (`loop`, `alt`, `opt`, `par` and friends become bands);
 * - `stateDiagram` \u2192 a **lifecycle** (`[*]` is where it starts and ends).
 *
 * It reads what people write, not all of Mermaid: shapes, labelled and styled arrows, chains and
 * `&`, aliases, notes. What it does not understand it skips rather than guessing, and a file with
 * nothing it can use is refused by name \u2014 see [`convertMermaid`].
 */
import { lifecycleType } from "./ir";

export type MermaidResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false; reason: "unsupported" | "empty" };

const slug = (value: string, fallback: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^[^a-zA-Z]+/, "")
    .replace(/-+$/, "") || fallback;

const unquote = (value: string): string => value.trim().replace(/^["'`]|["'`]$/g, "").replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim();

/** The lines that carry meaning: comments, blank lines and the init directive gone. */
function logical(source: string): string[] {
  return source
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/%%.*$/, "").trim())
    .filter((line) => line && !/^---$/.test(line));
}

// --- flowchart -------------------------------------------------------------------------------

/** `A[label]`, `A(label)`, `A{label}`, `A((label))`, `A([label])`, `A[(label)]`, `A[[label]]`, `A>label]`, or bare `A`. */
const OPEN = String.raw`\(\(|\(\[|\[\(|\[\[|\{\{|\[|\(|\{|>`;
const CLOSE = String.raw`\)\)|\]\)|\)\]|\]\]|\}\}|\]|\)|\}`;
const NODE = new RegExp(String.raw`^([A-Za-z0-9_À-ɏ-]+)\s*(?:(${OPEN})\s*("[^"]*"|[^\])}]*?)\s*(${CLOSE}))?$`);

interface FlowNode {
  id: string;
  label: string;
  type: string;
  lane: string;
}

/** The arrows, longest first so `-.->` is not read as `-`. */
const ARROW = /\s*(<?==+>|<?--+>|<?-\.+->|--+[ox]|-\.+-|==+|--+)\s*(?:\|([^|]*)\|)?\s*/;

function flowchart(lines: string[]): MermaidResult {
  const nodes = new Map<string, FlowNode>();
  const edges: { from: string; to: string; label: string; dashed: boolean; thick: boolean }[] = [];
  const lanes: { id: string; label: string }[] = [];
  const stack: string[] = [];
  const laneFor = () => (stack.length ? stack[0] : "main");

  const node = (raw: string): string | null => {
    const m = NODE.exec(raw.trim());
    if (!m) return null;
    const id = m[1];
    const open = m[2];
    const label = m[3] !== undefined ? unquote(m[3]) : "";
    const known = nodes.get(id);
    const type = open === "[(" ? "database" : open === "((" || open === "([" ? "external" : open === "{" || open === "{{" ? "security" : "backend";
    if (!known) nodes.set(id, { id, label: label || id, type, lane: laneFor() });
    else {
      if (label) {
        known.label = label;
        known.type = open ? type : known.type;
      }
      // Mentioned inside a subgraph: it belongs to that lane, wherever it was first seen.
      if (stack.length) known.lane = laneFor();
    }
    return id;
  };

  for (const line of lines.slice(1)) {
    const sub = /^subgraph\s+(.+)$/i.exec(line);
    if (sub) {
      const bit = /^([A-Za-z0-9_-]+)\s*\[(.+)\]$/.exec(sub[1].trim());
      const label = unquote(bit ? bit[2] : sub[1]);
      const id = slug(bit ? bit[1] : label, `lane-${lanes.length + 1}`);
      if (!stack.length && !lanes.some((l) => l.id === id)) lanes.push({ id, label });
      stack.push(stack.length ? stack[0] : id);
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    if (/^(direction|style|classDef|class|linkStyle|click|%%)\b/i.test(line)) continue;

    // Split the statement on arrows into [node group, arrow, node group, ...].
    const parts: string[] = [];
    const arrows: { label: string; dashed: boolean; thick: boolean }[] = [];
    let rest = line.replace(/;$/, "");
    for (;;) {
      const m = ARROW.exec(rest);
      if (!m) break;
      const head = rest.slice(0, m.index);
      let tail = rest.slice(m.index + m[0].length);
      let arrow = m[1];
      let labelText = m[2] ?? "";
      // `A -- text --> B`: the label sits between two dashes.
      if (!labelText && arrow === "--") {
        const closing = /^(.*?)\s*(-->|--[ox]|---)\s*(.*)$/.exec(tail);
        if (closing) {
          labelText = closing[1];
          arrow = closing[2];
          tail = closing[3];
        }
      }
      parts.push(head);
      arrows.push({ label: unquote(labelText), dashed: arrow.includes("."), thick: arrow.includes("=") });
      rest = tail;
    }
    parts.push(rest);
    if (parts.length === 1) {
      node(parts[0]);
      continue;
    }
    const groups = parts.map((part) => part.split("&").map((n) => node(n)).filter((n): n is string => !!n));
    for (let i = 0; i < arrows.length; i++) {
      for (const from of groups[i] ?? []) for (const to of groups[i + 1] ?? []) edges.push({ from, to, ...arrows[i] });
    }
  }
  if (!nodes.size) return { ok: false, reason: "empty" };
  const used = new Set([...nodes.values()].map((n) => n.lane));
  const laneList = lanes.length ? lanes : [{ id: "main", label: "Flow" }];
  if (lanes.length && used.has("main")) laneList.unshift({ id: "main", label: "Flow" });
  const ids = new Map([...nodes.keys()].map((id) => [id, slug(id, "node")]));
  return {
    ok: true,
    doc: {
      schema_version: 2,
      diagram_type: "workflow",
      lanes: laneList,
      nodes: [...nodes.values()].map((n) => ({ id: ids.get(n.id), label: n.label, type: n.type, lane: n.lane })),
      edges: edges.map((e) => ({
        from: ids.get(e.from),
        to: ids.get(e.to),
        ...(e.label ? { label: e.label } : {}),
        ...(e.thick ? { role: "main" } : e.dashed ? { role: "async" } : {}),
      })),
    },
  };
}

// --- sequence --------------------------------------------------------------------------------

const MESSAGE = /^([^\s-][^-]*?)\s*(-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([+-]?)([^:]+?)\s*:\s*(.*)$/;

function sequence(lines: string[]): MermaidResult {
  const participants = new Map<string, { id: string; label: string; type: string }>();
  const messages: { from: string; to: string; label: string; variant?: string; note?: string }[] = [];
  const phases: { label: string; from: number; to: number }[] = [];
  const open: { label: string; from: number }[] = [];
  const declare = (raw: string, label?: string, type = "backend") => {
    const id = raw.trim().replace(/^[+-]/, "");
    if (!participants.has(id)) participants.set(id, { id: slug(id, `p${participants.size + 1}`), label: label ? unquote(label) : id, type });
    else if (label) participants.get(id)!.label = unquote(label);
    return participants.get(id)!.id;
  };

  for (const line of lines.slice(1)) {
    const decl = /^(participant|actor)\s+([^\s]+)(?:\s+as\s+(.+))?$/i.exec(line);
    if (decl) {
      declare(decl[2], decl[3], decl[1].toLowerCase() === "actor" ? "external" : "backend");
      continue;
    }
    const block = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/i.exec(line);
    if (block) {
      open.push({ label: `${block[1].toLowerCase()}${block[2] ? ` ${unquote(block[2])}` : ""}`, from: messages.length });
      continue;
    }
    if (/^end$/i.test(line)) {
      const b = open.pop();
      if (b && messages.length > b.from && b.label.split(" ")[0] !== "rect") phases.push({ label: b.label, from: b.from, to: messages.length - 1 });
      continue;
    }
    const note = /^note\s+(?:over|left of|right of)\s+[^:]+:\s*(.*)$/i.exec(line);
    if (note) {
      if (messages.length) messages[messages.length - 1].note = unquote(note[1]);
      continue;
    }
    const m = MESSAGE.exec(line);
    if (m) {
      const from = declare(m[1]);
      const to = declare(m[4]);
      const arrow = m[2];
      const returns = arrow.startsWith("--") && !arrow.includes("x");
      messages.push({
        from,
        to,
        label: unquote(m[5]) || "\u2026",
        ...(returns ? { variant: "return" } : arrow.includes(")") ? { variant: "dashed" } : {}),
      });
    }
  }
  if (!messages.length) return { ok: false, reason: "empty" };
  return {
    ok: true,
    doc: {
      schema_version: 1,
      diagram_type: "sequence",
      participants: [...participants.values()],
      messages,
      phases,
    },
  };
}

// --- state diagram ---------------------------------------------------------------------------

function states(lines: string[]): MermaidResult {
  const found = new Map<string, { id: string; label: string; type: string; sublabel?: string }>();
  const transitions: { from: string; to: string; label?: string }[] = [];
  const aliases = new Map<string, string>();
  const ensure = (raw: string, role: "from" | "to") => {
    const name = raw.trim();
    if (name === "[*]") {
      const id = role === "from" ? "start" : "end";
      if (!found.has(id)) found.set(id, { id, label: role === "from" ? "Start" : "End", type: role === "from" ? "start" : "success" });
      return id;
    }
    const key = aliases.get(name) ?? name;
    if (!found.has(key)) {
      const guess = lifecycleType(key);
      found.set(key, { id: slug(key, `s${found.size + 1}`), label: key, type: guess === "neutral" ? "active" : guess });
    }
    return found.get(key)!.id;
  };
  for (const line of lines.slice(1)) {
    const alias = /^state\s+"([^"]+)"\s+as\s+(\S+)$/i.exec(line);
    if (alias) {
      aliases.set(alias[2], alias[2]);
      found.set(alias[2], { id: slug(alias[2], `s${found.size + 1}`), label: alias[1], type: lifecycleType(alias[1]) === "neutral" ? "active" : lifecycleType(alias[1]) });
      continue;
    }
    const arrow = /^(\[\*\]|[^\s:]+)\s*-->\s*(\[\*\]|[^\s:]+)\s*(?::\s*(.*))?$/.exec(line);
    if (arrow) {
      const from = ensure(arrow[1], "from");
      const to = ensure(arrow[2], "to");
      transitions.push({ from, to, ...(arrow[3] ? { label: unquote(arrow[3]) } : {}) });
      continue;
    }
    const describe = /^([^\s:]+)\s*:\s*(.+)$/.exec(line);
    if (describe && found.has(describe[1])) found.get(describe[1])!.sublabel = unquote(describe[2]);
  }
  if (!transitions.length && !found.size) return { ok: false, reason: "empty" };
  return {
    ok: true,
    doc: {
      schema_version: 2,
      diagram_type: "lifecycle",
      lanes: [{ id: "main", label: "States" }],
      states: [...found.values()].map((s) => ({ id: s.id, label: s.label, type: s.type, lane: "main", ...(s.sublabel ? { sublabel: s.sublabel } : {}) })),
      transitions,
    },
  };
}

/** Whether `source` opens as a Mermaid diagram this module converts. */
export function isMermaid(source: string): boolean {
  const first = logical(source)[0] ?? "";
  return /^(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?)\b/i.test(first);
}

export function convertMermaid(source: string): MermaidResult {
  const lines = logical(source);
  const first = lines[0] ?? "";
  if (/^(flowchart|graph)\b/i.test(first)) return flowchart(lines);
  if (/^sequenceDiagram\b/i.test(first)) return sequence(lines);
  if (/^stateDiagram(-v2)?\b/i.test(first)) return states(lines);
  return { ok: false, reason: first ? "unsupported" : "empty" };
}
