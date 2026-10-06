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
export function toSchemaDiagram(
  schema: DbmlSchema,
  mode: DiagramColumnMode,
  counts?: Record<string, number>,
): DbSchemaDiagram {
  // Which columns are an end of some reference. `foreign_key` drives the little link glyph in the
  // box and — through `erLayout`'s own filter — which columns survive "keys only".
  const linked = new Set<string>();
  for (const ref of schema.refs) {
    for (const field of ref.from.fields) linked.add(`${ref.from.table}|${field}`);
    for (const field of ref.to.fields) linked.add(`${ref.to.table}|${field}`);
  }

  const tables = schema.tables.map((table) => {
    /**
     * The columns of a *composite* primary key.
     *
     * `[pk]` on two fields is one key over both of them, and `@dbml/core` reports it that way: as a
     * table-level index with `pk: true`, leaving `field.pk` **false** on every column in it. Read
     * off the fields alone, the two-column key every junction table has is drawn as no key at all —
     * no glyph, no badge, and nothing to say why those two rows are the ones the lines arrive at.
     */
    const keyed = new Set(
      table.indexes.filter((index) => index.pk).flatMap((index) => index.columns),
    );
    const columns: DbDiagramColumn[] = table.fields.map((field) => {
      const primary = field.pk || keyed.has(field.name);
      return {
        name: field.name,
        data_type: field.type,
        // A key is not nullable, whichever of the two ways it was declared. The parser fills
        // `notNull` in for a single-field `[pk]` and does not for a composite one, so this reads
        // the resolved flag rather than the field's own.
        nullable: !field.notNull && !primary,
        primary_key: primary,
        foreign_key: linked.has(`${table.id}|${field.name}`),
        // Carried through so the box can badge it. A primary key is unique by definition and
        // badging it twice says nothing, so only a column that had to declare it gets the mark.
        unique: field.unique && !primary,
        // `increment` is implied by nothing else — a key is not automatically generated and a
        // generated column is not automatically a key — so unlike `unique` it is passed through as
        // declared, with no interaction with the other flags.
        auto_increment: field.increment,
        // The column's `[note: '…']`, carried through so the box can mark it — and so the box can
        // be *measured* for the mark, which is `DBML_METRICS.rowPadding` below.
        note: field.note,
      };
    });
    return {
      schema: table.schema === "public" ? null : table.schema,
      name: table.name,
      kind: "table" as const,
      // The table's own `Note: '…'`. Marked in the header band the way a column's is marked on its
      // row, and measured into the header the same way — `DBML_METRICS.namePadding`.
      note: table.note,
      columns:
        mode === "all"
          ? columns
          : columns.filter((column) => column.primary_key || column.foreign_key),
      row_estimate: counts?.[table.id] ?? null,
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
      // A value's own note. `Enum status { active [note: 'still billing'] }` is legal DBML and is
      // exactly the kind of thing a reader of the diagram is missing, so it is marked like a
      // column's — the enum boxes are drawn by the same row renderer.
      note: value.note,
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

/** The gap between two badges, and between the badge block and the type column that precedes it. */
export const BADGE_GAP = 3;

/** One of the five marks a column can earn, in the order they are drawn. */
export interface DbmlBadge {
  label: "PK" | "NN" | "AI" | "U" | "FK";
  width: number;
}

/**
 * Which badges a column earns, and how wide each is.
 *
 * Here rather than in the canvas that draws them, because it is *also* the answer to how wide the
 * box has to be — `DBML_METRICS` below and `Row` in `DbmlCanvas` are the same question asked at
 * measuring time and at drawing time, and when the two drifted the widest row's badges went over
 * the edge of a box that had been measured for one fewer. The canvas supplies the colours; this
 * supplies the set and the geometry.
 *
 * `NN` is asked of columns only. An enum's rows are values rather than columns, and a value is not
 * nullable or not — an empty `data_type` is what tells the two apart, since the enum boxes are laid
 * out by the same engine.
 */
export function columnBadges(column: DbDiagramColumn): DbmlBadge[] {
  const badges: DbmlBadge[] = [];
  if (column.primary_key) badges.push({ label: "PK", width: 20 });
  if (!column.nullable && column.data_type) badges.push({ label: "NN", width: 20 });
  if (column.auto_increment) badges.push({ label: "AI", width: 20 });
  if (column.unique) badges.push({ label: "U", width: 14 });
  if (column.foreign_key) badges.push({ label: "FK", width: 20 });
  return badges;
}

/**
 * The room a column's comment bubble takes on its row: the 10px drawing plus the clearance.
 *
 * Here and not in the canvas that draws it, for the same reason `columnBadges` is here — it is also
 * the answer to how wide the box has to be, and the day the two numbers drifted the badges on the
 * widest row went over the edge of a box measured for one fewer.
 */
export const NOTE_SLOT = 13;

/**
 * Whether a column — or a whole table — carries a comment worth marking. A blank note is not one.
 *
 * One predicate for both levels, read at measuring time and at drawing time. `note` is optional on
 * both shapes (nothing in a live catalog fills it in), so "has one" is a question with three
 * answers and this is where they are collapsed to two.
 */
export function isCommented(subject: { note?: string }): boolean {
  return Boolean(subject.note?.trim());
}

/** How wide the strip of them is, drawn end to end with `BADGE_GAP` between. */
export function badgeStripWidth(column: DbDiagramColumn): number {
  const badges = columnBadges(column);
  if (badges.length === 0) return 0;
  return (
    badges.reduce((sum, badge) => sum + badge.width, 0) + (badges.length - 1) * BADGE_GAP
  );
}

/**
 * The size of a box on *this* canvas.
 *
 * Bigger than the Database workspace's, and for one reason: a row here is not a line of text. It is
 * a glyph, a name, a type and up to five badges — so it needs the height to put them on a baseline
 * together and the width to hold whichever of them this particular column earns. The padding is
 * therefore per column rather than a constant: charging every row for a PK badge would pad two
 * hundred tables to fit a mark most of their columns never carry.
 *
 * The one thing every row *is* charged for is the 13px key gutter. It is reserved whether or not
 * the column has a glyph to put in it, because the alternative — indenting only the rows that do —
 * leaves the column of names down a table ragged, and a ragged column is what stops forty
 * identifiers being scannable.
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
  // The header is drawn in the same monospace as the rows, at 12px. Measuring it against the
  // engine's sans estimate lost a third of a pixel per character, which is invisible on a short
  // name and clips the last letter off a long one.
  nameAdvance: 12 * 0.6,
  // And it is drawn schema-qualified, so `shop.` is part of what has to fit.
  qualifiedName: true,
  // 62 for the glyph bar, the column count and the clearance they keep from the name — plus the
  // bubble's slot on a table that carries a note, for the same reason `rowPadding` charges one on a
  // commented row. A documented table is a shade wider; its name is not a character shorter.
  namePadding: (node) => 62 + (isCommented(node) ? NOTE_SLOT : 0),
  // 22 for the two side pads, 13 for the key gutter, 8 for the gap a name keeps from the type and
  // 6 for the one the type keeps from the badges — plus the comment bubble's slot on a row that has
  // one, which is charged here rather than taken out of the name.
  //
  // Measured rather than absorbed, and that is a real choice: the pin on a header is absorbed by
  // the *title*, because being held is a passing state of the UI and box widths are what the edge
  // router places lines around. A note is not a passing state — it is in the document, like the
  // badges, and the badges are measured. So a table with a commented column is a shade wider, once,
  // and no name is quietly cut short to make room for a mark about it.
  rowPadding: (column) => 49 + (isCommented(column) ? NOTE_SLOT : 0),
  badgeWidth: badgeStripWidth,
};

export function layoutDbml(
  schema: DbmlSchema,
  options: {
    mode: DiagramColumnMode;
    density: DiagramDensity;
    /** The boxes the user has dragged, by table id. Everything else is placed by the engine. */
    pinned: Record<string, { x: number; y: number }>;
    /**
     * Rows per table in the scratch database, when one has been built.
     *
     * `DiagramNode.rowEstimate` has been wired end to end since the Database workspace's ER view;
     * the DBML translation set it to `null` by hand because a document has no rows. Now it can, so
     * it is filled — and the number rides in the header band, which is why nothing about geometry
     * moves: not `rowY`, not `rowAt`, not the router's obstacles, not `route.test.ts`.
     */
    counts?: Record<string, number>;
  },
): DbmlLayout {
  const diagram = toSchemaDiagram(schema, options.mode, options.counts);
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
    // A boundary reaches a few pixels further than the tables it wraps — at `compact` density
    // always, and in *any* direction once a member has been dragged. Both edges have to move for
    // it: growing the size alone leaves a group hanging off the left of the viewBox, and moving the
    // origin alone leaves one hanging off the right. Either way it is missing from every export.
    ...extend(laid, groups),
  };
}

/** The canvas, grown in whichever directions the group boundaries reach past the tables. */
function extend(
  laid: DiagramLayout,
  groups: DbmlGroupBox[],
): { minX: number; minY: number; width: number; height: number } {
  const rects = groups.flatMap((box) => box.rects);
  if (rects.length === 0) {
    return { minX: laid.minX, minY: laid.minY, width: laid.width, height: laid.height };
  }
  const minX = Math.min(laid.minX, ...rects.map((rect) => rect.x - 4));
  const minY = Math.min(laid.minY, ...rects.map((rect) => rect.y - 4));
  const right = Math.max(laid.minX + laid.width, ...rects.map((rect) => rect.x + rect.width + 4));
  const bottom = Math.max(laid.minY + laid.height, ...rects.map((rect) => rect.y + rect.height + 4));
  return { minX, minY, width: right - minX, height: bottom - minY };
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
      // Never clamped at the origin. It was, on the theory that nothing may sit at a negative
      // coordinate — and that clamp is exactly what made the boundary *vanish*: drag a member left
      // of the origin and `right` goes negative too, so `right - 0` is a negative width, and an SVG
      // rect with a negative width is an error that draws nothing at all. The rest of the canvas
      // already handled negatives correctly — a dragged table is drawn wherever it was dragged — so
      // the boundary does now as well, and `DiagramLayout.minX` is what keeps the export and "fit
      // to window" honest about it.
      return { x: left, y: top, width: right - left, height: bottom - top };
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

/** A sticky note's sides, as the layout comment may carry them: anything outside is a hand-edit
 *  that would draw a note nobody can grab, and is dropped back to the default size. */
export const MIN_NOTE_SIDE = 60;
export const MAX_NOTE_SIDE = 2000;
export const DEFAULT_NOTE_SIZE = { w: 220, h: 130 };

/**
 * The second sidecar line: what the reader has decided about each table and relationship.
 *
 * # Why it is a comment and not part of the schema
 *
 * A mark is a note about the *review*, not about the database — "this table is probably going" is
 * not a fact about the model, it is a fact about the person reading it. Writing it into the DBML
 * *as schema* (as a `note`, say) would mean exporting the schema exports somebody's working notes,
 * and would change the parsed model on every click. As a comment it is invisible to `@dbml/core`,
 * invisible to every generator, and travels with the document exactly like the dragged box
 * positions do.
 *
 * A table's mark is *additionally* written as a readable `// ELIMINAR` comment above its
 * declaration — `edit.ts`'s `setMarkComment`, whose header carries that argument. This line stays
 * the source of truth: it is the one that is keyed by id (so it survives a rename), the one that
 * can be written while the document does not parse, and the only one that can hold a mark on a
 * relationship, which has no declaration of its own to sit above.
 *
 * # Why a second marker and not a field in the first
 *
 * `codeflow:layout` is `id → [x, y]` and is validated as such — a value that is not a pair of
 * finite numbers is dropped, deliberately, because a hand-edited file must not be able to put a box
 * at coordinates the canvas can never scroll to. Marks are a different shape with a different
 * validation, and stuffing them into the same object would mean one of the two has to stop being
 * simple. Two lines cost nothing: both are stripped by the same pass in `readLayout`.
 */
const MARKS_MARKER = "// codeflow:marks ";

/**
 * What a table or a relationship has been marked as, while a model is being reviewed.
 *
 * Three, because triage has three answers and no more: it goes, it stays, or somebody has to look
 * at it. A fourth would be a tag system, which is a different feature.
 */
export type DbmlMarkKind = "remove" | "review" | "keep";

const MARK_KINDS = new Set<string>(["remove", "review", "keep"]);

/** Keyed by table id (which is its qualified name), by ref id, or by `fieldMarkKey`. */
export type DbmlMarks = Record<string, DbmlMarkKind>;

/**
 * The key a *column's* mark is filed under: its table's id, a pipe, and the column's name.
 *
 * One map for three kinds of thing — tables, relationships and columns — rather than a third
 * sidecar line, because everything that already carries marks around then carries columns for
 * free: the reader and writer below, the rename migration in the workbench, the counts in the
 * status strip, and the validation that drops a value a hand-edit invented.
 *
 * `|` is the separator, and it is the one the rest of the app already uses for exactly this pair —
 * `joinedColumns` and `hoveredRow` in `DbmlCanvas` are both `"<tableId>|<column>"`. It cannot be
 * confused with either of the other two kinds of key: a table id is a qualified name and a ref id
 * is `a.b->c.d`, and a pipe appears in neither. The one way to collide is a *quoted* table name
 * that contains a pipe and reads as some other table's name plus one of its columns.
 */
export function fieldMarkKey(table: string, column: string): string {
  return `${table}|${column}`;
}

/** The table id and column name back out of one, or `null` when the key is not a column's. */
export function splitFieldMarkKey(key: string): { table: string; column: string } | null {
  const at = key.indexOf("|");
  return at === -1 ? null : { table: key.slice(0, at), column: key.slice(at + 1) };
}

/**
 * The marks that name something the schema still has — the ones the canvas can draw.
 *
 * The sidecar outlives what it names. A table or a column deleted or renamed *by typing*, rather
 * than from the canvas or the inspector (which carry the mark across, see `moveSidecarKey`), leaves
 * its mark filed under a key nothing will match again, and every later write carries it along. The
 * canvas draws only what it finds, so the raw sidecar is not a count of anything on screen: counted
 * as-is it reported "10 por eliminar" under a schema with nothing marked at all.
 *
 * Filtered rather than pruned. Retyping the name brings the mark back with it, which a pruned key
 * could not do — and while a name is being typed, every intermediate spelling is a schema in which
 * the table does not exist.
 */
export function liveMarks(schema: DbmlSchema, marks: DbmlMarks): DbmlMarks {
  const refs = new Set(schema.refs.map((ref) => ref.id));
  const boxes = new Set([...schema.tables, ...schema.enums].map((entry) => entry.id));
  const columns = new Map(
    schema.tables.map((table) => [table.id, new Set(table.fields.map((field) => field.name))]),
  );
  const live: DbmlMarks = {};
  for (const [key, mark] of Object.entries(marks)) {
    // A ref id first: it never holds a pipe, but it is the one kind that is not a table's name.
    const field = refs.has(key) ? null : splitFieldMarkKey(key);
    const named = field
      ? (columns.get(field.table)?.has(field.column) ?? false)
      : refs.has(key) || boxes.has(key);
    if (named) live[key] = mark;
  }
  return live;
}

/**
 * Where something sits on the canvas, as the layout comment records it: a table's dragged corner, or
 * a sticky note's corner *and size* (`[x, y, w, h]` — a note is resized by hand, a table never is).
 */
export interface LayoutSpot {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

export interface DbmlDocument {
  /** The DBML itself, with the marker lines removed. This is what the parser sees. */
  source: string;
  /** Table id (or `note:<name>`) → where the user put it. Empty when nothing has been placed. */
  positions: Record<string, LayoutSpot>;
  /** Table or ref id → how it has been marked. Empty when nothing has been marked. */
  marks: DbmlMarks;
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
  const isMarker = (line: string) => {
    const text = line.trimStart();
    return text.startsWith(LAYOUT_MARKER) || text.startsWith(MARKS_MARKER);
  };
  if (!lines.some(isMarker)) return { source: doc, positions: {}, marks: {} };

  const payloads = new Map<string, string>();
  const rest: string[] = [];
  for (const line of lines) {
    const text = line.trimStart();
    if (text.startsWith(LAYOUT_MARKER)) payloads.set(LAYOUT_MARKER, text.slice(LAYOUT_MARKER.length));
    else if (text.startsWith(MARKS_MARKER)) payloads.set(MARKS_MARKER, text.slice(MARKS_MARKER.length));
    else rest.push(line);
  }

  /**
   * Exactly the newline the writer added, and not one more.
   *
   * `writeLayout` puts a newline in front of the first marker and one after the last, so undoing it
   * removes the marker lines and *one* trailing empty element — never "trailing blank lines" in
   * general, and one regardless of how many markers there were, because they are written as a run.
   * The difference is not pedantry: the editor's text is this `source`, so trimming whitespace here
   * *deletes what is being typed*. Press Enter twice at the end of a schema whose boxes have been
   * dragged and, with a greedy trim, the second one is swallowed before the key is released.
   */
  if (rest.length > 0 && rest[rest.length - 1] === "") rest.pop();

  const positions: Record<string, LayoutSpot> = {};
  parse(payloads.get(LAYOUT_MARKER), (id, value) => {
    // `[x, y]`, or `[x, y, w, h]` for a sticky note, and nothing else. A stored file is not a
    // trusted input: it can be hand-edited, and a NaN reaching the layout puts a box at coordinates
    // the canvas can never scroll to.
    if (!Array.isArray(value) || value.length < 2) return;
    const [x, y, w, h] = value;
    if (typeof x !== "number" || typeof y !== "number") return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const spot: LayoutSpot = { x: Math.round(x), y: Math.round(y) };
    const size = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= MIN_NOTE_SIDE && n <= MAX_NOTE_SIDE;
    if (size(w) && size(h)) {
      spot.w = Math.round(w as number);
      spot.h = Math.round(h as number);
    }
    positions[id] = spot;
  });

  const marks: DbmlMarks = {};
  parse(payloads.get(MARKS_MARKER), (id, value) => {
    // Same rule, same reason: an unknown mark from a hand-edited file would reach the canvas as a
    // colour lookup that finds nothing and paints a table in `undefined`.
    if (typeof value === "string" && MARK_KINDS.has(value)) marks[id] = value as DbmlMarkKind;
  });

  return { source: rest.join("\n"), positions, marks };
}

/**
 * The document with its marker lines emptied rather than removed — for the parser.
 *
 * The markers are part of the code now, visible in the editor (so a copy carries them), and the
 * editor's line numbers are the document's. Removing the lines would shift every diagnostic below
 * a marker that sits mid-document; blanking them keeps a parse error on the line it is about, and
 * keeps their JSON braces away from the forgiving reader's brace counting.
 */
export function blankMarkers(doc: string): string {
  if (!doc.includes(LAYOUT_MARKER.trim()) && !doc.includes(MARKS_MARKER.trim())) return doc;
  return doc
    .split("\n")
    .map((line) => {
      const text = line.trimStart();
      return text.startsWith(LAYOUT_MARKER) || text.startsWith(MARKS_MARKER) ? "" : line;
    })
    .join("\n");
}

/** A sticky note where the canvas draws it. */
export interface StickyBox {
  id: string;
  name: string;
  content: string;
  color?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each sticky note goes: where the layout comment says, or — for one it has never placed, a
 * note pasted from dbdiagram.io say — stacked down a column to the right of the tables, so it is
 * on screen and over nothing.
 */
export function stickyBoxes(
  notes: readonly { id: string; name: string; content: string; color?: string }[],
  positions: Record<string, LayoutSpot>,
  bounds: { width: number },
): StickyBox[] {
  let nextY = 0;
  const column = Math.max(0, bounds.width) + 48;
  return notes.map((note) => {
    const spot = positions[note.id];
    const w = spot?.w ?? DEFAULT_NOTE_SIZE.w;
    const h = spot?.h ?? DEFAULT_NOTE_SIZE.h;
    if (spot) return { ...note, x: spot.x, y: spot.y, w, h };
    const box = { ...note, x: column, y: nextY, w, h };
    nextY += h + 16;
    return box;
  });
}

/** Walks one marker's JSON payload, ignoring anything that is not an object. */
function parse(payload: string | undefined, take: (id: string, value: unknown) => void): void {
  if (!payload) return;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") return;
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) take(id, value);
  } catch {
    // Left empty: a stored file is not a trusted input, and a broken sidecar must cost the boxes
    // their arrangement rather than cost the user their schema.
  }
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
export function writeLayout(
  source: string,
  positions: Record<string, LayoutSpot>,
  marks: DbmlMarks = {},
): string {
  const placed = Object.entries(positions);
  const marked = Object.entries(marks);
  if (placed.length === 0 && marked.length === 0) return source;

  // Sorted, so two saves of the same arrangement produce the same bytes: an unordered object would
  // make every autosave a diff, and this document is stored, exported and compared.
  placed.sort(([a], [b]) => a.localeCompare(b));
  marked.sort(([a], [b]) => a.localeCompare(b));

  const lines: string[] = [];
  if (placed.length > 0) {
    lines.push(
      LAYOUT_MARKER +
        JSON.stringify(
          Object.fromEntries(
            placed.map(([id, at]) => [
              id,
              at.w !== undefined && at.h !== undefined
                ? [Math.round(at.x), Math.round(at.y), Math.round(at.w), Math.round(at.h)]
                : [Math.round(at.x), Math.round(at.y)],
            ]),
          ),
        ),
    );
  }
  if (marked.length > 0) {
    lines.push(MARKS_MARKER + JSON.stringify(Object.fromEntries(marked)));
  }
  // One run, one trailing newline — which is what `readLayout` undoes by dropping a single empty
  // element however many markers there were.
  return `${source}\n${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Edits that would move boxes
// ---------------------------------------------------------------------------

type Spot = Pick<DiagramNode, "id" | "x" | "y">;
type Rect = Pick<DiagramNode, "x" | "y" | "width" | "height">;

/**
 * Pins every box an edit would move, where it is drawn now.
 *
 * The engine deals each layer — and the shelf of unwired tables under the flow — in **name order**,
 * so an edit that changes a name re-deals the boxes around it: renaming `users` to `accounts` sends
 * it to the top of its column and pushes every box above its old slot down one. Nothing about the
 * schema moved, only the alphabet, and to the person who just typed the name it reads as the
 * diagram jumping. A new table does the same to the shelf it joins.
 *
 * `before` is what is on screen, pins applied. `after` is the engine's answer for the edited schema
 * with **no pins**: a pin only ever moves its own box (`layoutDiagram` applies them after placing
 * everything), so that is exactly where each unpinned box would land. Whatever would land anywhere
 * else is pinned where it is now — the same pin a drag writes, so "Reorganizar" still hands it back
 * to the engine. `renamed` maps an id in `after` back to the one it had in `before`.
 */
export function holdPlaces(
  before: readonly Spot[],
  after: readonly Spot[],
  pinned: Record<string, { x: number; y: number }>,
  renamed: Record<string, string> = {},
): Record<string, { x: number; y: number }> {
  const drawn = new Map(before.map((box) => [box.id, box]));
  const next = { ...pinned };
  for (const box of after) {
    if (next[box.id]) continue;
    const was = drawn.get(renamed[box.id] ?? box.id);
    if (!was || (was.x === box.x && was.y === box.y)) continue;
    next[box.id] = { x: Math.round(was.x), y: Math.round(was.y) };
  }
  return next;
}

/** The clearance `placeNear` keeps from the boxes already drawn, and the step it searches in. */
const PLACE_GAP = 24;
/** How many steps out `placeNear` looks before settling for an overlap — ~1900px each way. */
const PLACE_REACH = 80;

/** Every offset within reach, in steps, nearest first. Built on the first placement, then kept. */
let nearestFirst: [number, number][] | null = null;

/**
 * Where a new box goes: centred on `at`, or on the nearest spot to it that covers no other box.
 *
 * `at` is the middle of what is on screen, so a table added from the canvas appears where the
 * person is looking. Left to the engine, an unwired table joins the shelf under the whole flow,
 * which on a schema of any size is off screen. Spots are tried nearest first, so the box lands
 * beside whatever already sits in the middle rather than on top of it; with nothing free within
 * reach it overlaps at the centre, which is still where it was asked for.
 */
export function placeNear(
  at: { x: number; y: number },
  size: { width: number; height: number },
  others: readonly Rect[],
): { x: number; y: number } {
  const origin = { x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2) };
  const free = (x: number, y: number) =>
    others.every(
      (box) =>
        x + size.width + PLACE_GAP <= box.x ||
        box.x + box.width + PLACE_GAP <= x ||
        y + size.height + PLACE_GAP <= box.y ||
        box.y + box.height + PLACE_GAP <= y,
    );

  if (!nearestFirst) {
    nearestFirst = [];
    for (let dx = -PLACE_REACH; dx <= PLACE_REACH; dx += 1) {
      for (let dy = -PLACE_REACH; dy <= PLACE_REACH; dy += 1) nearestFirst.push([dx, dy]);
    }
    nearestFirst.sort(([ax, ay], [bx, by]) => ax * ax + ay * ay - (bx * bx + by * by));
  }
  for (const [dx, dy] of nearestFirst) {
    const x = origin.x + dx * PLACE_GAP;
    const y = origin.y + dy * PLACE_GAP;
    if (free(x, y)) return { x, y };
  }
  return origin;
}

/** Re-exported so consumers take the layout vocabulary from here rather than reaching into `db/`. */
export type { DiagramColumnMode, DiagramDensity, DiagramLayout };
