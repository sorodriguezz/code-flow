import { describe, expect, it } from "vitest";
import { GRAPH_CARD_WIDTH, dataGraphConnections, dataGraphLayout, findGraphMatches, parseDataGraph, type DataGraph } from "./structuredDataGraph";
import { structuredDataFormat, type StructuredDataFormat } from "./structuredDataFormat";

function read(format: StructuredDataFormat, text: string, delimiter?: string): DataGraph {
  const result = parseDataGraph(format, text, `file.${format}`, delimiter);
  if (result.kind !== "ready") throw new Error(JSON.stringify(result));
  return result.graph;
}

describe("structured data graph", () => {
  it("offers the graph for all requested extensions, including .yml", () => {
    expect(["data.CSV", "data.json", "data.xml", "data.yaml", "data.YML", "readme.md", "file.json.bak"]
      .map(structuredDataFormat)).toEqual(["csv", "json", "xml", "yaml", "yaml", null, null]);
  });

  it("preserves JSON scalar types, paths and special property names", () => {
    const graph = read("json", '{"[x]":{"enabled":false,"n":12,"missing":null,"__proto__":"ordinary key"},"empty":[]}');
    expect(graph.nodes.get('$["[x]"]')?.entries.map((entry) => entry.scalar)).toEqual([
      { kind: "boolean", text: "false" },
      { kind: "number", text: "12" },
      { kind: "null", text: "null" },
      { kind: "string", text: "ordinary key" },
    ]);
    expect(findGraphMatches(graph, "ORDINARY KEY")).toEqual([{ node: '$["[x]"]', field: '$["[x]"].__proto__' }]);
    expect(read("json", "false").root.entries[0].scalar?.text).toBe("false");
  });

  it("keeps CSV text, duplicate headers, extra columns and multiline cells", () => {
    const graph = read("csv", 'id;name;name\r\n007;"first\nline";"say ""hello""";bonus\r\n', ";");
    expect(graph.nodes.get("$.rows[0]")?.entries.map(({ key, scalar }) => [key, scalar?.text])).toEqual([
      ["id", "007"], ["name", "first\nline"], ["name", 'say "hello"'], ["[3]", "bonus"],
    ]);
    expect(read("csv", 'name\n""').nodes.get("$.rows[0]")?.entries[0].scalar?.text).toBe("");
  });

  it("retains XML attributes, repeated names and the order of mixed content", () => {
    const graph = read("xml", '<catalog id="001">Before <item>A &amp; B</item><![CDATA[<raw>]]><item /> after</catalog>');
    expect(graph.root.key).toBe("catalog");
    expect(graph.root.entries.map(({ key }) => key)).toEqual(["@id", "#text", "item", "#cdata", "item", "#text"]);
    expect(graph.nodes.get("$.catalog.item[0]")?.entries[0].scalar?.text).toBe("A & B");
    expect(graph.nodes.get("$.catalog.item[1]")?.entries).toEqual([]);
    const unicode = read("xml", '<configuración región="sur"><環境 /></configuración>');
    expect(unicode.root.key).toBe("configuración");
    expect(unicode.root.entries.map((field) => field.key)).toEqual(["@región", "環境"]);
  });

  it("reads multi-document YAML and represents alias references without expanding cycles", () => {
    const graph = read("yaml", "---\nbase: &self\n  raw: 9007199254740993\n  next: *self\n---\n- true\n");
    expect(graph.nodes.get("$[0].base")?.entries.map(({ scalar }) => scalar)).toEqual([
      { kind: "number", text: "9007199254740993" },
      { kind: "alias", text: "*self" },
    ]);
    expect(graph.nodes.get("$[1]")?.entries[0].scalar?.kind).toBe("boolean");
  });

  it("can reveal a deep match past collapsed and offscreen siblings", () => {
    const graph = read("json", JSON.stringify(Array.from({ length: 50 }, (_, id) => ({ id, a: { b: { value: id } } }))));
    const path = "$[49].a.b";
    expect(dataGraphLayout(graph, new Map()).some((card) => card.node.path === path)).toBe(false);
    const cards = dataGraphLayout(graph, new Map([["$", false]]), path);
    expect(cards.some((card) => card.node.path === path)).toBe(true);
    expect(cards.find((card) => card.node.path === "$")?.expanded).toBe(true);
    for (const x of new Set(cards.map((card) => card.x))) {
      const lane = cards.filter((card) => card.x === x).sort((a, b) => a.y - b.y);
      lane.slice(1).forEach((card, i) => expect(card.y).toBeGreaterThan(lane[i].y + lane[i].height));
    }
  });

  it("reports invalid data, emptiness and graph limits", () => {
    expect(parseDataGraph("json", "{broken", "bad.json").kind).toBe("invalid");
    expect(parseDataGraph("xml", "<a></b>", "bad.xml").kind).toBe("invalid");
    expect(parseDataGraph("yaml", "a: [", "bad.yaml").kind).toBe("invalid");
    expect(parseDataGraph("csv", '"unclosed', "bad.csv").kind).toBe("invalid");
    expect(parseDataGraph("json", "\n", "blank.json").kind).toBe("empty");
    expect(parseDataGraph("json", " ".repeat(2_000_001), "big.json").kind).toBe("too_large");
    expect(read("json", "[".repeat(80) + "0" + "]".repeat(80)).truncated).toBe(true);
  });

  it("connects the laid out cards again when a branch is reopened", () => {
    const graph = read("json", '{"options":{"nested":{}},"entries":[]}');
    const cards = dataGraphLayout(graph, new Map());
    const [root, firstChild] = cards;
    const connections = dataGraphConnections(cards);
    expect(connections).toHaveLength(cards.length - 1);
    expect(connections[0]).toEqual({
      id: firstChild.node.path,
      sourceX: root.x + GRAPH_CARD_WIDTH,
      sourceY: root.y + root.height / 2,
      targetX: firstChild.x,
      targetY: firstChild.y + firstChild.height / 2,
    });
    expect(dataGraphConnections(dataGraphLayout(graph, new Map([["$", false]])))).toEqual([]);
    expect(dataGraphConnections(dataGraphLayout(graph, new Map([["$", true]])))).toEqual(connections);
  });
});
