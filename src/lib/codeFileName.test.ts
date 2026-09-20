import { describe, expect, it } from "vitest";
import { bodyForBlock, extensionForLanguage, fileNameForBlock, fileNameFromFirstLine } from "./codeFileName";

describe("extensionForLanguage", () => {
  it("maps a language to what the file should be called", () => {
    expect(extensionForLanguage("typescript")).toBe("ts");
    expect(extensionForLanguage("ts")).toBe("ts");
    expect(extensionForLanguage("python")).toBe("py");
    expect(extensionForLanguage("yml")).toBe("yaml");
    expect(extensionForLanguage("bash")).toBe("sh");
  });

  it("is case-insensitive, because a fence is whatever the model typed", () => {
    expect(extensionForLanguage("TypeScript")).toBe("ts");
    expect(extensionForLanguage("SQL")).toBe("sql");
  });

  it("falls back to .txt for an unknown language and for a fence with none", () => {
    expect(extensionForLanguage(null)).toBe("txt");
    expect(extensionForLanguage("brainfuck")).toBe("txt");
  });
});

describe("fileNameFromFirstLine", () => {
  it("takes the name a model comments on the first line", () => {
    expect(fileNameFromFirstLine("// server.ts\nexport const x = 1")).toBe("server.ts");
    expect(fileNameFromFirstLine("# deploy.sh\nset -e")).toBe("deploy.sh");
    expect(fileNameFromFirstLine("-- schema.sql\nSELECT 1")).toBe("schema.sql");
    expect(fileNameFromFirstLine("<!-- index.html -->\n<p>hi</p>")).toBe("index.html");
    expect(fileNameFromFirstLine("/* main.css */\nbody { }")).toBe("main.css");
  });

  it("keeps only the last path segment", () => {
    // The model is saying what the file is called, not where this user's disk should put it.
    expect(fileNameFromFirstLine("// src/components/Card.tsx\n<div/>")).toBe("Card.tsx");
  });

  it("refuses a first line that is ordinary prose", () => {
    // The whole risk of this feature: a save dialog pre-filled with a fragment of a sentence.
    expect(fileNameFromFirstLine("// see config.json for the rest\nx")).toBeNull();
    expect(fileNameFromFirstLine("# TODO: fix this.\nx")).toBeNull();
    expect(fileNameFromFirstLine("// Esto crea el índice.\nx")).toBeNull();
  });

  it("refuses a number that merely contains a dot", () => {
    expect(fileNameFromFirstLine("# 1.5\nx")).toBeNull();
    expect(fileNameFromFirstLine("// 3.14159\nx")).toBeNull();
  });

  it("refuses anything that is not a comment, and anything absurd", () => {
    expect(fileNameFromFirstLine("const a = 1\n")).toBeNull();
    expect(fileNameFromFirstLine("// src/\nx")).toBeNull();
    expect(fileNameFromFirstLine(`// ${"a".repeat(80)}.ts\nx`)).toBeNull();
  });
});

describe("fileNameForBlock", () => {
  it("prefers the model's own filename over the fence language", () => {
    expect(fileNameForBlock("typescript", "// tsconfig.json\n{}", "snippet")).toBe("tsconfig.json");
  });

  it("falls back to the stem plus the language's extension", () => {
    expect(fileNameForBlock("python", "print(1)", "snippet")).toBe("snippet.py");
    expect(fileNameForBlock(null, "hello", "snippet")).toBe("snippet.txt");
  });

  it("knows the files that have a name instead of an extension", () => {
    expect(fileNameForBlock("dockerfile", "FROM node:22", "snippet")).toBe("Dockerfile");
    expect(fileNameForBlock("makefile", "all:\n\techo hi", "snippet")).toBe("Makefile");
  });
});

describe("bodyForBlock", () => {
  it("takes the naming line off a CSV, which has nowhere to put a comment", () => {
    // Left in, this is a phantom first row in every spreadsheet that opens the file.
    expect(bodyForBlock("csv", "# usuarios.csv\nid,nombre\n1,Ana")).toBe("id,nombre\n1,Ana");
    expect(bodyForBlock("json", '// datos.json\n{"a":1}')).toBe('{"a":1}');
  });

  it("leaves it alone where a comment is valid content", () => {
    // A Python file whose first line is a comment is a Python file with a comment.
    const python = "# script.py\nprint(1)";
    expect(bodyForBlock("python", python)).toBe(python);
    const sql = "-- schema.sql\nSELECT 1";
    expect(bodyForBlock("sql", sql)).toBe(sql);
  });

  it("leaves a CSV that simply starts with data alone", () => {
    const csv = "id,nombre\n1,Ana";
    expect(bodyForBlock("csv", csv)).toBe(csv);
  });

  it("survives a block that is nothing but the naming line", () => {
    expect(bodyForBlock("csv", "# vacio.csv")).toBe("");
  });

  it("keeps the name findable even after the body has lost the line", () => {
    const block = "# usuarios.csv\nid,nombre";
    expect(fileNameForBlock("csv", block, "fragmento")).toBe("usuarios.csv");
    expect(bodyForBlock("csv", block)).toBe("id,nombre");
  });
});
