import type { DiagramFormat } from "../../types/diagrams";

/**
 * What a diagram's document *is*, as far as the app outside the editor is concerned.
 *
 * Almost nothing: a string, and a `format` naming the dialect it is written in. That is the whole
 * contract, and keeping it this small is the point — the choice of editor is then a decision in one
 * place instead of a shape baked into the store, the tree, the gallery and every query.
 *
 * There are two dialects. mxGraph XML, which the embedded draw.io reads and writes, and DBML — a
 * database schema as text, which `DbmlWorkbench` edits. Adding the second one changed this file and
 * added an editor, and nothing else: the store, the tree, the gallery, the backup and every query
 * still carry a string and a name for it.
 */

/** The dialect an embedded draw.io reads and writes. Mirrors `FORMAT_MXGRAPH` in Rust. */
export const FORMAT_MXGRAPH: DiagramFormat = "mxgraph";

/**
 * The dialect the schema workbench reads and writes: DBML, plus a trailing comment carrying the
 * boxes the user has dragged. Mirrors `FORMAT_DBML` in Rust. See `lib/dbml/layout.ts`.
 */
export const FORMAT_DBML: DiagramFormat = "dbml";

/** The format a new diagram is created in when nothing says otherwise — the drawing one. */
export const DEFAULT_FORMAT = FORMAT_MXGRAPH;

/**
 * An empty mxGraph document.
 *
 * The two cells are not optional decoration: mxGraph's model requires cell `0` as the model root
 * and cell `1` as the default layer that every drawn shape parents to. A document without them
 * loads as a broken graph rather than as an empty one, so a "blank diagram" has to be *this* blank
 * rather than an empty string.
 *
 * Written here rather than left for the editor to produce on first open, because a diagram created
 * from the gallery in a workspace whose editor has never been mounted still has to be a real
 * document — it can be duplicated, exported and counted before anyone opens it.
 */
export const EMPTY_MXGRAPH_DOC =
  '<mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" ' +
  'arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" ' +
  'shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" /></root></mxGraphModel>';

/**
 * The blank document for a format.
 *
 * mxGraph needs its two skeleton cells to be a *graph* at all; DBML's blank is genuinely the empty
 * string, and the canvas says so in words rather than showing an empty grid. An unknown format gets
 * the empty string too — a document this app cannot write is one it should not invent.
 */
export function emptyDoc(format: DiagramFormat = DEFAULT_FORMAT): string {
  return format === FORMAT_MXGRAPH ? EMPTY_MXGRAPH_DOC : "";
}

/** Whether a diagram's document is a schema rather than a drawing. The one branch on `format`. */
export function isSchemaFormat(format: DiagramFormat): boolean {
  return format === FORMAT_DBML;
}
