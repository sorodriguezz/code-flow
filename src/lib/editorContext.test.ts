import { describe, expect, it } from "vitest";
import { collectEditorContext, mentionedPaths, parseContextSources, setEditorContextProvider } from "./editorContext";

describe("editorContext", () => {
  it("asks the provider of the project and drops empty answers", () => {
    expect(collectEditorContext("p1", "hola")).toBeNull();
    setEditorContextProvider("p1", () => ({ activePath: "src/a.ts", unsaved: [], diagnostics: [] }));
    expect(collectEditorContext("p1", "hola")?.activePath).toBe("src/a.ts");
    setEditorContextProvider("p1", () => ({ unsaved: [], diagnostics: [] }));
    expect(collectEditorContext("p1", "hola")).toBeNull();
    setEditorContextProvider("p1", () => {
      throw new Error("monaco gone");
    });
    expect(collectEditorContext("p1", "hola")).toBeNull();
    setEditorContextProvider("p1", null);
    expect(collectEditorContext("p1", "hola")).toBeNull();
  });

  it("reads @path mentions with and without ranges", () => {
    expect(mentionedPaths("mira @src/a.ts y @src/b.ts:3-9, también @commit:abc1234 y @cambios")).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses stored sources leniently", () => {
    expect(parseContextSources(null)).toEqual([]);
    expect(parseContextSources("not json")).toEqual([]);
    expect(parseContextSources('[{"kind":"mention","label":"a","path":"a","startLine":null,"endLine":null}]')).toHaveLength(1);
  });
});
