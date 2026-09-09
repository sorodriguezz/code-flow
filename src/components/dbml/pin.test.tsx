import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import type { DbmlSchema } from "../../lib/dbml/types";

/**
 * The pin on the box, which is the *panel's* state drawn on the canvas.
 *
 * Holding the inspector on a table is a flag beside the selection, and until it was drawn here the
 * only evidence of it was a 12px button in a panel that is often closed — so pinning and then
 * clicking around looked like a panel that had stopped responding. What is worth asserting is that
 * exactly one box carries the glyph, that it is the right one, and that nothing else on the card
 * moves because of it.
 */
const SCHEMA: DbmlSchema = {
  tables: [
    {
      id: "users",
      schema: "public",
      name: "users",
      alias: null,
      note: "",
      fields: [
        { name: "id", type: "integer", pk: true, notNull: true, unique: false, increment: true, default: null, note: "" },
      ],
      indexes: [],
    },
    {
      id: "posts",
      schema: "public",
      name: "posts",
      alias: null,
      note: "",
      fields: [
        { name: "id", type: "integer", pk: true, notNull: true, unique: false, increment: true, default: null, note: "" },
      ],
      indexes: [],
    },
  ],
  enums: [],
  groups: [],
  refs: [],
  error: null,
  errorAt: null,
};

const draw = (pinnedId: string | null) =>
  renderToStaticMarkup(
    <DbmlCanvas
      schema={SCHEMA}
      positions={{}}
      selected={null}
      onSelect={() => {}}
      mode="all"
      density="roomy"
      pinnedId={pinnedId}
    />,
  );

/** Every pin drawing in a render. The path is lucide's and nothing else on this canvas uses it. */
const pins = (html: string) => [...html.matchAll(/<path d="M12 17v5 /g)].length;

describe("the pin on the canvas", () => {
  it("draws none when nothing is held", () => {
    const html = draw(null);
    expect(pins(html)).toBe(0);
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  it("draws exactly one, on the table that is held", () => {
    const html = draw("users");
    expect(pins(html)).toBe(1);
    // Both boxes are still drawn: the pin marks one, it does not filter the diagram.
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  /* In the accent and as a stroke, so `standaloneSvg` can resolve it — a `currentColor` glyph
     would reach the exported PNG as black. */
  it("is drawn in a colour the export can resolve", () => {
    const html = draw("users");
    const glyph = /<g transform="translate\([^)]*\) scale\([^)]*\)" fill="none" stroke="([^"]+)"/.exec(
      html.slice(html.indexOf('d="M12 17v5') - 400),
    );
    expect(glyph?.[1]).toBe("var(--cf-accent)");
    expect(html).not.toContain("currentColor");
  });

  /* The glyph is charged to the name rather than allowed to overlap it, so a held table's title is
     clipped one notch tighter. The box itself must not move: widths are what the edge router
     places lines around. */
  it("does not resize the box it is drawn on", () => {
    const boxes = (html: string) =>
      [...html.matchAll(/<rect width="([\d.]+)" height="([\d.]+)" rx="12"/g)].map((m) => m[0]);
    expect(boxes(draw("users"))).toEqual(boxes(draw(null)));
  });
});
