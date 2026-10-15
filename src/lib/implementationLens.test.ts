import { describe, expect, it } from "vitest";
import {
  blankNonCode,
  byProximity,
  computeLenses,
  outlineTypes,
  parseHeritage,
  typeAt,
  typeWithHeaderOn,
  type LensDeps,
  type Loc,
  type TypeDecl,
} from "./implementationLens";

const names = (decls: TypeDecl[]) => decls.map((d) => [d.name, d.kind, d.members.map((m) => m.name)]);

describe("blankNonCode", () => {
  it("blanks comments and strings, keeping offsets and newlines", () => {
    const text = 'a /* { */ "x{" // }\nb';
    const clean = blankNonCode(text, true);
    expect(clean.length).toBe(text.length);
    expect(clean.replace(/\s+/g, "")).toBe("ab");
    expect(clean.indexOf("\n")).toBe(text.indexOf("\n"));
  });

  it("leaves a Rust lifetime alone but blanks a char literal", () => {
    expect(blankNonCode("fn f<'a>(x: &'a str)", false)).toBe("fn f<'a>(x: &'a str)");
    expect(blankNonCode("let c = '{';", false)).toBe("let c =    ;");
  });
});

describe("parseHeritage", () => {
  it("reads extends and implements, skipping generics", () => {
    const found = parseHeritage("<T extends Comparable<T>> extends Base<T> implements Runnable, ns.Closeable ");
    expect(found.map((h) => [h.name, h.relation])).toEqual([
      ["Base", "extends"],
      ["Runnable", "implements"],
      ["Closeable", "implements"],
    ]);
  });

  it("reads the colon form, skipping constructor calls and access specifiers", () => {
    expect(parseHeritage("(val x: Int) : Base(x), IFoo ").map((h) => h.name)).toEqual(["Base", "IFoo"]);
    expect(parseHeritage(" : public Shape, private Noncopyable ").map((h) => h.name)).toEqual(["Shape", "Noncopyable"]);
  });

  it("gives the offset of the name itself", () => {
    const header = " extends a.Base ";
    const [ref] = parseHeritage(header);
    expect(header.slice(ref.offset, ref.offset + 4)).toBe("Base");
  });
});

describe("outlineTypes", () => {
  it("reads a TypeScript interface, abstract class and class", () => {
    const text = [
      "export interface Shape {",
      "  area(): number;",
      "  readonly name?: string;",
      "}",
      "export abstract class Base implements Shape {",
      "  abstract area(): number;",
      "  get name() { return 'b'; }",
      "  constructor(private x = compute(1)) {}",
      "  describe<T>(t: T): string {",
      "    if (t) { return format(t); }",
      "    return '';",
      "  }",
      "  handler = () => run();",
      "}",
      "class Circle extends Base {",
      "  area() { return 1; }",
      "}",
    ].join("\n");
    const decls = outlineTypes(text, true);
    expect(names(decls)).toEqual([
      ["Shape", "interface", ["area", "name"]],
      ["Base", "abstract", ["area", "name", "describe"]],
      ["Circle", "class", ["area"]],
    ]);
    const base = decls[1];
    expect(base.line).toBe(5);
    expect(base.endLine).toBe(14);
    expect(base.heritage).toEqual([{ name: "Shape", relation: "implements", line: 5, column: 39 }]);
    expect(decls[2].members[0]).toEqual({ name: "area", line: 16, column: 3 });
  });

  it("reads Java, with annotations and multi-line headers", () => {
    const text = [
      "public class Service",
      "    extends AbstractService",
      "    implements Runnable {",
      "  private final List<String> items = new ArrayList<>();",
      "  @Override",
      "  public void run() {",
      "    items.forEach(x -> System.out.println(x));",
      "  }",
      "  @Override public String toString() { return \"{\"; }",
      "}",
    ].join("\n");
    const [service] = outlineTypes(text, false);
    expect(service.name).toBe("Service");
    expect(service.headerEndLine).toBe(3);
    expect(service.heritage.map((h) => [h.name, h.relation, h.line])).toEqual([
      ["AbstractService", "extends", 2],
      ["Runnable", "implements", 3],
    ]);
    expect(service.members.map((m) => m.name)).toEqual(["run", "toString"]);
  });

  it("reads Kotlin, Go interfaces and Rust traits and impls", () => {
    const kotlin = outlineTypes("data class A(val x: Int) : Base(x), Named {\n  override fun name(): String = \"a\"\n}", false);
    expect(kotlin.map((d) => [d.name, d.heritage.map((h) => h.name), d.members.map((m) => m.name)])).toEqual([
      ["A", ["Base", "Named"], ["name"]],
    ]);

    const go = outlineTypes("type Reader interface {\n\tRead(p []byte) (n int, err error)\n}\ntype File struct {\n\tname string\n}", false);
    expect(names(go)).toEqual([["Reader", "interface", ["Read"]]]);

    const rust = outlineTypes(
      "pub trait Draw {\n    fn draw(&self);\n}\nimpl<'a> crate::ui::Draw for Button<'a> {\n    fn draw(&self) {}\n}",
      false,
    );
    expect(names(rust)).toEqual([
      ["Draw", "interface", ["draw"]],
      ["Button", "impl", ["draw"]],
    ]);
    expect(rust[1].heritage.map((h) => [h.name, h.relation])).toEqual([["Draw", "implements"]]);
  });

  it("skips declarations without a body", () => {
    expect(outlineTypes("struct Foo;\nclass Bar(val x: Int)\nclass Baz {}", false).map((d) => d.name)).toEqual(["Baz"]);
  });
});

describe("typeAt / typeWithHeaderOn / byProximity", () => {
  const decls = outlineTypes("class A {\n  class B {\n  }\n}\n", true);
  it("finds the innermost type, tolerating a span that starts a little above", () => {
    expect(typeAt(decls, 3)?.name).toBe("B");
    expect(typeAt(decls, 1)?.name).toBe("A");
    expect(typeAt(decls, 9)).toBeNull();
  });
  it("matches a header line", () => {
    expect(typeWithHeaderOn(decls, 2)?.name).toBe("B");
    expect(typeWithHeaderOn(decls, 3)).toBeNull();
  });
  it("orders by nearness", () => {
    const items = [{ path: "x/y/z.ts" }, { path: "a/b/c.ts" }, { path: "a/b/me.ts" }, { path: "a/q.ts" }];
    expect(byProximity(items, "a/b/me.ts").map((i) => i.path)).toEqual(["a/b/me.ts", "a/b/c.ts", "a/q.ts", "x/y/z.ts"]);
  });
});

describe("computeLenses", () => {
  const files: Record<string, string> = {
    "shape.ts": "export interface Shape {\n  area(): number;\n  perimeter(): number;\n}\n",
    "circle.ts": "export class Circle implements Shape {\n  area() { return 1; }\n  radius() { return 2; }\n}\n",
    "square.ts": "export class Square extends Base implements Shape {\n  area() { return 4; }\n  perimeter() { return 8; }\n}\n",
    "base.ts": "export abstract class Base {\n  perimeter(): number { return 0; }\n}\n",
  };
  const outline = (path: string) => outlineTypes(files[path], true);
  const declarations: Record<string, Loc> = {
    Shape: { path: "shape.ts", line: 1, column: 18 },
    Base: { path: "base.ts", line: 1, column: 23 },
  };
  const deps = (path: string, extra: Partial<LensDeps> = {}): LensDeps => ({
    path,
    decls: outline(path),
    outlineOf: async (p) => (files[p] ? outline(p) : null),
    subtypes: async (decl) =>
      Object.keys(files).flatMap((p) =>
        outline(p)
          .filter((d) => d.heritage.some((h) => h.name === decl.name))
          .map((d) => ({ path: p, line: d.nameLine, column: d.nameColumn })),
      ),
    definition: async (ref) => declarations[ref.name] ?? null,
    ...extra,
  });

  it("counts implementations on an interface and on each member, by name", async () => {
    const lenses = await computeLenses(deps("shape.ts"));
    expect(lenses.map((l) => [l.line, l.title, l.targets.map((t) => `${t.path}:${t.line}`)])).toEqual([
      [1, { kind: "implementations", count: 2, name: "Shape" }, ["circle.ts:1", "square.ts:1"]],
      [2, { kind: "implementations", count: 2, name: "Shape.area" }, ["circle.ts:2", "square.ts:2"]],
      [3, { kind: "implementations", count: 1, name: "Shape.perimeter" }, ["square.ts:3"]],
    ]);
  });

  it("points a class at what it implements and extends, and each member at its base", async () => {
    const lenses = await computeLenses(deps("square.ts"));
    expect(lenses.map((l) => [l.line, l.title, `${l.targets[0].path}:${l.targets[0].line}`])).toEqual([
      [1, { kind: "base", relation: "extends", name: "Base" }, "base.ts:1"],
      [3, { kind: "base", relation: "overrides", name: "Base.perimeter" }, "base.ts:2"],
      [1, { kind: "base", relation: "implements", name: "Shape" }, "shape.ts:1"],
      [2, { kind: "base", relation: "implements", name: "Shape.area" }, "shape.ts:2"],
    ]);
  });

  it("draws nothing for a class nobody extends and that extends nothing", async () => {
    files["lone.ts"] = "class Lone {\n  run() {}\n}\n";
    expect(await computeLenses(deps("lone.ts"))).toEqual([]);
    delete files["lone.ts"];
  });

  it("uses a real engine for members, dropping the declaration itself", async () => {
    const lenses = await computeLenses(
      deps("base.ts", {
        // An engine answering about a concrete class includes the class itself.
        subtypes: async () => [
          { path: "base.ts", line: 1, column: 23 },
          { path: "square.ts", line: 1, column: 14 },
        ],
        memberImplementations: async (member) => [
          { path: "base.ts", line: member.line, column: member.column },
          { path: "square.ts", line: 3, column: 3 },
        ],
      }),
    );
    expect(lenses.map((l) => [l.line, l.title])).toEqual([
      [1, { kind: "implementations", count: 1, name: "Base" }],
      [2, { kind: "implementations", count: 1, name: "Base.perimeter" }],
    ]);
  });

  it("skips a heritage name that resolves nowhere", async () => {
    const lenses = await computeLenses(deps("circle.ts", { definition: async () => null }));
    expect(lenses).toEqual([]);
  });
});
