import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import { parseCsv } from "./toolbox/csv";
import { parseJson } from "./toolbox/json";
import { parseXml, type XmlNode } from "./toolbox/xml";
import type { StructuredDataFormat } from "./structuredDataFormat";

const MAX_SOURCE_LENGTH = 2_000_000;
const MAX_ENTRIES = 16_000;
const MAX_DEPTH = 48;
const MAX_VISIBLE_NODES = 180;
const MAX_VISIBLE_CHILDREN = 12;

export const GRAPH_CARD_WIDTH = 256;
export const GRAPH_CARD_HEADER = 38;
export const GRAPH_CARD_ROW = 24;
export const GRAPH_CARD_PREVIEW = 4;

type GroupKind = "object" | "array" | "element";
type ScalarKind = "string" | "number" | "boolean" | "null" | "alias";

export interface DataScalar {
  kind: ScalarKind;
  text: string;
}

interface SourceEntry {
  key: string;
  suffix: string;
  value: DataScalar | SourceGroup;
}

interface SourceGroup {
  kind: GroupKind;
  size: number;
  entries: () => Iterable<SourceEntry>;
}

export interface DataEntry {
  key: string;
  path: string;
  scalar?: DataScalar;
  child?: DataNode;
}

export interface DataNode {
  key: string;
  path: string;
  parent: string | null;
  kind: GroupKind | "scalar";
  entries: DataEntry[];
  size: number;
}

export interface DataGraph {
  root: DataNode;
  nodes: Map<string, DataNode>;
  truncated: boolean;
}

export type GraphParseResult =
  | { kind: "ready"; graph: DataGraph }
  | { kind: "invalid"; message: string }
  | { kind: "empty" }
  | { kind: "too_large" };

function scalar(value: unknown, kind?: ScalarKind): DataScalar {
  if (value === null || value === undefined) return { kind: "null", text: "null" };
  if (kind) return { kind, text: String(value) };
  if (typeof value === "number" || typeof value === "bigint") return { kind: "number", text: String(value) };
  if (typeof value === "boolean") return { kind: "boolean", text: String(value) };
  return { kind: "string", text: String(value) };
}

function property(key: string) {
  return /^[a-z_$][\w$]*$/i.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function entry(key: string, value: SourceEntry["value"], suffix = property(key)): SourceEntry {
  return { key, suffix, value };
}

function array(length: number, source: (index: number) => SourceEntry["value"]): SourceGroup {
  return {
    kind: "array", size: length,
    *entries() {
      for (let i = 0; i < length; i++) yield entry(`[${i}]`, source(i), `[${i}]`);
    },
  };
}

function jsonSource(value: unknown): SourceEntry["value"] {
  if (Array.isArray(value)) return array(value.length, (index) => jsonSource(value[index]));
  if (value === null || typeof value !== "object") return scalar(value);
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return {
    kind: "object", size: keys.length,
    *entries() {
      for (const key of keys) yield entry(key, jsonSource(object[key]));
    },
  };
}

function yamlSource(node: unknown): SourceEntry["value"] {
  // Aliases are displayed as references. Resolving them can duplicate whole subtrees or form cycles.
  if (isAlias(node)) return scalar(`*${node.source}`, "alias");
  if (isScalar(node)) return scalar(node.value);
  if (isSeq(node)) return array(node.items.length, (index) => yamlSource(node.items[index]));
  if (!isMap(node)) return scalar(null);

  return {
    kind: "object", size: node.items.length,
    *entries() {
      const occurrences = new Map<string, number>();
      for (const pair of node.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
        const seen = occurrences.get(key) ?? 0;
        occurrences.set(key, seen + 1);
        const suffix = seen ? `[${JSON.stringify(key)},${seen}]` : property(key);
        yield entry(key, yamlSource(pair.value), suffix);
      }
    },
  };
}

function csvSource(text: string, delimiter: string): SourceGroup | null {
  const [headers, ...rows] = parseCsv(text, delimiter);
  if (!headers) return null;
  return {
    kind: "object", size: 2,
    *entries() {
      yield entry("columns", array(headers.length, (index) => scalar(headers[index])));
      yield entry("rows", array(rows.length, (index) => ({
        kind: "object",
        size: rows[index].length,
        *entries() {
          const cells = rows[index];
          for (let column = 0; column < cells.length; column++) {
            yield entry(headers[column] || `[${column}]`, scalar(cells[column]), `[${column}]`);
          }
        },
      })));
    },
  };
}

type XmlElement = Extract<XmlNode, { type: "element" }>;

function xmlSource(element: XmlElement): SourceGroup {
  const children = element.children.filter((child) => child.type === "element" || child.type === "cdata"
    || (child.type === "text" && !!child.value.trim()));
  return {
    kind: "element", size: element.attrs.length + children.length,
    *entries() {
      for (const [key, value] of element.attrs) yield entry(`@${key}`, scalar(value));
      const occurrences = new Map<string, number>();
      for (const child of children) {
        const key = child.type === "element" ? child.name : `#${child.type}`;
        const seen = occurrences.get(key) ?? 0;
        occurrences.set(key, seen + 1);
        if (child.type === "element") yield entry(key, xmlSource(child), `${property(key)}[${seen}]`);
        else yield entry(key, scalar(child.value), `${property(key)}[${seen}]`);
      }
    },
  };
}

export function parseDataGraph(format: StructuredDataFormat, source: string, name: string, delimiter = ","): GraphParseResult {
  if (source.length > MAX_SOURCE_LENGTH) return { kind: "too_large" };
  if (!source.trim()) return { kind: "empty" };

  try {
    const text = source.replace(/^\uFEFF/, "");
    let rootPath = "$";
    let input: SourceEntry["value"] | null;
    switch (format) {
      case "json":
        input = jsonSource(parseJson(text));
        break;
      case "yaml": {
        const documents = parseAllDocuments(text, { intAsBigInt: true });
        const error = documents.find((document) => document.errors.length)?.errors[0];
        if (error) throw error;
        input = documents.length > 1
          ? array(documents.length, (index) => yamlSource(documents[index].contents))
          : documents.length === 1 ? yamlSource(documents[0].contents) : null;
        break;
      }
      case "csv":
        input = csvSource(text, delimiter);
        break;
      case "xml": {
        const element = parseXml(text).find((node): node is XmlElement => node.type === "element")!;
        rootPath += property(element.name);
        name = element.name;
        input = xmlSource(element);
        break;
      }
    }
    if (!input) return { kind: "empty" };

    const nodes: DataGraph["nodes"] = new Map();
    let remaining = MAX_ENTRIES;
    let truncated = false;
    function visit(value: SourceEntry["value"], key: string, path: string, parent: string | null, depth: number): DataNode {
      if (!("entries" in value)) {
        const root: DataNode = { key, path, parent, kind: "scalar", size: 1, entries: [{ key: "", path, scalar: value }] };
        nodes.set(path, root);
        return root;
      }
      const node: DataNode = { key, path, parent, kind: value.kind, size: value.size, entries: [] };
      nodes.set(path, node);
      if (!value.size) return node;
      if (depth >= MAX_DEPTH) {
        truncated = true;
        return node;
      }
      for (const field of value.entries()) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        remaining--;
        const fieldPath = path + field.suffix;
        const content = "entries" in field.value
          ? { child: visit(field.value, field.key, fieldPath, path, depth + 1) }
          : { scalar: field.value };
        node.entries.push({ key: field.key, path: fieldPath, ...content });
      }
      return node;
    }

    const root = visit(input, name, rootPath, null, 0);
    return { kind: "ready", graph: { root, nodes, truncated } };
  } catch (error) {
    return { kind: "invalid", message: String(error instanceof Error ? error.message : error).slice(0, 450) };
  }
}

export interface DataMatch {
  node: string;
  field?: string;
}

export function findGraphMatches(graph: DataGraph, input: string): DataMatch[] {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
  const results: DataMatch[] = [];
  for (const node of graph.nodes.values()) {
    if (matches(node.key)) results.push({ node: node.path });
    for (const field of node.entries) {
      if (field.scalar && (matches(field.key) || matches(field.scalar.text))) {
        results.push({ node: node.path, field: field.path });
      }
    }
  }
  return results;
}

export interface PositionedDataNode {
  node: DataNode;
  x: number;
  y: number;
  height: number;
  expanded: boolean;
}

export function dataGraphConnections(positioned: readonly PositionedDataNode[]) {
  const byPath = new Map(positioned.map((item) => [item.node.path, item]));
  return positioned.flatMap((target) => {
    const source = target.node.parent ? byPath.get(target.node.parent) : undefined;
    if (!source) return [];
    return [{
      id: target.node.path,
      sourceX: source.x + GRAPH_CARD_WIDTH,
      sourceY: source.y + source.height / 2,
      targetX: target.x,
      targetY: target.y + target.height / 2,
    }];
  });
}

export function dataGraphLayout(graph: DataGraph, toggled: ReadonlyMap<string, boolean>, reveal?: string) {
  const chain = new Map<string, string>();
  for (let node = reveal ? graph.nodes.get(reveal) : undefined; node?.parent; node = graph.nodes.get(node.parent)) {
    chain.set(node.parent, node.path);
  }
  const spacing = GRAPH_CARD_HEADER + GRAPH_CARD_ROW * (GRAPH_CARD_PREVIEW + 1) + 36;
  function layout(prioritizeReveal: boolean) {
    const placed: PositionedDataNode[] = [];
    let leaves = 0;
    function place(node: DataNode, depth: number): PositionedDataNode {
      const children = node.entries.flatMap((entry) => entry.child ? [entry.child] : []);
      const forced = chain.get(node.path);
      const expanded = !!forced || (toggled.get(node.path) ?? depth < 2);
      const item: PositionedDataNode = { node, x: depth * (GRAPH_CARD_WIDTH + 76), y: 0, height: dataCardHeight(node), expanded };
      placed.push(item);

      const visible = expanded ? children.slice(0, MAX_VISIBLE_CHILDREN) : [];
      if (forced) {
        const index = visible.findIndex((child) => child.path === forced);
        if (index < 0) {
          if (visible.length === MAX_VISIBLE_CHILDREN) visible.pop();
          visible.push(graph.nodes.get(forced)!);
        }
        if (prioritizeReveal) {
          const [child] = visible.splice(visible.findIndex((candidate) => candidate.path === forced), 1);
          visible.unshift(child);
        }
      }
      const positioned: PositionedDataNode[] = [];
      for (const child of visible) {
        if (placed.length >= MAX_VISIBLE_NODES) break;
        positioned.push(place(child, depth + 1));
      }
      const first = positioned[0];
      const last = positioned[positioned.length - 1];
      const center = first
        ? (first.y + first.height / 2 + last.y + last.height / 2) / 2
        : (leaves++ + 0.5) * spacing;
      item.y = center - item.height / 2;
      return item;
    }
    place(graph.root, 0);
    return placed;
  }

  const result = layout(false);
  // Normally preserve sibling order. Retry with the revealed branch first if the global cap hit.
  return reveal && chain.size && !result.some(({ node }) => node.path === reveal) ? layout(true) : result;
}

export function dataCardHeight(node: DataNode) {
  const rows = Math.min(node.entries.length, GRAPH_CARD_PREVIEW);
  return GRAPH_CARD_HEADER + GRAPH_CARD_ROW * (Math.max(1, rows) + Number(node.size > rows && rows > 0)) + 2;
}
