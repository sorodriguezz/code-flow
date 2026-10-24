import { describe, expect, it } from "vitest";
import { formatJson, locateJsonError, minifyJson, parseJson } from "./json";
import { csvToJson, detectDelimiter, jsonToCsv, jsonToQuery, parseCsv, queryToJson } from "./csv";
import { formatXml, jsonToXml, minifyXml, parseXml, xmlToJson } from "./xml";
import { parseToml, stringifyToml } from "./toml";

describe("JSON", () => {
  it("formats, sorts and minifies", () => {
    expect(formatJson('{"b":1,"a":[1,2]}', 2, true)).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": 1\n}');
    expect(minifyJson('{ "a" : [ 1 , 2 ] }')).toBe('{"a":[1,2]}');
  });
  it("locates the error, line and column", () => {
    expect(locateJsonError('{\n  "a": 1,\n}')).toMatchObject({ line: 3, column: 1, message: "Trailing comma" });
    expect(locateJsonError("{'a': 1}")).toMatchObject({ offset: 1 });
    expect(locateJsonError('{"a": tru}')?.column).toBe(7);
    expect(locateJsonError('[1, 2] x')?.message).toMatch(/after/);
    expect(locateJsonError('{"a": [1, {"b": null}], "c": "\\u00e9"}')).toBeNull();
    expect(() => parseJson('{"a":')).toThrow(/line 1/);
  });
});

describe("CSV", () => {
  it("reads quotes, doubled quotes and breaks inside quotes", () => {
    expect(parseCsv('a,"b,c","d ""e"""\n1,"x\ny",3')).toEqual([
      ["a", "b,c", 'd "e"'],
      ["1", "x\ny", "3"],
    ]);
  });
  it("detects ; and infers types", () => {
    const text = "id;name;ok\n1;Ana;true\n2;Juan;false";
    expect(detectDelimiter(text)).toBe(";");
    expect(csvToJson(text, ";")).toEqual([
      { id: 1, name: "Ana", ok: true },
      { id: 2, name: "Juan", ok: false },
    ]);
    // Long digit strings (RUTs, phone numbers, ids) stay strings.
    expect(csvToJson("id\n0012\n12345678901234567", ",")).toEqual([{ id: "0012" }, { id: "12345678901234567" }]);
  });
  it("writes CSV with flattened objects and quoted fields", () => {
    expect(jsonToCsv([{ a: 1, b: { c: "x,y" } }, { a: 2, d: 'q"' }])).toBe('a,b.c,d\r\n1,"x,y",\r\n2,,"q"""');
  });
});

describe("query strings", () => {
  it("parse repeated and bracketed keys", () => {
    expect(queryToJson("https://x.cl/?a=1&b=2&b=3&c[d]=4&e[]=5&q=caf%C3%A9+ok")).toEqual({ a: "1", b: ["2", "3"], c: { d: "4" }, e: ["5"], q: "café ok" });
  });
  it("build them back", () => {
    expect(decodeURIComponent(jsonToQuery({ a: 1, b: [2, 3], c: { d: "x y" } }))).toBe("a=1&b=2&b=3&c[d]=x+y");
    expect(() => jsonToQuery([1])).toThrow();
  });
});

describe("XML", () => {
  it("formats and minifies", () => {
    const src = '<?xml version="1.0"?><root a="1"><!-- c --><item>x &amp; y</item><empty></empty></root>';
    expect(formatXml(src)).toBe('<?xml version="1.0"?>\n<root a="1">\n  <!-- c -->\n  <item>x &amp; y</item>\n  <empty/>\n</root>');
    expect(minifyXml(formatXml(src))).toBe('<?xml version="1.0"?><root a="1"><item>x &amp; y</item><empty/></root>');
  });
  it("says where it is broken", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/Expected <\/b>.*line 1/);
    expect(() => parseXml("<a>")).toThrow(/Unclosed <a>/);
    expect(() => parseXml("<a/><b/>")).toThrow(/More than one root/);
  });
  it("converts to and from JSON", () => {
    const json = xmlToJson('<order id="7"><item>a</item><item>b</item><note lang="es">hola</note></order>');
    expect(json).toEqual({ order: { "@id": "7", item: ["a", "b"], note: { "@lang": "es", "#text": "hola" } } });
    expect(xmlToJson(jsonToXml(json))).toEqual(json);
  });
});

describe("TOML", () => {
  const doc = `# config
title = "Demo"
port = 8_080
ratio = 0.5
enabled = true
hex = 0xff
when = 1979-05-27T07:32:00Z
tags = ["a", "b", ]
inline = { x = 1, y.z = "w" }
literal = 'C:\\path'
multi = """
uno \\
  dos"""

[database]
host = "localhost"
"quoted key" = 1

[database.pool]
max = 10

[[servers]]
name = "alpha"

[[servers]]
name = "beta"
`;
  it("parses the grammar", () => {
    expect(parseToml(doc)).toEqual({
      title: "Demo",
      port: 8080,
      ratio: 0.5,
      enabled: true,
      hex: 255,
      when: "1979-05-27T07:32:00Z",
      tags: ["a", "b"],
      inline: { x: 1, y: { z: "w" } },
      literal: "C:\\path",
      multi: "uno dos",
      database: { host: "localhost", "quoted key": 1, pool: { max: 10 } },
      servers: [{ name: "alpha" }, { name: "beta" }],
    });
  });
  it("round-trips through the writer", () => {
    const value = parseToml(doc);
    expect(parseToml(stringifyToml(value))).toEqual(value);
  });
  it("reports errors with a line", () => {
    expect(() => parseToml("a = 1\na = 2")).toThrow(/Duplicate key a \(line 2\)/);
    expect(() => parseToml("[t]\n[t]")).toThrow(/defined twice/);
    expect(() => parseToml('a = "open')).toThrow(/Unterminated/);
    expect(() => stringifyToml({ a: null })).toThrow(/null/);
  });
});
