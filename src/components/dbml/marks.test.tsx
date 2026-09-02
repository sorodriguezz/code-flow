import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import type { DbmlMarks } from "../../lib/dbml/layout";
import type { DbmlSchema } from "../../lib/dbml/types";

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

describe("marks on the canvas", () => {
  it("draws nothing extra when nothing is marked", () => {
    const html = draw({});
    expect(html).not.toContain("var(--cf-danger)");
    expect(html).not.toContain("var(--cf-success)");
    // The tables are still all there — a mark is the only thing that changes.
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  it.each([
    ["remove", "var(--cf-danger)"],
    ["review", "var(--cf-warning)"],
    ["keep", "var(--cf-success)"],
  ] as const)("draws a %s mark in its own colour", (kind, colour) => {
    expect(draw({ users: kind })).toContain(colour);
  });

  // The mark must never remove anything: that is the whole feature.
  it("keeps a table on the canvas when it is marked for removal", () => {
    const html = draw({ users: "remove" });
    expect(html).toContain(">users<");
    expect(html).toContain(">posts<");
  });

  it("dashes a relationship marked for removal", () => {
    expect(draw({ r1: "remove" })).toContain('stroke-dasharray="5 4"');
    expect(draw({ r1: "keep" })).not.toContain('stroke-dasharray="5 4"');
  });

  it("colours a marked relationship rather than the accent", () => {
    expect(draw({ r1: "keep" })).toContain("var(--cf-success)");
  });

  // A mark on an id that matches nothing — a table renamed outside the app, say — is inert.
  it("ignores a mark whose id is not in the schema", () => {
    const html = draw({ gone: "remove" });
    expect(html).not.toContain("var(--cf-danger)");
    expect(html).toContain(">users<");
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
