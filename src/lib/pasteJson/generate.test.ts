import { describe, expect, it } from "vitest";
import { placeGenerated, renderJsonAsCode } from "./generate";
import { PASTE_JSON_LANGUAGES, targetFor } from "./targets";

/**
 * Every target, rendered by quicktype itself — the options in `targets.ts` are strings quicktype
 * reads per language, and a misspelt one is silently ignored rather than refused, so the only proof
 * that each does what its comment says is the code that comes out.
 */

const ORDER = JSON.stringify({
  id: 7,
  title: "Example",
  unitPrice: 9.5,
  tags: ["a", "b"],
  created_at: "2024-01-01T00:00:00Z",
  owner: { login: "someone", "display-name": "Some One" },
  items: [
    { sku: "A-1", qty: 2 },
    { sku: "B-2", qty: 3, note: "gift" },
  ],
});

async function render(language: string, json = ORDER, extra: { indentation?: string; fileName?: string } = {}) {
  const target = targetFor(language);
  if (!target) throw new Error(`no target for ${language}`);
  return renderJsonAsCode({
    json,
    name: "Order",
    target,
    indentation: extra.indentation ?? "    ",
    fileName: extra.fileName ?? "Order.x",
  });
}

describe("renderJsonAsCode", () => {
  it("writes something for every language, and never quicktype's header", async () => {
    for (const language of PASTE_JSON_LANGUAGES) {
      const code = await render(language);
      expect(code, language).not.toBe("");
      expect(code, language).not.toMatch(/generated|do not (modify|edit)|to parse/i);
    }
  });

  it("TypeScript: interfaces, optional where a sample lacked the key, dates left as strings", async () => {
    const code = await render("typescript");
    expect(code).toContain("export interface Order {");
    expect(code).toContain("export interface Item {");
    expect(code).toMatch(/note\?:\s+string;/);
    expect(code).toMatch(/created_at:\s+string;/);
    expect(code).toMatch(/"display-name":\s+string;/);
  });

  it("TypeScript: follows the editor's indentation", async () => {
    expect(await render("typescript", ORDER, { indentation: "  " })).toMatch(/\n {2}id:/);
  });

  it("JavaScript: JSDoc typedefs, and no TypeScript left in them", async () => {
    const code = await render("javascript");
    expect(code).toContain(" * @typedef {Object} Order");
    expect(code).toContain(" * @property {string} [note]");
    expect(code).toContain(" * @property {Item[]} items");
    expect(code).not.toMatch(/^export |^type |^interface /m);
  });

  it("Python: dataclasses", async () => {
    const code = await render("python");
    expect(code).toContain("from dataclasses import dataclass");
    expect(code).toContain("@dataclass\nclass Order:");
    expect(code).toContain("note: str | None = None");
  });

  it("Go: structs with json tags, indented with tabs, ISO dates as time.Time", async () => {
    const code = await render("go", ORDER, { indentation: "  " });
    expect(code).toContain("type Order struct {");
    expect(code).toMatch(/\tCreatedAt\s+time\.Time\s+`json:"created_at"`/);
    expect(code).toMatch(/\tNote\s+\*string\s+`json:"note,omitempty"`/);
    expect(code).toContain('import "time"');
    expect(code).not.toMatch(/^package /m);
  });

  it("Rust: serde structs, without the example program quicktype leads with", async () => {
    const code = await render("rust");
    expect(code).toContain("use serde::{Serialize, Deserialize};");
    expect(code).toContain("#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct Order {");
    expect(code).toContain("pub note: Option<String>,");
    expect(code).not.toContain("fn main");
  });

  it("C#: classes with JsonPropertyName, out of quicktype's placeholder namespace", async () => {
    const code = await render("csharp");
    expect(code).toContain('[JsonPropertyName("created_at")]');
    expect(code).toContain("public DateTimeOffset CreatedAt { get; set; }");
    expect(code).toMatch(/^public partial class Order$/m);
    expect(code).toMatch(/^using System\.Text\.Json\.Serialization;$/m);
    expect(code).not.toContain("namespace");
  });

  it("C#: a repeated string stays a string, with no converter class behind it", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ status: ["open", "closed", "in-review"][i % 3] }));
    const code = await render("csharp", JSON.stringify({ rows }));
    expect(code).toContain("public string Status { get; set; }");
    expect(code).not.toContain("Converter");
  });

  it("Java: only the type named after the file stays public", async () => {
    const code = await render("java", ORDER, { fileName: "Order.java" });
    expect(code).toMatch(/^public class Order \{$/m);
    expect(code).toMatch(/^class Item \{$/m);
    expect(code).toMatch(/^class Owner \{$/m);
    expect(code).not.toMatch(/^\/\/ \w+\.java$/m);
  });

  it("Kotlin: data classes", async () => {
    const code = await render("kotlin");
    expect(code).toMatch(/^data class Order \($/m);
    expect(code).toContain("val note: String? = null");
  });

  it("Swift: Codable structs with their coding keys", async () => {
    const code = await render("swift");
    expect(code).toContain("struct Order: Codable {");
    expect(code).toContain("enum CodingKeys: String, CodingKey {");
    expect(code).toContain('case createdAt = "created_at"');
    expect(code).toContain("import Foundation");
  });

  it("Dart: model classes with fromJson and toJson", async () => {
    const code = await render("dart");
    expect(code).toContain("factory Order.fromJson(Map<String, dynamic> json) => Order(");
    expect(code).toContain("Map<String, dynamic> toJson() => {");
    expect(code).toContain('createdAt: DateTime.parse(json["created_at"]),');
    expect(code).toContain("import 'dart:convert';");
  });

  it("names the element of a top-level array after the name given", async () => {
    const code = await render("typescript", JSON.stringify([{ id: 1 }, { id: 2, note: "x" }]));
    expect(code).toContain("export interface Order {");
    expect(code).toMatch(/note\?:\s+string;/);
  });

  it("writes nothing for JSON with nothing to declare", async () => {
    expect(await render("csharp", "[]")).toBe("");
    expect(await render("java", "42")).toBe("");
    expect(await render("typescript", "[1, 2, 3]")).toBe("");
  });

  it("lands in an existing file with only what it is missing", async () => {
    const code = await render("java", ORDER, { fileName: "Catalog.java" });
    const file = ["package com.example.shop;", "", "import java.util.List;", "", "public class Catalog {", "}", ""].join("\n");
    const placed = placeGenerated(code, {
      dialect: "java",
      text: file,
      line: 7,
      before: "",
      path: "src/main/java/com/example/shop/Catalog.java",
    });
    // `List` is already imported, and nothing else is needed.
    expect(placed.header).toBeNull();
    expect(placed.body).not.toMatch(/^(package|import) /m);
    // The file already has its public class; every pasted one is package-private.
    expect(placed.body).not.toMatch(/^public /m);
    expect(placed.body).toMatch(/^class Order \{$/m);
  });
});
