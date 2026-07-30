import type {
  DbDiagramColumn,
  DbDiagramEdge,
  DbNodeKind,
  DbSchemaDiagram,
} from "../../types/database";

/**
 * Turning a schema into a picture: what to count, where to put each box, and how to say it in
 * Mermaid.
 *
 * All of it is pure. The panel owns pan, zoom, dragging and colour; this owns the arithmetic — which
 * is the part worth being able to reason about on its own, because a layout bug looks exactly like a
 * rendering bug on screen and only one of the two can be checked by reading.
 *
 * The shape of the layout is **layered left-to-right along the foreign keys**: a table sits one
 * column to the right of everything it references, so the arrows run one way and the tables nothing
 * points at — the lookup tables, the roots of the model — line up on the left edge. That reads the
 * way people describe their own schema out loud ("an order belongs to a customer"), which a
 * force-directed blob does not.
 */

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 18;
/** The "+N more" line, when a table has more columns than are drawn. */
const OVERFLOW_HEIGHT = 16;
const NODE_MIN_WIDTH = 168;
const NODE_MAX_WIDTH = 320;
const COLUMN_GAP = 96;
const ROW_GAP = 32;
const PADDING = 40;

/** Beyond this a box stops being a table and becomes a wall. The rest is one "+N more" line. */
const MAX_ROWS = 24;

/** Rough advance width per character at the 11px font the boxes use. Estimated rather than
 * measured: measuring means a DOM round trip per label, and this only decides box width — a name
 * that overruns is truncated by the renderer's clip, not by this number being exact. */
const CHAR_WIDTH = 6.4;
const NAME_CHAR_WIDTH = 6.9;

export type DiagramColumnMode = "all" | "keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagramNode {
  /** `schema.name`, which is what an edge points at. */
  id: string;
  schema: string | null;
  name: string;
  kind: DbNodeKind;
  /**
   * Referenced by this schema but not part of it — a key into `auth.users`, or a table in another
   * database. Drawn as a stub so the line has somewhere to land: dropping the edge would make the
   * diagram claim the column points at nothing.
   */
  external: boolean;
  columns: DbDiagramColumn[];
  /** The columns actually drawn, after the column mode and the row cap. */
  visible: DbDiagramColumn[];
  hidden: number;
  rowEstimate: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Column name → the y of its row's centre, relative to the node's top. Only for drawn rows. */
  rowY: Record<string, number>;
}

export interface DiagramLink {
  id: string;
  /** Node ids. */
  from: string;
  to: string;
  fromColumn: string;
  toColumn: string;
  constraint: string;
  inferred: boolean;
  selfReference: boolean;
}

export interface DiagramLayout {
  nodes: DiagramNode[];
  links: DiagramLink[];
  width: number;
  height: number;
}

/**
 * The answers to "what is in here, and what is wrong with it".
 *
 * `withoutPrimaryKey` and `isolated` are id lists rather than counts because the panel lets you
 * click the number and light up the tables it counted — a count you can't act on is trivia.
 */
export interface DiagramStats {
  tables: number;
  views: number;
  columns: number;
  /** Distinct constraints, not lines: a composite key is one relationship drawn twice. */
  relations: number;
  /** How many of those are guesses rather than declarations. Mongo only. */
  inferred: number;
  /** Tables (never views — a view declares no keys) with no primary key. */
  withoutPrimaryKey: string[];
  /** Tables with no relationship in either direction. */
  isolated: string[];
  /** Tables referenced from here that live outside the schema. */
  external: number;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** How a table is addressed across the diagram. Schema-qualified, so a key into another schema's
 * `users` is a different node from this schema's. */
export function tableId(schema: string | null, name: string): string {
  return schema ? `${schema}.${name}` : name;
}

function edgeFromId(edge: DbDiagramEdge): string {
  return tableId(edge.from_schema, edge.from_table);
}

function edgeToId(edge: DbDiagramEdge): string {
  return tableId(edge.to_schema, edge.to_table);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function diagramStats(diagram: DbSchemaDiagram): DiagramStats {
  const own = new Set(diagram.tables.map((table) => tableId(table.schema, table.name)));
  const connected = new Set<string>();
  const external = new Set<string>();
  for (const edge of diagram.edges) {
    connected.add(edgeFromId(edge));
    connected.add(edgeToId(edge));
    if (!own.has(edgeToId(edge))) external.add(edgeToId(edge));
  }

  const constraints = new Set(diagram.edges.map((edge) => `${edgeFromId(edge)}|${edge.constraint}`));

  return {
    tables: diagram.tables.filter((table) => table.kind !== "view").length,
    views: diagram.tables.filter((table) => table.kind === "view").length,
    columns: diagram.tables.reduce((total, table) => total + table.columns.length, 0),
    relations: constraints.size,
    inferred: new Set(
      diagram.edges
        .filter((edge) => edge.inferred)
        .map((edge) => `${edgeFromId(edge)}|${edge.constraint}`),
    ).size,
    // A view has no primary key to be missing, so listing one here would be a false positive on
    // every schema that has views at all.
    withoutPrimaryKey: diagram.tables
      .filter((table) => table.kind !== "view")
      .filter((table) => !table.columns.some((column) => column.primary_key))
      .map((table) => tableId(table.schema, table.name)),
    isolated: diagram.tables
      .map((table) => tableId(table.schema, table.name))
      .filter((id) => !connected.has(id)),
    external: external.size,
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Places every table on a canvas.
 *
 * Three passes: assign each table a column from how deep it sits in the foreign-key graph, order
 * each column to pull connected tables level with each other, then convert those orders into
 * coordinates. `pinned` overrides the result for tables the user has dragged — their position is
 * theirs, and a relayout must not snatch it back.
 */
export function layoutDiagram(
  diagram: DbSchemaDiagram,
  mode: DiagramColumnMode,
  pinned: Record<string, { x: number; y: number }> = {},
): DiagramLayout {
  const nodes = buildNodes(diagram, mode);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links = buildLinks(diagram, byId);

  const depths = assignDepths(nodes, links);
  const layers = orderLayers(nodes, links, depths);

  // Column x: each layer is as wide as its widest box, so no two columns overlap however uneven
  // the boxes are.
  let x = PADDING;
  for (const layer of layers) {
    const width = Math.max(...layer.map((node) => node.width), NODE_MIN_WIDTH);
    let y = PADDING;
    for (const node of layer) {
      node.x = x;
      node.y = y;
      y += node.height + ROW_GAP;
    }
    x += width + COLUMN_GAP;
  }

  // Layers are centred against the tallest one, so a schema with one long chain and one short
  // branch doesn't hang everything off the top edge.
  const tallest = Math.max(
    ...layers.map((layer) => layer.reduce((total, node) => total + node.height + ROW_GAP, 0)),
    0,
  );
  for (const layer of layers) {
    const height = layer.reduce((total, node) => total + node.height + ROW_GAP, 0);
    const offset = (tallest - height) / 2;
    for (const node of layer) node.y += offset;
  }

  for (const node of nodes) {
    const seat = pinned[node.id];
    if (seat) {
      node.x = seat.x;
      node.y = seat.y;
    }
  }

  // Guarded, because `Math.max()` of nothing is `-Infinity` and an empty schema would hand the
  // panel a canvas it then tries to scale itself to.
  return {
    nodes,
    links,
    width: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.x + n.width)) + PADDING,
    height: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.y + n.height)) + PADDING,
  };
}

function buildNodes(diagram: DbSchemaDiagram, mode: DiagramColumnMode): DiagramNode[] {
  // Which columns are the far end of a relationship — they earn their place in "keys only" even
  // when they aren't this table's primary key.
  const referenced = new Set(
    diagram.edges.map((edge) => `${edgeToId(edge)}|${edge.to_column}`),
  );

  const nodes = diagram.tables.map((table) => {
    const id = tableId(table.schema, table.name);
    const kept =
      mode === "all"
        ? table.columns
        : table.columns.filter(
            (column) =>
              column.primary_key || column.foreign_key || referenced.has(`${id}|${column.name}`),
          );
    return measure({
      id,
      schema: table.schema,
      name: table.name,
      kind: table.kind,
      external: false,
      columns: table.columns,
      visible: kept.slice(0, MAX_ROWS),
      hidden: table.columns.length - Math.min(kept.length, MAX_ROWS),
      rowEstimate: table.row_estimate,
    });
  });

  // Stubs for whatever is pointed at from outside this schema.
  const known = new Set(nodes.map((node) => node.id));
  for (const edge of diagram.edges) {
    const id = edgeToId(edge);
    if (known.has(id)) continue;
    known.add(id);
    nodes.push(
      measure({
        id,
        schema: edge.to_schema,
        name: edge.to_table,
        kind: "table",
        external: true,
        columns: [],
        visible: [
          {
            name: edge.to_column,
            data_type: "",
            nullable: false,
            primary_key: true,
            foreign_key: false,
          },
        ],
        hidden: 0,
        rowEstimate: null,
      }),
    );
  }

  return nodes;
}

/** Fills in the size and the per-row offsets a node needs before it can be placed or drawn. */
function measure(
  node: Omit<DiagramNode, "x" | "y" | "width" | "height" | "rowY">,
): DiagramNode {
  const nameWidth = node.name.length * NAME_CHAR_WIDTH + 34;
  const rowWidth = node.visible.reduce((widest, column) => {
    const width = (column.name.length + column.data_type.length) * CHAR_WIDTH + 44;
    return Math.max(widest, width);
  }, 0);
  const width = Math.min(
    NODE_MAX_WIDTH,
    Math.max(NODE_MIN_WIDTH, Math.ceil(Math.max(nameWidth, rowWidth))),
  );

  const rowY: Record<string, number> = {};
  node.visible.forEach((column, index) => {
    rowY[column.name] = HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2;
  });

  return {
    ...node,
    width,
    height:
      HEADER_HEIGHT + node.visible.length * ROW_HEIGHT + (node.hidden > 0 ? OVERFLOW_HEIGHT : 0) + 4,
    rowY,
    x: 0,
    y: 0,
  };
}

function buildLinks(diagram: DbSchemaDiagram, byId: Map<string, DiagramNode>): DiagramLink[] {
  return diagram.edges
    .filter((edge) => byId.has(edgeFromId(edge)) && byId.has(edgeToId(edge)))
    .map((edge, index) => ({
      id: `${edge.constraint}|${index}`,
      from: edgeFromId(edge),
      to: edgeToId(edge),
      fromColumn: edge.from_column,
      toColumn: edge.to_column,
      constraint: edge.constraint,
      inferred: edge.inferred,
      selfReference: edgeFromId(edge) === edgeToId(edge),
    }));
}

/**
 * How far right each table sits: one past the deepest thing it references.
 *
 * Iterative rather than recursive, and capped by the node count, because a foreign-key graph is
 * routinely cyclic — `employee.manager_id → employee`, or two tables that reference each other —
 * and the honest answer for a cycle is "stop somewhere" rather than "recurse forever".
 */
function assignDepths(nodes: DiagramNode[], links: DiagramLink[]): Map<string, number> {
  const parents = new Map<string, string[]>();
  for (const link of links) {
    if (link.selfReference) continue;
    parents.set(link.from, [...(parents.get(link.from) ?? []), link.to]);
  }

  const depths = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const node of nodes) {
      const above = parents.get(node.id) ?? [];
      if (above.length === 0) continue;
      const want = Math.max(...above.map((id) => depths.get(id) ?? 0)) + 1;
      // Capped at the node count: in a cycle this is the pass where every member would otherwise
      // keep pushing the next one further right, forever.
      if (want > (depths.get(node.id) ?? 0) && want < nodes.length) {
        depths.set(node.id, want);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return depths;
}

/**
 * Orders each column so connected tables end up near the same height.
 *
 * The barycenter heuristic: sweep left to right putting each table at the average position of the
 * things it references, then right to left doing the reverse, a few times. It is the standard
 * crossing-reduction pass, and it is worth the twenty lines — the unsorted version draws a schema
 * of thirty tables as a cat's cradle.
 */
function orderLayers(
  nodes: DiagramNode[],
  links: DiagramLink[],
  depths: Map<string, number>,
): DiagramNode[][] {
  const depth = Math.max(...nodes.map((node) => depths.get(node.id) ?? 0), 0);
  const layers: DiagramNode[][] = Array.from({ length: depth + 1 }, () => []);
  for (const node of nodes) layers[depths.get(node.id) ?? 0].push(node);
  for (const layer of layers) layer.sort((a, b) => a.name.localeCompare(b.name));

  const index = new Map<string, number>();
  const reindex = () => {
    for (const layer of layers) layer.forEach((node, position) => index.set(node.id, position));
  };
  reindex();

  const neighbours = (id: string, side: "left" | "right") =>
    links
      .filter((link) => !link.selfReference && (side === "left" ? link.from === id : link.to === id))
      .map((link) => (side === "left" ? link.to : link.from));

  for (let pass = 0; pass < 4; pass += 1) {
    const forward = pass % 2 === 0;
    const order = forward ? [...layers.keys()] : [...layers.keys()].reverse();
    for (const position of order) {
      const side = forward ? "left" : "right";
      layers[position] = [...layers[position]].sort((a, b) => {
        const weight = (node: DiagramNode) => {
          const around = neighbours(node.id, side)
            .map((id) => index.get(id))
            .filter((value): value is number => value !== undefined);
          // A table with nothing on that side keeps its current place rather than being swept to
          // the top, which is what an unconnected table sorting as 0 would do.
          return around.length === 0
            ? (index.get(node.id) ?? 0)
            : around.reduce((total, value) => total + value, 0) / around.length;
        };
        return weight(a) - weight(b) || a.name.localeCompare(b.name);
      });
      reindex();
    }
  }

  return layers;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * The same schema as a Mermaid `erDiagram`.
 *
 * Text is what a diagram is worth outside this window: it goes in a README, a ticket or a pull
 * request, and it survives being read by someone who does not have the database. Only key columns
 * are emitted — the point of the export is the shape, and a hundred `varchar` lines drown it.
 *
 * Mermaid identifiers can't hold a dot or a space, so names are sanitised; the original is kept as
 * the relationship label where it differs.
 */
export function toMermaid(diagram: DbSchemaDiagram): string {
  const lines = ["erDiagram"];
  const safe = (name: string) => name.replace(/[^A-Za-z0-9_]/g, "_");

  for (const table of diagram.tables) {
    const keys = table.columns.filter((column) => column.primary_key || column.foreign_key);
    if (keys.length === 0) {
      lines.push(`  ${safe(table.name)} {`, `  }`);
      continue;
    }
    lines.push(`  ${safe(table.name)} {`);
    for (const column of keys) {
      const marker = column.primary_key ? " PK" : column.foreign_key ? " FK" : "";
      lines.push(`    ${safe(column.data_type) || "unknown"} ${safe(column.name)}${marker}`);
    }
    lines.push("  }");
  }

  // One line per constraint, not per column pair: a composite key is one relationship, and Mermaid
  // would draw the repeat as parallel edges between the same two boxes.
  const seen = new Set<string>();
  for (const edge of diagram.edges) {
    const key = `${edge.from_table}|${edge.to_table}|${edge.constraint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // `}o--||` — many-optional on the referencing side, exactly-one on the referenced side, which
    // is what a nullable foreign key into a primary key means.
    lines.push(
      `  ${safe(edge.to_table)} ||--o{ ${safe(edge.from_table)} : "${edge.from_column}"`,
    );
  }

  return lines.join("\n");
}
