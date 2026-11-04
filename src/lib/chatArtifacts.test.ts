import { describe, expect, it } from "vitest";
import { artifactFileName, artifactSlug, splitArtifacts } from "./chatArtifacts";

describe("splitArtifacts", () => {
  it("lifts a four-backtick block and keeps its inner fences", () => {
    const text = 'Aquí va:\n\n````artefacto {"name": "Guía API", "type": "markdown", "title": "Guía"}\n# Guía\n```ts\nconst a = 1;\n```\nfin\n````\n\nListo.';
    const { text: rest, artifacts } = splitArtifacts(text);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ name: "guia-api", kind: "markdown", title: "Guía" });
    expect(artifacts[0].content).toBe("# Guía\n```ts\nconst a = 1;\n```\nfin");
    expect(rest).toBe("Aquí va:\n\nListo.");
  });

  it("nests by info string inside a three-backtick block", () => {
    const { artifacts, text } = splitArtifacts('```artefacto {"name":"doc","type":"md"}\nintro\n```bash\nls\n```\nmore\n```\nafter');
    expect(artifacts[0].content).toBe("intro\n```bash\nls\n```\nmore");
    expect(text).toBe("after");
  });

  it("reads a header on the next line, key=value pairs, and a language as type", () => {
    const { artifacts } = splitArtifacts('````artifact\n{"name": "x", "type": "tsx"}\nexport const X = 1;\n````\n````artefacto name="pagina" type="html"\n<p>hi</p>\n````');
    expect(artifacts.map((a) => [a.name, a.kind, a.language])).toEqual([
      ["x", "code", "tsx"],
      ["pagina", "html", ""],
    ]);
  });

  it("leaves ordinary fences, quoted artifact blocks and empty blocks alone", () => {
    const quoted = '````md\n````artefacto {"name":"q"}\nx\n````\n````\n```js\nx\n```';
    expect(splitArtifacts(quoted)).toEqual({ text: quoted, artifacts: [] });
    expect(splitArtifacts('````artefacto {"name":"a"}\n\n````').artifacts).toEqual([]);
  });

  it("runs an unclosed block to the end", () => {
    expect(splitArtifacts('````artefacto {"name":"a"}\nline').artifacts[0].content).toBe("line");
  });
});

describe("names", () => {
  it("slugs like the backend", () => {
    expect(artifactSlug("  Informe de la API v2! ")).toBe("informe-de-la-api-v2");
    expect(artifactSlug("¿?")).toBe("artefacto");
    expect(artifactSlug("ñandú.md")).toBe("nandu.md");
  });

  it("names a file by kind or language", () => {
    expect(artifactFileName({ name: "pagina", kind: "html", language: "" })).toBe("pagina.html");
    expect(artifactFileName({ name: "x", kind: "code", language: "typescript" })).toBe("x.ts");
    expect(artifactFileName({ name: "readme.md", kind: "markdown", language: "" })).toBe("readme.md");
  });
});
