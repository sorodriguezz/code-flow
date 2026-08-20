import {
  layoutDiagram,
  type DiagramColumnMode,
  type DiagramDensity,
  type DiagramLayout,
  type NodeMetrics,
} from "../db/erLayout";
import type { DiagramNode } from "../db/erLayout";
import type { DbDiagramColumn, DbSchemaDiagram } from "../../types/database";
import { qualify, type DbmlSchema } from "./types";

/**
 * Where the boxes go — by handing the schema to the layout engine the Database workspace already
 * uses.
 *
 * **Nothing here places anything.** `db/erLayout.ts` assigns depths from the foreign keys, orders
 * the layers to cut crossings, wraps a layer that is taller than the canvas and measures every box
 * from its own text. Writing a second layout for DBML would mean a second set of answers to all of
 * that — and the *worse* set, since the one next door has been through two hundred-table schemas.
 * So a DBML document is translated into the shape that engine already takes, and the engine is
 * asked.
 *
 * That translation is the whole of this file, plus the one thing a live-edited document needs and a
 * live database does not: **a place to keep the boxes the user has dragged**. See `readLayout`.
 */

/** Where the enums are drawn, per enum id, when the schema has any. Enum values become "columns". */
const ENUM_KIND = "collection" as const;

/**
 * A parsed DBML document as the layout engine's input.
 *
 * `mode` is applied *here* rather than passed on, so that "keys only" narrows tables without
 * emptying the enum cards — an enum has no primary key, and a column filter that ran over it would
 * leave a header with nothing under it.
 */
export function toSchemaDiagram(schema: DbmlSchema, mode: DiagramColumnMode): DbSchemaDiagram {
  // Which columns are an end of some reference. `foreign_key` drives the little link glyph in the
  // box and — through `erLayout`'s own filter — which columns survive "keys only".
  const linked = new Set<string>();
  for (const ref of schema.refs) {
    for (const field of ref.from.fields) linked.add(`${ref.from.table}|${field}`);
    for (const field of ref.to.fields) linked.add(`${ref.to.table}|${field}`);
  }

  const tables = schema.tables.map((table) => {
    const columns: DbDiagramColumn[] = table.fields.map((field) => ({
      name: field.name,
      data_type: field.type,
      nullable: !field.notNull && !field.pk,
      primary_key: field.pk,
      foreign_key: linked.has(`${table.id}|${field.name}`),
      // Carried through so the box can badge it. A primary key is unique by definition and badging
      // it twice says nothing, so only a column that had to declare it gets the mark.
      unique: field.unique && !field.pk,
    }));
    return {
      schema: table.schema === "public" ? null : table.schema,
      name: table.name,
      kind: "table" as const,
      columns:
        mode === "all"
          ? columns
          : columns.filter((column) => column.primary_key || column.foreign_key),
      row_estimate: null,
    };
  });

  // Enums as boxes of their own, with each value drawn as a row. Not a table — `enumIds` below is
  // what the canvas reads to draw them in the enum colour — but the same *shape*, because the
  // layout engine's job is to place rectangles and an enum is one.
  const enums = schema.enums.map((entry) => ({
    schema: entry.schema === "public" ? null : entry.schema,
    name: entry.name,
    kind: ENUM_KIND,
    columns: entry.values.map((value) => ({
      name: value.name,
      data_type: "",
      nullable: false,
      primary_key: false,
      foreign_key: false,
    })),
    row_estimate: null,
  }));

  return {
    database: null,
    schema: null,
    tables: [...tables, ...enums],
    edges: schema.refs.map((ref) => ({
      constraint: ref.id,
      from_schema: schemaPartOf(ref.from.table),
      from_table: namePartOf(ref.from.table),
      from_column: ref.from.fields[0] ?? "",
      to_schema: schemaPartOf(ref.to.table),
      to_table: namePartOf(ref.to.table),
      to_column: ref.to.fields[0] ?? "",
      inferred: false,
    })),
    notes: [],
  };
}

/**
 * The laid-out diagram, and which of its nodes are enums.
 *
 * The two travel together because they are read together: every consumer that draws a node has to
 * know which of the two things it is, and re-deriving that from the schema at each of them is how a
 * table called `status` ends up drawn as an enum.
 */
export interface DbmlLayout extends DiagramLayout {
  enumIds: Set<string>;
  /** One boundary per `TableGroup` that has at least one placed member. */
  groups: DbmlGroupBox[];
}

/**
 * A `TableGroup`, drawn.
 *
 * One rectangle when the group's members happen to sit together, several — one per member — when
 * they do not. See `groupBoxes` for why it is allowed to be either.
 */
export interface DbmlGroupBox {
  id: string;
  name: string;
  /** True when `rects` is a single hull rather than one outline per member. */
  enclosed: boolean;
  rects: { x: number; y: number; width: number; height: number }[];
  /**
   * Where the name is written — one position per rect, inside its top-left clearance.
   *
   * Every outline is labelled, not just the first. A group split into three outlines with the name
   * on one of them is three dashed boxes, one of which happens to say `billing`; with the name on
   * all three it is one group in three places, which is what it is.
   */
  labels: { x: number; y: number }[];
}

/**
 * The clearance between a member table and the boundary drawn around it.
 *
 * Per density, and it has to be: `compact` stacks boxes twelve pixels apart, so a twenty-pixel halo
 * around one of them reaches over the top of its neighbour — and if that neighbour is not in the
 * group, the outline drawn to say "these tables and no others" has just gone round one more.
 * Smaller than the gap the density itself leaves, in both cases.
 */
const GROUP_PAD: Record<DiagramDensity, number> = { roomy: 20, compact: 6 };

/**
 * The size of a box on *this* canvas.
 *
 * Bigger than the Database workspace's, and for one reason: a row here is not a line of text. It is
 * a name, a type in a pill, and up to three badges — so it needs the height to put them on a
 * baseline together and the width to hold whichever of them this particular column earns. The
 * padding is therefore per column rather than a constant: charging every row for a PK badge would
 * pad two hundred tables to fit a mark most of their columns never carry.
 */
export const DBML_METRICS: NodeMetrics = {
  header: 34,
  row: 22,
  overflow: 18,
  minWidth: 212,
  // Wide enough that a long name is a wide box rather than an ellipsis. A schema-qualified
  // `analytics.subscription_events` is 29 characters, and at the header's own advance that alone is
  // 209px before the glyph and the count are allowed for.
  maxWidth: 470,
  namePadding: 62,
  // The header is drawn in the same monospace as the rows, at 12px. Measuring it against the
  // engine's sans estimate lost a third of a pixel per character, which is invisible on a short
  // name and clips the last letter off a long one.
  nameAdvance: 12 * 0.6,
  // And it is drawn schema-qualified, so `shop.` is part of what has to fit.
  qualifiedName: true,
  rowPadding: (column) =>
    46 +
    (column.primary_key ? 36 : 0) +
    (column.foreign_key ? 23 : 0) +
    (column.unique ? 17 : 0),
};

export function layoutDbml(
  schema: DbmlSchema,
  options: {
    mode: DiagramColumnMode;
    density: DiagramDensity;
    /** The boxes the user has dragged, by table id. Everything else is placed by the engine. */
    pinned: Record<string, { x: number; y: number }>;
  },
): DbmlLayout {
  const diagram = toSchemaDiagram(schema, options.mode);
  const groupBy = new Map<string, string>();
  for (const group of schema.groups) {
    for (const id of group.tables) groupBy.set(id, group.id);
  }
  // `"all"` and not `options.mode`: the column filter has already been applied above, where it
  // could leave the enums alone. Passing it on would run it a second time over what survived.
  const laid = layoutDiagram(
    diagram,
    "all",
    options.pinned,
    options.density,
    DBML_METRICS,
    groupBy.size === 0 ? undefined : (id) => groupBy.get(id) ?? null,
  );

  const groups = groupBoxes(schema, laid, options.density);
  return {
    ...laid,
    enumIds: new Set(schema.enums.map((entry) => entry.id)),
    groups,
    // A boundary may want a few pixels more clearance than the layout's own padding left it — at
    // `compact` density it always does. Growing the canvas is the whole fix: the alternative is a
    // group whose right edge is outside the viewBox and therefore missing from every export.
    width: Math.max(
      laid.width,
      ...groups.flatMap((box) => box.rects.map((rect) => rect.x + rect.width + 4)),
    ),
    height: Math.max(
      laid.height,
      ...groups.flatMap((box) => box.rects.map((rect) => rect.y + rect.height + 4)),
    ),
  };
}

/**
 * Boundaries, measured from where the members actually landed.
 *
 * Drawn *after* the layout, never as a constraint on it: the tables follow the foreign keys and the
 * user's own dragging, and the boundary follows the tables.
 *
 * Which means the obvious drawing — one rectangle around the members' bounding box — is a rectangle
 * that can contain tables that are not in the group. The layout is layered by foreign-key depth, so
 * a group whose members sit at two different depths spans horizontally, and whatever is at the depth
 * in between goes inside the box with them. A container that says `billing` and encloses four tables
 * when the group has two is not a rougher answer than the truth; it is a different, wrong one.
 *
 * So the hull is drawn **only when it holds nothing else**. When it would swallow a stranger, the
 * same dashed line is drawn around each member instead: less pretty, and it still says exactly
 * which tables are in the group and no more. Dragging the members together turns it back into a
 * container, which is the arrangement anyone who bothered to declare a group probably wanted.
 */
function groupBoxes(
  schema: DbmlSchema,
  laid: DiagramLayout,
  density: DiagramDensity,
): DbmlGroupBox[] {
  const pad = GROUP_PAD[density];
  const byId = new Map(laid.nodes.map((node) => [node.id, node]));
  const boxes: DbmlGroupBox[] = [];

  for (const group of schema.groups) {
    const members = group.tables
      .map((id) => byId.get(id))
      .filter((node): node is DiagramNode => node !== undefined);
    if (members.length === 0) continue;

    const around = (nodes: DiagramNode[]) => {
      const left = Math.min(...nodes.map((node) => node.x)) - pad;
      const top = Math.min(...nodes.map((node) => node.y)) - pad;
      const right = Math.max(...nodes.map((node) => node.x + node.width)) + pad;
      const bottom = Math.max(...nodes.map((node) => node.y + node.height)) + pad;
      // Clamped at the origin: nothing may sit at a negative coordinate, or the export's viewBox
      // cuts it off and "fit to window" centres the diagram against a canvas it does not fill. The
      // clamp shrinks the clearance on that one edge and never moves a table — which matters,
      // because the tables are laid out from `pinned` and a shift here would be written back into
      // the document by the next drag.
      const x = Math.max(0, left);
      const y = Math.max(0, top);
      return { x, y, width: right - x, height: bottom - y };
    };

    const hull = around(members);
    const own = new Set(members.map((node) => node.id));
    const clean = laid.nodes.every(
      (node) =>
        own.has(node.id) ||
        node.x + node.width <= hull.x ||
        node.x >= hull.x + hull.width ||
        node.y + node.height <= hull.y ||
        node.y >= hull.y + hull.height,
    );

    const rects = clean ? [hull] : members.map((node) => around([node]));
    boxes.push({
      id: group.id,
      name: group.name,
      enclosed: clean,
      rects,
      labels: rects.map((rect) => ({
        x: rect.x + Math.max(6, pad - 9),
        y: rect.y + Math.max(9, pad - 6),
      })),
    });
  }

  // Biggest first, so a group nested inside another does not disappear underneath it.
  const area = (box: DbmlGroupBox) =>
    box.rects.reduce((total, rect) => total + rect.width * rect.height, 0);
  return boxes.sort((a, b) => area(b) - area(a));
}

/** The schema half of a qualified id, or `null` for the default schema. `erLayout` wants them apart. */
function schemaPartOf(id: string): string | null {
  const dot = id.indexOf(".");
  return dot === -1 ? null : id.slice(0, dot);
}

function namePartOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(dot + 1);
}

/** The id `erLayout` will give this table's node, which is the same one `qualify` produced. */
export function nodeIdOf(schema: string, name: string): string {
  return qualify(schema, name);
}

// ---------------------------------------------------------------------------
// Dragged positions
// ---------------------------------------------------------------------------

/**
 * The marker that carries the dragged boxes, written as the document's last line.
 *
 * **A comment, deliberately, and not a second column in the database.** A diagram's document is one
 * string and its format names the dialect — that is the whole contract the Diagrams workspace is
 * built on (see `lib/diagrams/doc.ts`), and it is what makes a diagram exportable, duplicable and
 * importable without anything downstream knowing what is inside it. Positions in a sidecar column
 * would be lost by every one of those paths.
 *
 * DBML's own `//` comment runs to the end of the line, so the JSON below is invisible to the
 * parser — verified against `@dbml/core` 8.3, not assumed — and a `.dbml` file exported from here
 * opens in any other tool with nothing worse than one unfamiliar comment at the bottom.
 */
const LAYOUT_MARKER = "// codeflow:layout ";

export interface DbmlDocument {
  /** The DBML itself, with the marker line removed. This is what the parser and the editor see. */
  source: string;
  /** Table id → where the user dragged it. Empty when nothing has been dragged. */
  positions: Record<string, { x: number; y: number }>;
}

/**
 * Splits a stored document into the DBML and the positions.
 *
 * A malformed or absent marker is not an error and does not stop the document being read: the
 * boxes simply go back to where the layout engine puts them. Losing a hand-arrangement is a
 * disappointment; refusing to open the diagram over it would be data loss.
 */
export function readLayout(doc: string): DbmlDocument {
  const lines = doc.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith(LAYOUT_MARKER));
  if (at === -1) return { source: doc, positions: {} };

  const payload = lines[at].trimStart().slice(LAYOUT_MARKER.length);
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)];
  /**
   * Exactly the two lines the writer added, and not one more.
   *
   * `writeLayout` puts a newline in front of the marker and one after it, so undoing it removes the
   * marker line and one trailing empty element — never "trailing blank lines" in general. The
   * difference is not pedantry: the editor's text is this `source`, so trimming whitespace here
   * *deletes what is being typed*. Press Enter twice at the end of a schema whose boxes have been
   * dragged and, with a greedy trim, the second one is swallowed before the key is released.
   */
  if (rest.length > 0 && rest[rest.length - 1] === "") rest.pop();

  const positions: Record<string, { x: number; y: number }> = {};
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        // `[x, y]` and nothing else. A stored file is not a trusted input: it can be hand-edited,
        // and a NaN reaching the layout puts a box at coordinates the canvas can never scroll to.
        if (!Array.isArray(value) || value.length < 2) continue;
        const [x, y] = value;
        if (typeof x !== "number" || typeof y !== "number") continue;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        positions[id] = { x: Math.round(x), y: Math.round(y) };
      }
    }
  } catch {
    // Left empty: see the comment above.
  }
  return { source: rest.join("\n"), positions };
}

/**
 * Puts a document back together for storage.
 *
 * The marker is dropped entirely when nothing has been dragged, so a document that has only ever
 * been typed stays a plain `.dbml` file — the common case should not carry the machinery of the
 * uncommon one. In that case the source comes back **byte for byte**, which is what makes
 * `readLayout(writeLayout(x, p)).source === x` hold for every `x`; see `readLayout` for why that
 * matters while somebody is typing into it.
 */
export function writeLayout(source: string, positions: Record<string, { x: number; y: number }>): string {
  const entries = Object.entries(positions);
  if (entries.length === 0) return source;
  // Sorted, so two saves of the same arrangement produce the same bytes: an unordered object would
  // make every autosave a diff, and this document is stored, exported and compared.
  entries.sort(([a], [b]) => a.localeCompare(b));
  const payload = JSON.stringify(
    Object.fromEntries(entries.map(([id, at]) => [id, [Math.round(at.x), Math.round(at.y)]])),
  );
  return `${source}\n${LAYOUT_MARKER}${payload}\n`;
}

/** Re-exported so consumers take the layout vocabulary from here rather than reaching into `db/`. */
export type { DiagramColumnMode, DiagramDensity, DiagramLayout };
