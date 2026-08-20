import { translate } from "../../state/languageStore";
import type { TranslationKey } from "../i18n/translations";
import type { DiagramTemplate, DiagramTemplateRow } from "../../types/diagrams";
import type { DiagramFormat } from "../../types/diagrams";
import { DEFAULT_FORMAT, FORMAT_DBML } from "./doc";
import { anchors, edge, model, vertex } from "./mxgraph";
import { parseTags } from "../notes/tags";

/**
 * The diagrams that ship with the app, as starting points.
 *
 * A constant here, but not what the picker shows. `diagramsStore.setWorkspace` writes these into
 * `diagram_templates` as ordinary rows the first time a workspace is opened — once, tracked by a
 * settings flag rather than by "the table happens to be empty" — so from the picker's point of view
 * a shipped template and one the user saved are the same kind of thing: editable, deletable,
 * indistinguishable. The trade is the one `lib/notes/templates.ts` documents: a seeded row stops
 * following the app's language, because a row holds one language and there is no other way to give
 * someone an editable copy.
 *
 * They are also *why* the picker exists. A diagram tool whose "new" button opens an empty canvas
 * teaches nothing about what to draw; five openings that are already the right shape is most of
 * what a template feature is for.
 *
 * **Each is deliberately small** — five to eight shapes. A template is a first move, not a finished
 * drawing, and one that arrives nearly complete is one people delete rather than edit.
 */

/** Fills a lane of the palette without being a paint chart. Chosen to read on both themes. */
const BLUE = "#dae8fc";
const BLUE_LINE = "#6c8ebf";
const GREEN = "#d5e8d4";
const GREEN_LINE = "#82b366";
const AMBER = "#fff2cc";
const AMBER_LINE = "#d6b656";
const PURPLE = "#e1d5e7";
const PURPLE_LINE = "#9673a6";
const GREY = "#f5f5f5";
const GREY_LINE = "#999999";

const box = (fill: string, stroke: string, extra = "") =>
  `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};${extra}`;

/** An edge that leaves the right side and arrives on the left, rather than wherever the router
 *  fancies. See its use in `network` for what it is fixing. */
const FAN =
  "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;exitX=1;exitY=0.5;exitDx=0;exitDy=0;" +
  "entryX=0;entryY=0.5;entryDx=0;entryDy=0;";

/** A label, from the `diagrams.tpl.<id>.<key>` namespace. Typed against `TranslationKey`, so a
 *  template added without its strings is a compile error rather than a blank shape. */
const label = (key: TranslationKey) => translate(key);

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------

/** Start → process → decision, with both branches drawn. The shape of most first diagrams. */
function flowchart(): string {
  return model([
    vertex({
      id: "s",
      value: label("diagrams.tpl.flow.start"),
      style: `ellipse;whiteSpace=wrap;html=1;fillColor=${GREEN};strokeColor=${GREEN_LINE};`,
      x: 320,
      y: 40,
      width: 140,
      height: 50,
    }),
    vertex({
      id: "p",
      value: label("diagrams.tpl.flow.step"),
      style: box(BLUE, BLUE_LINE),
      x: 320,
      y: 150,
      width: 140,
      height: 60,
    }),
    vertex({
      id: "d",
      value: label("diagrams.tpl.flow.check"),
      style: `rhombus;whiteSpace=wrap;html=1;fillColor=${AMBER};strokeColor=${AMBER_LINE};`,
      x: 310,
      y: 270,
      width: 160,
      height: 90,
    }),
    vertex({
      id: "y",
      value: label("diagrams.tpl.flow.yes"),
      style: box(BLUE, BLUE_LINE),
      x: 560,
      y: 285,
      width: 150,
      height: 60,
    }),
    vertex({
      id: "e",
      value: label("diagrams.tpl.flow.end"),
      style: `ellipse;whiteSpace=wrap;html=1;fillColor=${GREY};strokeColor=${GREY_LINE};`,
      x: 320,
      y: 430,
      width: 140,
      height: 50,
    }),
    edge({ id: "e1", source: "s", target: "p" }),
    edge({ id: "e2", source: "p", target: "d" }),
    edge({ id: "e3", source: "d", target: "y", value: label("diagrams.tpl.flow.branchYes") }),
    edge({ id: "e4", source: "d", target: "e", value: label("diagrams.tpl.flow.branchNo") }),
    edge({ id: "e5", source: "y", target: "e" }),
  ]);
}

/** A C4 container view: the person, the two things that run, and the thing that stores. */
function c4Containers(): string {
  return model([
    vertex({
      id: "u",
      value: label("diagrams.tpl.c4.user"),
      style:
        "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;",
      x: 80,
      y: 180,
      width: 40,
      height: 70,
    }),
    vertex({
      id: "web",
      value: label("diagrams.tpl.c4.web"),
      style: box(BLUE, BLUE_LINE),
      x: 220,
      y: 180,
      width: 170,
      height: 70,
    }),
    vertex({
      id: "api",
      value: label("diagrams.tpl.c4.api"),
      style: box(BLUE, BLUE_LINE),
      x: 460,
      y: 180,
      width: 170,
      height: 70,
    }),
    vertex({
      id: "db",
      value: label("diagrams.tpl.c4.db"),
      style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=${PURPLE};strokeColor=${PURPLE_LINE};`,
      x: 710,
      y: 170,
      width: 130,
      height: 90,
    }),
    vertex({
      id: "ext",
      value: label("diagrams.tpl.c4.external"),
      style: box(GREY, GREY_LINE, "dashed=1;"),
      x: 460,
      y: 330,
      width: 170,
      height: 60,
    }),
    edge({ id: "c1", source: "u", target: "web", value: label("diagrams.tpl.c4.uses") }),
    edge({ id: "c2", source: "web", target: "api", value: "HTTPS" }),
    edge({ id: "c3", source: "api", target: "db", value: "SQL" }),
    edge({ id: "c4", source: "api", target: "ext" }),
  ]);
}

/**
 * Three lifelines and the round trip between them, in draw.io's own UML sequence shapes.
 *
 * **Every message pins its own height through `anchors`**, and that is the whole difficulty of this
 * one. A message is a horizontal line at a particular height on two lifelines — the height *is* the
 * ordering, which is most of what a sequence diagram carries — and an edge left to the router puts
 * all four at whatever single height it likes. The first attempt used `mxPoint` waypoints, which
 * mxGraph ignores for an attached edge; all four messages stacked into one line. See `anchors`.
 */
function sequence(): string {
  /** Where each lifeline's dashed spine runs, so a message can be aimed at it. */
  const LANES = { l1: 80, l2: 320, l3: 560 } as const;
  const LANE_WIDTH = 150;
  const LANE_TOP = 40;
  const LANE_HEIGHT = 360;

  const lifeline = (id: keyof typeof LANES, value: string) =>
    vertex({
      id,
      value,
      style:
        "shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;" +
        "collapsible=0;recursiveResize=0;outlineConnect=0;",
      x: LANES[id],
      y: LANE_TOP,
      width: LANE_WIDTH,
      height: LANE_HEIGHT,
    });

  /**
   * One message, at its own height.
   *
   * The height is expressed as a *fraction of the lifeline's box* rather than as a coordinate,
   * because that is the only form mxGraph honours for an edge whose ends name cells — see
   * `anchors`. `0.5` on x is the spine.
   */
  const message = (
    id: string,
    source: keyof typeof LANES,
    target: keyof typeof LANES,
    value: string,
    y: number,
    dashed = false,
  ) => {
    const at = Number(((y - LANE_TOP) / LANE_HEIGHT).toFixed(4));
    return edge({
      id,
      source,
      target,
      value,
      // A reply is drawn dashed, which is what tells a reader it is a return rather than a call.
      style:
        `html=1;verticalAlign=bottom;endArrow=block;rounded=0;${dashed ? "dashed=1;" : ""}` +
        anchors({ x: 0.5, y: at }, { x: 0.5, y: at }),
    });
  };

  return model([
    lifeline("l1", label("diagrams.tpl.seq.user")),
    lifeline("l2", label("diagrams.tpl.seq.app")),
    lifeline("l3", label("diagrams.tpl.seq.service")),
    message("m1", "l1", "l2", label("diagrams.tpl.seq.request"), 150),
    message("m2", "l2", "l3", label("diagrams.tpl.seq.query"), 220),
    message("m3", "l3", "l2", label("diagrams.tpl.seq.result"), 290, true),
    message("m4", "l2", "l1", label("diagrams.tpl.seq.response"), 360, true),
  ]);
}

/** Two tables and the relation between them, as swimlanes with a row per column. */
function entityRelationship(): string {
  const table = (id: string, name: string, x: number, rows: string[]) => {
    const cells = [
      vertex({
        id,
        value: name,
        style:
          "swimlane;fontStyle=1;childLayout=stackLayout;horizontal=1;startSize=30;" +
          "horizontalStack=0;resizeParent=1;resizeParentMax=0;resizeLast=0;collapsible=1;" +
          `marginBottom=0;whiteSpace=wrap;html=1;fillColor=${BLUE};strokeColor=${BLUE_LINE};`,
        x,
        y: 60,
        width: 200,
        height: 30 + rows.length * 26,
      }),
    ];
    rows.forEach((row, index) => {
      cells.push(
        vertex({
          id: `${id}_r${index}`,
          value: row,
          style: "text;strokeColor=none;fillColor=none;align=left;spacingLeft=6;html=1;",
          x: 0,
          y: 30 + index * 26,
          width: 200,
          height: 26,
          parent: id,
        }),
      );
    });
    return cells;
  };

  return model([
    ...table("t1", label("diagrams.tpl.er.customer"), 120, [
      label("diagrams.tpl.er.colId"),
      label("diagrams.tpl.er.colName"),
      label("diagrams.tpl.er.colEmail"),
    ]),
    ...table("t2", label("diagrams.tpl.er.order"), 520, [
      label("diagrams.tpl.er.colId"),
      label("diagrams.tpl.er.colCustomer"),
      label("diagrams.tpl.er.colTotal"),
    ]),
    edge({
      id: "r1",
      source: "t1",
      target: "t2",
      value: label("diagrams.tpl.er.relation"),
      style: "edgeStyle=entityRelationEdgeStyle;html=1;endArrow=ERoneToMany;startArrow=ERone;",
    }),
  ]);
}

/** Internet, a balancer, two application hosts and the store behind them. */
function network(): string {
  return model([
    vertex({
      id: "net",
      value: label("diagrams.tpl.net.internet"),
      style: `ellipse;shape=cloud;whiteSpace=wrap;html=1;fillColor=${GREY};strokeColor=${GREY_LINE};`,
      x: 80,
      y: 160,
      width: 160,
      height: 100,
    }),
    vertex({
      id: "lb",
      value: label("diagrams.tpl.net.balancer"),
      style: box(AMBER, AMBER_LINE),
      x: 320,
      y: 185,
      width: 150,
      height: 60,
    }),
    vertex({
      id: "a1",
      value: `${label("diagrams.tpl.net.app")} 1`,
      style: box(BLUE, BLUE_LINE),
      x: 550,
      y: 110,
      width: 150,
      height: 60,
    }),
    vertex({
      id: "a2",
      value: `${label("diagrams.tpl.net.app")} 2`,
      style: box(BLUE, BLUE_LINE),
      x: 550,
      y: 260,
      width: 150,
      height: 60,
    }),
    vertex({
      id: "db",
      value: label("diagrams.tpl.net.db"),
      style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;fillColor=${PURPLE};strokeColor=${PURPLE_LINE};`,
      x: 790,
      y: 175,
      width: 130,
      height: 90,
    }),
    edge({ id: "n1", source: "net", target: "lb" }),
    // Side-to-side anchors on the fan-out and the fan-in. Without them the router leaves the
    // balancer's right edge and climbs *between* the two app servers to reach each one, and the two
    // paths overlap into what looks like a double-headed arrow joining the servers to each other —
    // a line that says something the diagram does not mean.
    edge({ id: "n2", source: "lb", target: "a1", style: FAN }),
    edge({ id: "n3", source: "lb", target: "a2", style: FAN }),
    edge({ id: "n4", source: "a1", target: "db", style: FAN }),
    edge({ id: "n5", source: "a2", target: "db", style: FAN }),
  ]);
}

/**
 * A schema, in DBML rather than in mxGraph.
 *
 * The one shipped template that is not a drawing, and the reason the list below carries a `format`
 * at all. Two tables and the key between them: enough that opening it teaches the syntax — a column
 * with settings, an inline reference, a default expression — without arriving as a finished model
 * nobody wants to edit.
 *
 * **The identifiers are not translated**, unlike every other template's labels, and that is the
 * distinction rather than an oversight: a drawing's boxes are *prose* — words a reader reads — while
 * these are column names in a database, which are code. The card's name and description in the
 * picker are translated, because those are what somebody chooses between.
 */
function schema(): string {
  return [
    "Table authors {",
    "  id         integer      [pk, increment]",
    "  name       varchar(120) [not null]",
    "  email      varchar(160) [not null, unique]",
    "  created_at timestamp    [default: `now()`]",
    "}",
    "",
    "Table posts {",
    "  id        integer      [pk, increment]",
    "  author_id integer      [not null, ref: > authors.id]",
    "  title     varchar(200) [not null]",
    "  body      text",
    "  published boolean      [not null, default: false]",
    "}",
    "",
  ].join("\n");
}

/** `as const` so the ids are literal types — see `lib/notes/templates.ts` for the same trick. */
const BUILT_INS = [
  { id: "flow", icon: "workflow", tags: ["flujo"], build: flowchart },
  { id: "c4", icon: "layers", tags: ["arquitectura", "c4"], build: c4Containers },
  { id: "seq", icon: "list-ordered", tags: ["uml", "secuencia"], build: sequence },
  { id: "er", icon: "database", tags: ["er", "datos"], build: entityRelationship },
  { id: "net", icon: "network", tags: ["red", "infra"], build: network },
  { id: "dbml", icon: "database", tags: ["dbml", "datos"], build: schema, format: FORMAT_DBML },
] as const satisfies readonly {
  id: string;
  icon: string;
  tags: readonly string[];
  build: () => string;
  /** The dialect the document is written in. Absent means the drawing one. */
  format?: DiagramFormat;
}[];

/**
 * The shipped templates, translated — the shape `diagramsStore`'s one-time seed writes into the
 * database. Not memoised: it runs once per workspace, ever, so a cache would risk seeding a stale
 * language for nothing.
 */
export function builtInTemplates(): DiagramTemplate[] {
  return BUILT_INS.map((entry) => ({
    id: `builtin:${entry.id}`,
    workspace_id: "",
    name: translate(`diagrams.tpl.${entry.id}.name` satisfies TranslationKey),
    description: translate(`diagrams.tpl.${entry.id}.desc` satisfies TranslationKey),
    icon: entry.icon,
    doc: entry.build(),
    format: "format" in entry ? entry.format : DEFAULT_FORMAT,
    tags: [...entry.tags],
    sort_order: -1,
    created_at: "",
    updated_at: "",
  }));
}

/** A stored row as the UI holds it — the one place a template's `tags` stops being JSON. */
export function toTemplate(row: DiagramTemplateRow): DiagramTemplate {
  return { ...row, tags: parseTags(row.tags) };
}
