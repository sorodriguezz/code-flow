import { describe, expect, it } from "vitest";
import { diagramFormatForPath, diagramTitleForPath, isDbmlPath, isDiagramPath } from "./dbmlBridge";
import { isMarkdownPath } from "./notesBridge";

/**
 * The two pure decisions the bridge makes before it touches anything.
 *
 * They are small enough to look obviously right and are pinned anyway, because both are read by
 * code that *writes a repository*: `isDbmlPath` decides whether the editor offers the handover at
 * all, and `diagramTitleForPath` is the name the diagram is filed under — the thing the user finds
 * it by in a workspace of two hundred.
 *
 * The routing and the linking are not here: they are one `invoke` and three window stores deep, so
 * a test of them would be a test of the mocks. Their invariants live in `db::diagram_queries`'s
 * tests, where the failure they prevent — two diagrams writing one file — is actually reachable.
 */
describe("which files the bridge carries", () => {
  it("takes a .dbml file whatever case it is written in", () => {
    expect(isDbmlPath("db/schema.dbml")).toBe(true);
    expect(isDbmlPath("db/Schema.DBML")).toBe(true);
    expect(isDbmlPath("schema.dbml")).toBe(true);
  });

  it("takes nothing else", () => {
    expect(isDbmlPath("db/schema.sql")).toBe(false);
    expect(isDbmlPath("README.md")).toBe(false);
    // The extension, not the word: a file *called* dbml is not one.
    expect(isDbmlPath("docs/dbml")).toBe(false);
    expect(isDbmlPath("dbml.md")).toBe(false);
    expect(isDbmlPath(null)).toBe(false);
    expect(isDbmlPath(undefined)).toBe(false);
    expect(isDbmlPath("")).toBe(false);
  });
});

describe("what the diagram is called", () => {
  it("is the file's own name, without its folders or its extension", () => {
    expect(diagramTitleForPath("db/schema.dbml")).toBe("schema");
    expect(diagramTitleForPath("services/billing/db/billing.dbml")).toBe("billing");
    expect(diagramTitleForPath("schema.dbml")).toBe("schema");
  });

  it("keeps the case the file was written in — it is somebody's name for it", () => {
    expect(diagramTitleForPath("db/Ventas.DBML")).toBe("Ventas");
  });

  it("keeps a name that is only an extension rather than being called nothing", () => {
    // `.dbml` with no stem would strip to the empty string, and an untitled diagram in the gallery
    // is worse than an odd one.
    expect(diagramTitleForPath(".dbml")).toBe(".dbml");
  });

  it("keeps the dots inside a name", () => {
    expect(diagramTitleForPath("db/schema.v2.dbml")).toBe("schema.v2");
  });
});

describe("the file tree's handovers", () => {
  it("opens every dialect the Diagrams app edits, in its own editor", () => {
    expect(diagramFormatForPath("docs/arquitectura.drawio")).toBe("mxgraph");
    expect(diagramFormatForPath("docs/Pizarra.EXCALIDRAW")).toBe("excalidraw");
    expect(diagramFormatForPath("db/schema.dbml")).toBe("dbml");
    expect(diagramFormatForPath("legacy.dio")).toBe("mxgraph");
  });

  it("does not claim a bare XML file, or anything else", () => {
    // Most XML in a repository is not a drawing; offering to open a pom.xml as one is a trap.
    expect(isDiagramPath("pom.xml")).toBe(false);
    expect(isDiagramPath("README.md")).toBe(false);
    expect(isDiagramPath("docs/drawio")).toBe(false);
    expect(isDiagramPath(null)).toBe(false);
  });

  it("names a diagram after its file, whatever the dialect", () => {
    expect(diagramTitleForPath(".codeflow/diagrams/arquitectura.drawio")).toBe("arquitectura");
    expect(diagramTitleForPath("pizarra.excalidraw")).toBe("pizarra");
  });

  it("sends Markdown to Notes, and only Markdown", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/guia.Markdown")).toBe(true);
    expect(isMarkdownPath(".codeflow/notes/plan.mdown")).toBe(true);
    expect(isMarkdownPath("notes.txt")).toBe(false);
    expect(isMarkdownPath("docs/md")).toBe(false);
    expect(isMarkdownPath(undefined)).toBe(false);
  });
});
