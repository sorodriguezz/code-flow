import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import type { DbmlField, DbmlSchema } from "../../lib/dbml/types";

/**
 * A comment, on the canvas — a column's, and the table's own.
 *
 * The feature is one glyph and a card, and only the glyph is in the drawing — the card is HTML over
 * the frame and needs a live pointer, which is the half a static render cannot reach. What is worth
 * holding still is therefore the half that *is* in the picture, and the one rule the two halves of
 * it have to agree on: the bubble's slot is **measured** into the box (`DBML_METRICS.rowPadding`)
 * and **reserved** out of the name (`Row`). Both, at the same number. Drop the first and a common
 * name like `created_at` is quietly cut to `created_…` the day somebody documents it; drop the
 * second and the mark lands on top of the type column of a box that hit its maximum width. The
 * header answers the same two questions with `namePadding` and the title's clip.
 */
const field = (name: string, type: string, note = ""): DbmlField => ({
  name,
  type,
  pk: false,
  notNull: false,
  unique: false,
  increment: false,
  default: null,
  note,
});

function schemaOf(
  fields: DbmlField[],
  enums: DbmlSchema["enums"] = [],
  table: { name?: string; note?: string } = {},
): DbmlSchema {
  return {
    tables: [
      {
        id: table.name ?? "posts",
        schema: "public",
        name: table.name ?? "posts",
        alias: null,
        note: table.note ?? "",
        fields,
        indexes: [],
      },
    ],
    enums,
    groups: [],
    refs: [],
    error: null,
    errorAt: null,
  };
}

function draw(schema: DbmlSchema) {
  return renderToStaticMarkup(
    <DbmlCanvas
      schema={schema}
      positions={{}}
      selected={null}
      onSelect={() => {}}
      mode="all"
      density="roomy"
      marks={{}}
    />,
  );
}

/** The comment bubbles in a render. The path is drawn by nothing else on this canvas. */
const bubbles = (html: string) => html.split('d="M21 15a2 2').length - 1;

/** Every box's width, in document order — the card backing, which is the measured figure. */
const widths = (html: string) =>
  [...html.matchAll(/<rect width="([\d.]+)" height="[\d.]+" rx="12" fill="var\(--cf-surface\)"/g)].map(
    (match) => match[1],
  );

/** The table names as they were actually drawn — the header run, ellipsis and all. */
const titles = (html: string) =>
  [...html.matchAll(/<text x="22" y="21\.5"[^>]*font-weight="600"[^>]*>([^<]*)<\/text>/g)].map(
    (match) => match[1],
  );

/** The column names as they were actually drawn, ellipsis and all. */
const names = (html: string) =>
  [...html.matchAll(/<text x="24"[^>]*font-size="11"[^>]*>([^<]*)<\/text>/g)].map(
    (match) => match[1],
  );

describe("a column's comment on the canvas", () => {
  it("marks the commented column and leaves the rest alone", () => {
    const html = draw(
      schemaOf([
        field("id", "integer"),
        field("body", "text", "Content of the post"),
        field("status", "varchar"),
      ]),
    );
    expect(bubbles(html)).toBe(1);
    // The three columns are all still drawn — a note adds a mark, it does not hide anything.
    expect(names(html)).toEqual(["id", "body", "status"]);
  });

  it("does not take whitespace for a comment", () => {
    expect(bubbles(draw(schemaOf([field("id", "integer", "   \n ")])))).toBe(0);
  });

  it("marks an enum's values too", () => {
    const html = draw(
      schemaOf(
        [field("id", "integer")],
        [
          {
            id: "status",
            schema: "public",
            name: "status",
            values: [
              { name: "active", note: "still billing" },
              { name: "closed", note: "" },
            ],
          },
        ],
      ),
    );
    expect(bubbles(html)).toBe(1);
  });

  it("takes its room from the box, not from the name", () => {
    // A name long enough to be what sets the table's width, and short enough that the box is not at
    // its maximum — the case where the measurement is free to answer.
    const name = "published_at_utc_original";
    const plain = draw(schemaOf([field(name, "timestamp")]));
    const noted = draw(schemaOf([field(name, "timestamp", "why it is here")]));

    expect(bubbles(noted)).toBe(1);
    // Every character still drawn: documenting a column does not shorten its name.
    expect(names(noted)).toEqual([name]);
    expect(names(plain)).toEqual([name]);
    // The box is exactly one slot wider, which is where the mark went.
    expect(Number(widths(noted)[0]) - Number(widths(plain)[0])).toBe(13);
  });

  it("marks a documented table in its header", () => {
    const html = draw(schemaOf([field("id", "integer")], [], { note: "One row per post" }));
    // One bubble, and it is the header's — no column here carries a note.
    expect(bubbles(html)).toBe(1);
    expect(titles(html)).toEqual(["posts"]);
  });

  it("takes the header's room from the box too", () => {
    // A name long enough that the *header* is what sets the box's width, which is the only case
    // where the mark and the name can compete for the same pixels.
    const name = "subscription_events_archive";
    const plain = draw(schemaOf([field("id", "integer")], [], { name }));
    const noted = draw(schemaOf([field("id", "integer")], [], { name, note: "why it is here" }));

    expect(bubbles(noted)).toBe(1);
    // The name is drawn whole in both — documenting a table does not shorten its name either.
    expect(titles(noted)).toEqual([name]);
    expect(titles(plain)).toEqual([name]);
    expect(Number(widths(noted)[0]) - Number(widths(plain)[0])).toBe(13);
  });

  it("still keeps clear of the type column on a box at its maximum width", () => {
    // Past `DBML_METRICS.maxWidth`, so the box cannot grow and the reservation is the only thing
    // standing between the bubble and the type beside it.
    const long = "a_column_name_long_enough_to_be_clipped_against_the_widest_box_this_canvas_draws";
    const plain = draw(schemaOf([field(long, "varchar")]));
    const noted = draw(schemaOf([field(long, "varchar", "why it is here")]));

    expect(bubbles(noted)).toBe(1);
    expect(widths(noted)).toEqual(widths(plain));
    // Capped, so here the name *is* what gives — by a slot's worth, and visibly.
    expect(names(noted)[0]!.length).toBeLessThan(names(plain)[0]!.length);
    expect(names(noted)[0]).toMatch(/…$/);
  });
});
