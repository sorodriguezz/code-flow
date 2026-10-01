import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DbmlCanvas } from "./DbmlCanvas";
import { parseDbml } from "../../lib/dbml/parse";

/**
 * A table's rows have to read as columns, not as three ragged edges.
 *
 * The types end at one x for the whole box and the badges end at another, and neither is a property
 * of the row it is on: both are set by the *busiest* row in the table. That is the one thing about
 * this drawing that cannot be checked by looking at a single row, and the one that breaks silently
 * — a badge that gets 2px wider, or a metric that goes back to charging each row its own strip,
 * leaves a box whose types step left every time a column happens to carry another mark.
 */
const SCHEMA = parseDbml(`
Table shop.orders {
  id integer [pk, increment]
  reference varchar(40) [not null, unique]
  note text
  customer_id integer [not null, ref: > shop.customers.id]
}

Table shop.customers {
  id integer [pk, increment]
}
`);

const html = renderToStaticMarkup(
  <DbmlCanvas
    schema={SCHEMA}
    positions={{}}
    selected={null}
    onSelect={() => {}}
    mode="all"
    density="roomy"
  />,
);

/**
 * The markup of one table's box.
 *
 * Split on the group every box opens with — a `translate` that also carries a `style`, which the
 * groups *inside* a box (the gutter glyphs) do not — so a slice is one whole card and not a header
 * that stops at the first row.
 */
function box(name: string, markup = html): string {
  const starts = [...markup.matchAll(/<g transform="translate\([^)]*\)" style=/g)].map(
    (match) => match.index,
  );
  const at = markup.indexOf(`>${name}<`);
  const from = starts.filter((start) => start < at).pop() ?? 0;
  const to = starts.find((start) => start > at) ?? markup.length;
  return markup.slice(from, to);
}

const typeColumn = (markup: string) =>
  [...markup.matchAll(/<text x="([\d.]+)"[^>]*font-size="9"[^>]*text-anchor="end"/g)].map(
    (match) => Number(match[1]),
  );

/** Every badge in the box, as `{ row, x, right }` — the row being the `y` they share. */
const badges = (markup: string) =>
  [...markup.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="(\d+)" height="13"/g)].map(
    (match) => ({
      row: Number(match[2]),
      x: Number(match[1]),
      right: Number(match[1]) + Number(match[3]),
    }),
  );

/** Where each row's strip of badges ends, one entry per row that has any. */
const stripEnds = (markup: string) => {
  const ends = new Map<number, number>();
  for (const badge of badges(markup)) {
    ends.set(badge.row, Math.max(ends.get(badge.row) ?? 0, badge.right));
  }
  return [...ends.values()];
};

describe("a table's rows", () => {
  it("ends every type at the same x, whatever badges the row carries", () => {
    // Four rows: three badges, two, none, two — and three different type lengths.
    const column = typeColumn(box("orders"));
    expect(column).toHaveLength(4);
    expect(new Set(column).size).toBe(1);
  });

  it("ends every badge strip at the same x", () => {
    const ends = stripEnds(box("orders"));
    // Three of the four rows carry badges; `note` carries none.
    expect(ends).toHaveLength(3);
    expect(new Set(ends).size).toBe(1);
  });

  it("keeps the type column clear of the badges", () => {
    const markup = box("orders");
    const leftmost = Math.min(...badges(markup).map((badge) => badge.x));
    expect(Math.max(...typeColumn(markup))).toBeLessThan(leftmost);
  });
});

/**
 * Where the pointer lands on a box, and what it shows there.
 *
 * Both of these were reported from use, and neither is visible in a picture of the canvas. A row's
 * `<g>` is hit only where one of its children paints, and a plain row paints only its words — so a
 * right-click in its empty part opened the *table's* menu, and its hover never fired. And the header
 * set a text cursor on the band alone, so an I-beam came and went over the gaps between its words
 * on a canvas where nothing is selectable. Rendered as the workbench renders it: editable, draggable.
 */
const noop = () => {};
const editable = renderToStaticMarkup(
  <DbmlCanvas
    schema={SCHEMA}
    positions={{}}
    onMoveTable={noop}
    selected={null}
    onSelect={noop}
    mode="all"
    density="roomy"
    editing={{
      blocked: false,
      setMark: noop,
      setFieldMark: noop,
      dropField: noop,
      autoArrange: noop,
      orthogonal: false,
      toggleRouting: noop,
      connect: noop,
      rename: noop,
      addField: noop,
      dropTable: noop,
      addTable: noop,
      addEnum: noop,
      dropRef: noop,
      flipRef: noop,
    }}
  />,
);

/** Each row's own target: `{ y, width }`, in document order. Nothing else on a box is unpainted,
 *  a row tall and hit-tested anyway. */
const rowTargets = (markup: string) =>
  [
    ...markup.matchAll(
      /<rect y="([\d.]+)" width="([\d.]+)" height="22" fill="none" pointer-events="all">/g,
    ),
  ].map((match) => ({ y: Number(match[1]), width: Number(match[2]) }));

/** The card's width — the backing rect, which is the measured figure. */
const cardWidth = (markup: string) =>
  Number(/<rect width="([\d.]+)" height="[\d.]+" rx="12" fill="var\(--cf-surface\)"/.exec(markup)?.[1]);

describe("the pointer over a box", () => {
  it("makes every row a target from edge to edge, not just its words", () => {
    for (const [name, rows] of [
      ["orders", 4],
      ["customers", 1],
    ] as const) {
      const markup = box(name, editable);
      const width = cardWidth(markup);
      // One per row, stacked under the 34px header at the 22px row pitch, each as wide as the card.
      expect(rowTargets(markup)).toEqual(
        Array.from({ length: rows }, (_, index) => ({ y: 34 + index * 22, width })),
      );
    }
  });

  it("puts the row's target under everything else on the row", () => {
    // First child of its row, so the connect handle, the comment's target and the mark's tooltip
    // drawn after it keep their own hit. React prints the row's group bare: handlers are not markup.
    expect(editable).toMatch(
      /<g><rect y="34" width="[\d.]+" height="22" fill="none" pointer-events="all">/,
    );
  });

  it("never shows a text cursor, header included", () => {
    expect(editable).not.toMatch(/cursor:\s*text/);
    // Not vacuous: the box's own cursor is still drawn.
    expect(editable).toContain("cursor:move");
  });
});
