import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import type { DbmlMarks } from "../../lib/dbml/layout";
import type { DbmlSchema } from "../../lib/dbml/types";
import type { Translate } from "../../state/languageStore";
import { markMenuItems } from "./markChrome";

/**
 * What a review mark looks like on the canvas.
 *
 * The point of the feature is that a decision about a table is visible *without* the table being
 * changed, so what is worth testing is that the marks reach the drawing at all and that the schema
 * comes through untouched by them.
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
        { name: "user_id", type: "integer", pk: false, notNull: true, unique: false, increment: false, default: null, note: "" },
      ],
      indexes: [],
    },
  ],
  enums: [],
  groups: [],
  error: null,
  errorAt: null,
  refs: [
    {
      id: "r1",
      from: { table: "posts", fields: ["user_id"], relation: "*" },
      to: { table: "users", fields: ["id"], relation: "1" },
    },
  ],
};

function draw(marks: DbmlMarks) {
  return renderToStaticMarkup(
    <DbmlCanvas
      schema={SCHEMA}
      positions={{}}
      selected={null}
      onSelect={() => {}}
      mode="all"
      density="roomy"
      marks={marks}
    />,
  );
}

/**
 * The colour of every mark spine in a render, in document order.
 *
 * The spine — the bar down a box's left edge — is the one shape on this canvas that nothing but a
 * mark draws, which is what makes it the thing to assert on. The mark *colours* stopped being a
 * proxy for "something is marked" when the rows grew their own legend: `--cf-success` is the `NN`
 * badge's as well now, so a table with a primary key draws it whether or not anybody has reviewed
 * that table.
 */
const spines = (html: string) =>
  [...html.matchAll(/<rect x="1\.5" y="10" width="3\.5"[^>]*fill="([^"]+)"/g)].map(
    (match) => match[1],
  );

describe("marks on the canvas", () => {
  it("draws nothing extra when nothing is marked", () => {
    const html = draw({});
    expect(spines(html)).toEqual([]);
    // The tables are still all there — a mark is the only thing that changes.
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  it.each([
    ["remove", "var(--cf-danger)"],
    ["review", "var(--cf-warning)"],
    ["keep", "var(--cf-success)"],
  ] as const)("draws a %s mark in its own colour", (kind, colour) => {
    expect(spines(draw({ users: kind }))).toEqual([colour]);
  });

  // The mark must never remove anything: that is the whole feature.
  it("keeps a table on the canvas when it is marked for removal", () => {
    const html = draw({ users: "remove" });
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  // Every line is dashed now, so the removal mark needs a pattern of its own on the far side of
  // that rather than a slightly shorter dash nobody could tell apart from the default.
  it("dots a relationship marked for removal, where every other line is dashed", () => {
    expect(draw({ r1: "remove" })).toContain('stroke-dasharray="1.5 4"');
    const kept = draw({ r1: "keep" });
    expect(kept).not.toContain('stroke-dasharray="1.5 4"');
    expect(kept).toContain('stroke-dasharray="6 4"');
  });

  it("colours a marked relationship rather than the accent", () => {
    // The stroke of the line itself: the badges on the rows are drawn in these hues too.
    expect(draw({ r1: "keep" })).toContain('stroke="var(--cf-success)" stroke-width="1.4"');
  });

  // A mark on an id that matches nothing — a table renamed outside the app, say — is inert.
  it("ignores a mark whose id is not in the schema", () => {
    const html = draw({ gone: "remove" });
    expect(spines(html)).toEqual([]);
    expect(html).not.toContain('stroke="var(--cf-danger)"');
    expect(html).toContain(">users<");
  });
});

/**
 * The rail a marked *column* is drawn with, in document order.
 *
 * The row wash is in the mark's colour and so are two of the five badges, and the strikethrough
 * only ever appears on one of the three marks — so the rail, which nothing else on this canvas
 * draws, is the shape worth asserting on. Same reasoning as `spines` above, one row down.
 */
const rails = (html: string) =>
  [...html.matchAll(/<rect x="7" y="\d+(?:\.\d+)?" width="2\.5"[^>]*fill="([^"]+)"/g)].map(
    (match) => match[1],
  );

/**
 * A decision about one column of a table, which is the unit a schema is actually reviewed in.
 *
 * The table-level tests above hold down that a mark reaches the drawing and changes nothing about
 * the schema. These hold the two things that are only true one row down: that a column's mark is
 * drawn *on its row* rather than on its box, and that the two kinds never stand in for each other.
 */
describe("marks on a column", () => {
  it("draws nothing extra when no column is marked", () => {
    expect(rails(draw({}))).toEqual([]);
  });

  it.each([
    ["remove", "var(--cf-danger)"],
    ["review", "var(--cf-warning)"],
    ["keep", "var(--cf-success)"],
  ] as const)("draws a %s mark in its own colour", (kind, colour) => {
    expect(rails(draw({ "users|id": kind }))).toEqual([colour]);
  });

  /* The row is washed as well as railed — the rail is what survives the zoom at which a schema
     fits on screen, and the wash is what you see when you are reading the table. */
  it("washes the row it is on", () => {
    expect(draw({ "users|id": "remove" })).toContain(
      'width="212" height="22" fill="var(--cf-danger)" fill-opacity="0.1"',
    );
  });

  /* The one mark that needs no legend, on the column's name — exactly as on a table's. */
  it("strikes through a column marked for removal, and no other", () => {
    expect(draw({ "posts|user_id": "remove" })).toContain(
      'stroke="var(--cf-danger)" stroke-width="1.1"',
    );
    expect(draw({ "posts|user_id": "review" })).not.toContain('stroke-width="1.1"');
  });

  /* The two kinds of mark live in one map, so the thing that must hold is that neither is ever
     read as the other: `users` marks the box, `users|id` marks one row of it. */
  it("does not mark the table the column belongs to", () => {
    const html = draw({ "users|id": "remove" });
    expect(rails(html)).toEqual(["var(--cf-danger)"]);
    expect(spines(html)).toEqual([]);
  });

  it("does not mark the columns of a table that is marked", () => {
    const html = draw({ users: "remove" });
    expect(spines(html)).toEqual(["var(--cf-danger)"]);
    expect(rails(html)).toEqual([]);
  });

  /* A column renamed or deleted outside this window, or a key from a hand-edited sidecar. */
  it("ignores a mark whose column is not in the schema", () => {
    expect(rails(draw({ "users|gone": "remove", "gone|id": "remove" }))).toEqual([]);
  });

  /* An enum's rows are values, not columns: there is no field line to write `// ELIMINAR` against,
     so drawing one would be a mark the document could never carry. */
  it("draws nothing on an enum's values", () => {
    const withEnum = renderToStaticMarkup(
      <DbmlCanvas
        schema={{
          ...SCHEMA,
          enums: [
            {
              id: "state",
              schema: "public",
              name: "state",
              values: [{ name: "draft", note: "" }],
            },
          ],
        }}
        positions={{}}
        selected={null}
        onSelect={() => {}}
        mode="all"
        density="roomy"
        marks={{ "state|draft": "remove" }}
      />,
    );
    expect(rails(withEnum)).toEqual([]);
    expect(withEnum).toContain(">draft<");
  });
});

/**
 * What covers what.
 *
 * SVG has no `z-index`, so both of these are properties of the emitted markup rather than of any
 * style: a box is in front because it comes later, and it hides what is under it because its
 * backing is opaque. Two overlapping tables used to show each other's column names through one
 * another, which reads as a broken renderer rather than as focus.
 */
describe("overlapping boxes", () => {
  const order = (html: string) =>
    ["users", "posts"].sort((a, b) => html.indexOf(`>${a}<`) - html.indexOf(`>${b}<`));

  it("paints the selected table last, so it is in front", () => {
    const html = renderToStaticMarkup(
      <DbmlCanvas
        schema={SCHEMA}
        positions={{}}
        selected="users"
        onSelect={() => {}}
        mode="all"
        density="roomy"
      />,
    );
    expect(order(html)[1]).toBe("users");
  });

  it("paints a receded table first, so it is behind", () => {
    // Selecting `posts` recedes nothing here (they are joined), so search is the way to recede one.
    const html = renderToStaticMarkup(
      <DbmlCanvas
        schema={SCHEMA}
        positions={{}}
        selected={null}
        onSelect={() => {}}
        mode="all"
        density="roomy"
        query="posts"
      />,
    );
    expect(order(html)[1]).toBe("posts");
  });

  /**
   * The fade must be on the card's *contents*, never on the group.
   *
   * A group opacity makes the backing translucent too, and then a receded box stops hiding whatever
   * it overlaps. So the backing rect must sit outside any faded group — which shows up in the
   * markup as a `fill="var(--cf-surface)"` rect with no `opacity` on it or on any ancestor.
   */
  it("keeps every card's backing fully opaque", () => {
    const html = renderToStaticMarkup(
      <DbmlCanvas
        schema={SCHEMA}
        positions={{}}
        selected={null}
        onSelect={() => {}}
        mode="all"
        density="roomy"
        query="posts"
      />,
    );
    expect(html).toContain('opacity="0.45"');
    for (const match of html.matchAll(/<g opacity="0\.45"[^>]*>(.*?)<\/g>/g)) {
      expect(match[1]).not.toContain('fill="var(--cf-surface)"');
    }
  });
});

/**
 * The three mark rows, as they sit in a menu next to the rows that are not marks.
 *
 * `ContextMenu` lays its rows out `items-start` so a label long enough to wrap keeps its glyph
 * beside the *first* line rather than floating in the middle of two — which means every glyph has
 * to carry its own optical centring. A Lucide icon does: 13px square, nudged 2px down. A bare 8px
 * dot did not, and sat visibly above the words it was labelling, in the canvas's row menu and in
 * the inspector's column menu alike. It also left the three coloured rows' labels four pixels to
 * the left of "Clear mark" below them, which is an eraser glyph.
 */
describe("the mark rows in a menu", () => {
  const rows = markMenuItems("review", () => {}, ((key: string) => key) as Translate);

  it("puts the dot in the same box a glyph would occupy", () => {
    for (const row of rows.filter((entry) => entry.leading)) {
      const slot = renderToStaticMarkup(<>{row.leading}</>);
      expect(slot).toContain("h-[13px]");
      expect(slot).toContain("w-[13px]");
      expect(slot).toContain("mt-[2px]");
    }
  });

  it("offers the way out once something is marked, and the other two marks", () => {
    expect(rows.map((row) => row.label)).toEqual([
      "dbml.mark.remove",
      "dbml.mark.keep",
      "dbml.mark.clear",
    ]);
    // The eraser is an icon rather than a `leading`, which is the row the three above have to line
    // up with.
    expect(rows[2].leading).toBeUndefined();
    expect(rows[2].icon).toBeDefined();
  });
});
