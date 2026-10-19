import { describe, expect, it } from "vitest";
import { buildDesignNote, describeRect, shortLabel } from "./designNote";
import type { DesignPick } from "../tauri/events";

const LABELS = {
  intro: "Elegí este elemento en la vista previa:",
  markup: "Marcado",
  styles: "Estilos calculados",
  where: "En {url} — {rect}.",
};

function pick(patch: Partial<DesignPick> = {}): DesignPick {
  return {
    url: "http://localhost:1420/tasks",
    selector: "main > div.card:nth-of-type(2)",
    html: '<div class="card">Hola</div>',
    css: "display: flex;\ngap: 8px;",
    rect: "12,96,340,48",
    ...patch,
  };
}

describe("describeRect", () => {
  it("reads as a size and a place, not as four numbers", () => {
    expect(describeRect("12,96,340,48")).toBe("340×48 at (12, 96)");
  });

  it("says nothing about a rect it cannot read", () => {
    expect(describeRect("")).toBe("");
    expect(describeRect("12,96")).toBe("");
    expect(describeRect("a,b,c,d")).toBe("");
  });
});

describe("buildDesignNote", () => {
  it("hands over the selector, where it is, its markup and its styles", () => {
    const text = buildDesignNote(pick(), LABELS);
    expect(text).toContain("main > div.card:nth-of-type(2)");
    expect(text).toContain("En http://localhost:1420/tasks — 340×48 at (12, 96).");
    expect(text).toContain("### Marcado\n\n```html\n<div class=\"card\">Hola</div>\n```");
    expect(text).toContain("### Estilos calculados\n\n```css\ndisplay: flex;\ngap: 8px;\n```");
  });

  /** A page's own markup can contain a fence; the note must not break at it. */
  it("outgrows a fence inside the markup", () => {
    const text = buildDesignNote(pick({ html: "<pre>```</pre>" }), LABELS);
    expect(text).toContain("````html");
  });

  it("leaves out the halves the pick does not carry", () => {
    const text = buildDesignNote(pick({ css: "", html: "" }), LABELS);
    expect(text).not.toContain("Marcado");
    expect(text).not.toContain("Estilos");
    expect(text).toContain("main > div.card:nth-of-type(2)");
  });

  it("is empty when there is nothing to say, so no turn is spent", () => {
    expect(buildDesignNote(pick({ selector: "  ", html: "" }), LABELS)).toBe("");
  });
});

describe("shortLabel", () => {
  it("is the element itself, not the path to it", () => {
    expect(shortLabel("main > div.card:nth-of-type(2)")).toBe("div.card:nth-of-type(2)");
    expect(shortLabel("button")).toBe("button");
  });
});
