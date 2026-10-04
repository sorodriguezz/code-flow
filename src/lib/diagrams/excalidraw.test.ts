import { describe, expect, it } from "vitest";
import { appendScene, parseScene, sceneOutline } from "./excalidraw";
import { EMPTY_EXCALIDRAW_DOC, emptyDoc, FORMAT_EXCALIDRAW } from "./doc";

/**
 * The whiteboard's document as the rest of the app sees it — without Excalidraw, which only loads
 * with the editor. What these hold down: a generation never lands on top of the user's drawing,
 * never replaces it, and a blank whiteboard is a file Excalidraw will open.
 */

const scene = (elements: unknown[]) =>
  JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements, appState: {}, files: {} });

const box = (id: string, x: number, y: number, width = 100, height = 60) => ({
  id,
  type: "rectangle",
  x,
  y,
  width,
  height,
  isDeleted: false,
  index: "a0",
});

describe("the blank whiteboard", () => {
  it("is an Excalidraw file with nothing on it, not an empty string", () => {
    expect(emptyDoc(FORMAT_EXCALIDRAW)).toBe(EMPTY_EXCALIDRAW_DOC);
    expect(parseScene(EMPTY_EXCALIDRAW_DOC)?.elements).toEqual([]);
  });

  it("reads an empty document as a blank and anything else as nothing", () => {
    expect(parseScene("")?.elements).toEqual([]);
    expect(parseScene("<mxGraphModel/>")).toBeNull();
    expect(parseScene('{"type":"something-else","elements":[]}')).toBeNull();
  });
});

describe("appendScene", () => {
  it("puts a generation to the right of the drawing, level with its top", () => {
    const base = scene([box("mine", 0, 40, 200, 100)]);
    const generated = scene([box("new-a", 0, 0), box("new-b", 0, 200)]);
    const elements = parseScene(appendScene(base, generated))!.elements;
    expect(elements.map((element) => element.id)).toEqual(["mine", "new-a", "new-b"]);
    // The drawing ends at x = 200; the generation starts a gap beyond it and at its top, y = 40.
    expect(elements[1].x).toBeGreaterThan(200);
    expect(elements[1].y).toBe(40);
    // Moved as a whole: the two new boxes keep their distance from each other.
    expect(elements[2].x).toBe(elements[1].x);
    expect((elements[2].y ?? 0) - (elements[1].y ?? 0)).toBe(200);
  });

  it("leaves the drawing untouched and drops the generation's stacking order", () => {
    const base = scene([box("mine", 10, 10)]);
    const combined = parseScene(appendScene(base, scene([box("new", 0, 0)])))!;
    expect(combined.elements[0]).toEqual(box("mine", 10, 10));
    expect(combined.elements[1].index).toBeNull();
  });

  it("measures a line by its points, not by where it is anchored", () => {
    // An arrow anchored at x = 0 that reaches back to x = -300 and forward to x = 500.
    const arrow = { id: "arrow", type: "arrow", x: 0, y: 0, width: 800, height: 0, points: [[-300, 0], [500, 0]] };
    const combined = parseScene(appendScene(scene([arrow]), scene([box("new", 0, 0)])))!;
    expect(combined.elements[1].x).toBeGreaterThan(500);
  });

  it("adds a generation to an empty whiteboard where it was laid out", () => {
    const combined = parseScene(appendScene(EMPTY_EXCALIDRAW_DOC, scene([box("new", 30, 40)])))!;
    expect(combined.elements[0].x).toBe(30);
    expect(combined.elements[0].y).toBe(40);
  });

  it("never replaces a document it cannot read", () => {
    const broken = "{ not a scene";
    expect(appendScene(broken, scene([box("new", 0, 0)]))).toBe(broken);
  });
});

describe("sceneOutline", () => {
  it("lists what the board says, and nothing deleted", () => {
    const doc = scene([
      box("shape", 0, 0),
      { id: "t1", type: "text", text: "Pago   aprobado", isDeleted: false },
      { id: "t2", type: "text", text: "Borrado", isDeleted: true },
      { id: "t3", type: "text", text: "Envío", isDeleted: false },
    ]);
    expect(sceneOutline(doc)).toBe("Pago aprobado, Envío");
  });
});
