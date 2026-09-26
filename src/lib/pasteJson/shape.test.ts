import { describe, expect, it } from "vitest";
import {
  demotePublicTypes,
  hasDeclarations,
  packageFromPath,
  placeGenerated,
  stripLeadingComments,
  toJsdoc,
  unwrapNamespace,
  type PasteFile,
} from "./shape";

const lines = (...xs: string[]) => xs.join("\n");

/** A paste at the start of line `line` of `text`, which is what a caret on an empty line is. */
const at = (dialect: PasteFile["dialect"], text: string, line: number, extra: Partial<PasteFile> = {}): PasteFile => ({
  dialect,
  text,
  line,
  before: "",
  path: "src/models/order.x",
  ...extra,
});

describe("stripLeadingComments", () => {
  it("drops the header quicktype opens a file with", () => {
    const swift = lines(
      "// This file was generated from JSON Schema using quicktype, do not modify it directly.",
      "// To parse the JSON, add this file to your project and do:",
      "",
      "import Foundation",
      "",
      "// MARK: - Order",
      "struct Order: Codable {}",
    );
    expect(stripLeadingComments(swift, "swift")).toBe(lines("import Foundation", "", "// MARK: - Order", "struct Order: Codable {}"));
  });

  it("reads Python's comments as Python writes them", () => {
    expect(stripLeadingComments(lines("# To use this code…", "from enum import Enum"), "python")).toBe("from enum import Enum");
  });

  it("leaves output that opens with code alone", () => {
    expect(stripLeadingComments("type Order struct {}", "go")).toBe("type Order struct {}");
  });
});

describe("hasDeclarations", () => {
  it("does not count imports and package lines as something to paste", () => {
    expect(hasDeclarations(lines("using System;", "using System.Text.Json.Serialization;", ""), "csharp")).toBe(false);
    expect(hasDeclarations("package quicktype", "kotlin")).toBe(false);
    expect(hasDeclarations("", "typescript")).toBe(false);
  });

  it("counts anything else", () => {
    expect(hasDeclarations(lines("using System;", "", "public partial class Order {}"), "csharp")).toBe(true);
    expect(hasDeclarations("type Root = number;", "typescript")).toBe(true);
  });
});

describe("unwrapNamespace", () => {
  it("takes the classes and their usings out of quicktype's placeholder namespace", () => {
    const cs = lines(
      "namespace QuickType",
      "{",
      "    using System;",
      "",
      "    public partial class Order",
      "    {",
      "        public long Id { get; set; }",
      "    }",
      "}",
      "",
    );
    expect(unwrapNamespace(cs, "    ")).toBe(
      lines("using System;", "", "public partial class Order", "{", "    public long Id { get; set; }", "}", ""),
    );
  });

  it("leaves code without the wrapper alone", () => {
    const cs = lines("public partial class Order", "{", "}");
    expect(unwrapNamespace(cs, "    ")).toBe(cs);
  });
});

describe("demotePublicTypes", () => {
  const java = lines(
    "public class Order {",
    "    public long getID() { return id; }",
    "}",
    "",
    "public class Item {",
    "}",
    "",
    "public enum Status {",
    "}",
  );

  it("keeps public only the type the file is named after", () => {
    const out = demotePublicTypes(java, "Order");
    expect(out).toContain("public class Order {");
    expect(out).toContain("\nclass Item {");
    expect(out).toContain("\nenum Status {");
  });

  it("never touches members", () => {
    expect(demotePublicTypes(java, "Order")).toContain("    public long getID() { return id; }");
  });

  it("demotes every one in a file named after none of them", () => {
    expect(demotePublicTypes(java, "Catalog")).not.toMatch(/^public /m);
  });
});

describe("toJsdoc", () => {
  it("turns object types into typedefs with a property per member, optional ones in brackets", () => {
    const ts = lines("export type Order = {", "    id:    number;", "    note?: string;", "    tags:  string[];", "}");
    expect(toJsdoc(ts)).toBe(
      lines(
        "/**",
        " * @typedef {Object} Order",
        " * @property {number} id",
        " * @property {string} [note]",
        " * @property {string[]} tags",
        " */",
      ),
    );
  });

  it("keeps aliases, unions and maps as the type expressions they already are", () => {
    const ts = lines(
      "export type Catalog = {",
      "    byId: { [key: string]: Order };",
      "}",
      "",
      'export type Status = "open" | "closed";',
      "",
      "type Root = number;",
    );
    expect(toJsdoc(ts)).toBe(
      lines(
        "/**",
        " * @typedef {Object} Catalog",
        " * @property {{ [key: string]: Order }} byId",
        " */",
        "",
        "/**",
        ' * @typedef {"open" | "closed"} Status',
        " */",
        "",
        "/**",
        " * @typedef {number} Root",
        " */",
      ),
    );
  });

  it("writes a type literal when a key cannot be a property name", () => {
    const ts = lines("export type Owner = {", "    login:          string;", '    "display-name": string;', "}");
    expect(toJsdoc(ts)).toBe(
      lines("/**", " * @typedef {{", " *     login: string;", ' *     "display-name": string;', " * }} Owner", " */"),
    );
  });

  it("cannot be closed early by what is inside it", () => {
    expect(toJsdoc('export type Pattern = "a*/b" | "c";')).toContain('@typedef {"a*\\/b" | "c"} Pattern');
  });

  it("refuses output it does not recognise rather than guess", () => {
    expect(() => toJsdoc(lines("export interface Order {", "}"))).toThrow();
  });
});

describe("packageFromPath", () => {
  it("reads the package off the directories under java/ or kotlin/", () => {
    expect(packageFromPath("src/main/java/com/example/shop/Order.java")).toBe("com.example.shop");
    expect(packageFromPath("app/src/main/kotlin/org/sample/Order.kt")).toBe("org.sample");
    expect(packageFromPath("src\\main\\java\\com\\example\\Order.java")).toBe("com.example");
  });

  it("gives none when the path implies none, or implies one that cannot be written", () => {
    expect(packageFromPath("Order.java")).toBeNull();
    expect(packageFromPath("src/main/java/Order.java")).toBeNull();
    expect(packageFromPath("src/main/java/com/my-shop/Order.java")).toBeNull();
  });
});

describe("placeGenerated", () => {
  // What quicktype writes for Java, one file per class, each with its own package and imports.
  const java = lines(
    "package io.quicktype;",
    "",
    "import java.util.List;",
    "",
    "public class Order {",
    "    private List<Item> items;",
    "}",
    "",
    "",
    "package io.quicktype;",
    "",
    "import java.util.List;",
    "import java.time.OffsetDateTime;",
    "",
    "class Item {",
    "    private OffsetDateTime shippedAt;",
    "}",
  );
  const javaBody = lines(
    "public class Order {",
    "    private List<Item> items;",
    "}",
    "",
    "class Item {",
    "    private OffsetDateTime shippedAt;",
    "}",
    "",
  );

  describe("into an empty file", () => {
    it("writes the whole file, with the package its directory implies and each import once", () => {
      const placed = placeGenerated(java, at("java", "", 1, { path: "src/main/java/com/example/shop/Order.java" }));
      expect(placed.header).toBeNull();
      expect(placed.body).toBe(
        lines(
          "package com.example.shop;",
          "",
          "import java.util.List;",
          "import java.time.OffsetDateTime;",
          "",
          javaBody,
        ),
      );
    });

    it("leaves a placeholder package out when the path implies none", () => {
      const placed = placeGenerated(java, at("java", "\n", 1, { path: "Order.java" }));
      expect(placed.body.startsWith("import java.util.List;\n")).toBe(true);
      expect(placed.body).not.toContain("package");
    });

    it("keeps Go's own package line, which is never a placeholder", () => {
      const go = lines("package main", "", 'import "encoding/json"', "", "type Order struct {", "}");
      expect(placeGenerated(go, at("go", "", 1)).body).toBe(
        lines("package main", "", 'import "encoding/json"', "", "type Order struct {", "}", ""),
      );
    });
  });

  describe("into a file with a head of its own", () => {
    it("adds only the missing imports, after the file's last one, and never a second package line", () => {
      const file = lines(
        "package com.example.shop;",
        "",
        "import java.util.Map;",
        "import java.util.List;",
        "",
        "public class Catalog {",
        "}",
        "",
      );
      const placed = placeGenerated(java, at("java", file, 8, { path: "src/main/java/com/example/shop/Catalog.java" }));
      expect(placed.header).toEqual({ after: 4, lines: ["import java.time.OffsetDateTime;"] });
      expect(placed.body).toBe(javaBody);
    });

    it("adds nothing to the head when the file already has every import", () => {
      const go = lines('import "time"', "", "type Order struct {", "\tShippedAt time.Time `json:\"shipped_at\"`", "}");
      const file = lines("package shop", "", "import (", '\t"fmt"', '\t"time"', ")", "", "func main() {}", "");
      const placed = placeGenerated(go, at("go", file, 9));
      expect(placed.header).toBeNull();
      expect(placed.body).toBe(lines("type Order struct {", "\tShippedAt time.Time `json:\"shipped_at\"`", "}", ""));
    });

    it("recognises a Go import inside a parenthesised block, and adds after the block", () => {
      const go = lines('import "time"', "", "type Order struct {", "}");
      const file = lines("package shop", "", "import (", '\t"fmt"', '\t"strings"', ")", "", "func main() {}", "");
      expect(placeGenerated(go, at("go", file, 9)).header).toEqual({ after: 6, lines: ['import "time"'] });
    });

    it("puts imports under a package line when the file has none yet, set off by a blank line", () => {
      const go = lines('import "time"', "", "type Order struct {", "}");
      const file = lines("package shop", "", "func main() {}", "");
      expect(placeGenerated(go, at("go", file, 4)).header).toEqual({ after: 1, lines: ["", 'import "time"'] });
    });

    it("puts Dart's imports under its library directive, which has to stay first", () => {
      const dart = lines("import 'dart:convert';", "", "class Order {}");
      const file = lines("library shop;", "", "class Catalog {}", "");
      expect(placeGenerated(dart, at("dart", file, 4)).header).toEqual({ after: 1, lines: ["", "import 'dart:convert';"] });
    });

    it("puts C# usings at the very top of a file-scoped namespace file", () => {
      const cs = lines("using System;", "using System.Text.Json.Serialization;", "", "public partial class Order", "{", "}");
      const file = lines("namespace Shop;", "", "public class Catalog", "{", "}", "");
      const placed = placeGenerated(cs, at("csharp", file, 6));
      expect(placed.header).toEqual({ after: 0, lines: ["using System;", "using System.Text.Json.Serialization;", ""] });
      expect(placed.body).toBe(lines("public partial class Order", "{", "}", ""));
    });

    it("joins usings kept inside a block namespace, at their indentation", () => {
      const cs = lines("using System;", "using System.Text.Json.Serialization;", "", "public partial class Order", "{", "}");
      const file = lines("namespace Shop", "{", "    using System;", "", "    public class Catalog", "    {", "    }", "}", "");
      const placed = placeGenerated(cs, at("csharp", file, 8, { before: "    " }));
      expect(placed.header).toEqual({ after: 3, lines: ["    using System.Text.Json.Serialization;"] });
      // And the caret's indentation carries down the pasted lines, keeping them inside the namespace.
      expect(placed.body).toBe(lines("public partial class Order", "    {", "    }", ""));
    });

    it("tells a statement from a using directive", () => {
      const cs = lines("using System;", "", "public partial class Order", "{", "}");
      const file = lines("using var stream = Open();", "Run(stream);", "");
      // `using var` is code, so the file has no directives and the one it needs goes at the top.
      expect(placeGenerated(cs, at("csharp", file, 3)).header).toEqual({ after: 0, lines: ["using System;", ""] });
    });

    it("keeps a licence header above the imports it adds", () => {
      const cs = lines("using System;", "", "public partial class Order", "{", "}");
      const file = lines("// Copyright Example", "public class Catalog", "{", "}", "");
      expect(placeGenerated(cs, at("csharp", file, 5)).header).toEqual({ after: 1, lines: ["", "using System;", ""] });
    });

    it("keeps a doc comment on the declaration it documents, adding above it", () => {
      const cs = lines("using System;", "", "public partial class Order", "{", "}");
      const file = lines("/// <summary>A catalog.</summary>", "public class Catalog", "{", "}", "");
      expect(placeGenerated(cs, at("csharp", file, 5)).header).toEqual({ after: 0, lines: ["using System;", ""] });

      const licensed = lines("// Copyright Example", "", "/** A catalog. */", "public class Catalog {", "}", "");
      const java2 = lines("import java.util.List;", "", "class Order {", "}");
      expect(placeGenerated(java2, at("java", licensed, 6)).header).toEqual({ after: 2, lines: ["import java.util.List;", ""] });
    });

    it("hoists Python's imports under a module docstring, not above it", () => {
      const py = lines("from dataclasses import dataclass", "", "", "@dataclass", "class Order:", "    id: int");
      const file = lines('"""Shop models."""', "", "", "class Catalog:", "    pass", "");
      const placed = placeGenerated(py, at("python", file, 6));
      expect(placed.header).toEqual({ after: 1, lines: ["", "from dataclasses import dataclass"] });
      expect(placed.body).toBe(lines("@dataclass", "class Order:", "    id: int", ""));
    });

    it("walks past a multi-line import to its closing line", () => {
      const py = lines("from dataclasses import dataclass", "", "", "@dataclass", "class Order:", "    id: int");
      const file = lines("import json", "from typing import (", "    Any,", "    Optional,", ")", "", "x = 1", "");
      expect(placeGenerated(py, at("python", file, 8)).header).toEqual({ after: 5, lines: ["from dataclasses import dataclass"] });
    });

    it("does not repeat a Rust use the file already has, whatever the spacing", () => {
      const rs = lines("use serde::{Serialize, Deserialize};", "", "#[derive(Debug, Clone, Serialize, Deserialize)]", "pub struct Order {", "    pub id: i64,", "}");
      const file = lines("use serde::{Serialize,  Deserialize};", "", "fn main() {}", "");
      const placed = placeGenerated(rs, at("rust", file, 4));
      expect(placed.header).toBeNull();
      expect(placed.body.startsWith("#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct Order {")).toBe(true);
    });

    it("reads a CRLF file's head the same", () => {
      const go = lines('import "time"', "", "type Order struct {", "}");
      const file = ["package shop", "", "import (", '\t"fmt"', ")", "", "func main() {}", ""].join("\r\n");
      expect(placeGenerated(go, at("go", file, 8)).header).toEqual({ after: 5, lines: ['import "time"'] });
    });
  });

  describe("at the caret", () => {
    it("brings the imports along when the caret is up in the head of the file", () => {
      const file = lines("package com.example.shop;", "", "import java.util.Map;", "", "public class Catalog {}", "");
      const placed = placeGenerated(java, at("java", file, 2));
      expect(placed.header).toBeNull();
      expect(placed.body).toBe(lines("import java.util.List;", "import java.time.OffsetDateTime;", "", javaBody));
    });

    it("starts on a fresh line when there is code before the caret", () => {
      const ts = lines("export interface Order {", "    id: number;", "}");
      const placed = placeGenerated(ts, at("typescript", "const a = 1;", 1, { before: "const a = 1;" }));
      expect(placed.body).toBe(lines("", "export interface Order {", "    id: number;", "}", ""));
    });

    it("keeps Python's two blank lines between classes and collapses longer runs elsewhere", () => {
      const py = lines("@dataclass", "class Item:", "    id: int", "", "", "", "@dataclass", "class Order:", "    items: list[Item]");
      expect(placeGenerated(py, at("python", "x = 1\n", 2)).body).toBe(
        lines("@dataclass", "class Item:", "    id: int", "", "", "@dataclass", "class Order:", "    items: list[Item]", ""),
      );
      const ts = lines("export interface A {", "}", "", "", "", "export interface B {", "}");
      expect(placeGenerated(ts, at("typescript", "", 1)).body).toBe(lines("export interface A {", "}", "", "export interface B {", "}", ""));
    });

    it("drops Kotlin's placeholder package in a file that has one", () => {
      const kt = lines("package quicktype", "", "data class Order (", "    val id: Long", ")");
      const file = lines("package org.sample", "", "fun main() {}", "");
      const placed = placeGenerated(kt, at("kotlin", file, 4));
      expect(placed.header).toBeNull();
      expect(placed.body).toBe(lines("data class Order (", "    val id: Long", ")", ""));
    });
  });
});
