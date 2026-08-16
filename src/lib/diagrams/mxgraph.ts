/**
 * Building mxGraph documents by hand.
 *
 * Only the shipped templates need this — everything else in the app treats a document as opaque
 * text (see `doc.ts`), and that rule is worth keeping. What is here is the smallest thing that can
 * write a *correct* document: cells, geometry, and above all escaping.
 *
 * **Escaping is the reason this is a builder rather than template literals.** A cell's label is
 * translated text, and the day someone writes a template called "Entrada & salida" or a Spanish
 * label with `<` in it, a hand-concatenated document stops parsing — and mxGraph's failure mode for
 * a malformed document is a blank canvas, not an error. One `escapeXml` at the one place a label
 * enters the markup is the difference.
 */

/** The five characters that cannot appear raw in XML text or in a double-quoted attribute. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface VertexSpec {
  id: string;
  value?: string;
  /** An mxGraph style string. Not escaped as a label is — it is markup-free by construction, and
   *  every one of them in this app is a literal written beside its shape. */
  style: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The cell this one lives inside. Defaults to the layer, which is what a top-level shape wants. */
  parent?: string;
}

export interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  value?: string;
  style?: string;
  parent?: string;
}

/**
 * Where an edge meets its shapes, as fractions of the shape's box.
 *
 * **This, and not `mxPoint` waypoints, is how an attachment point is chosen.** mxGraph reads
 * `sourcePoint`/`targetPoint` only for an end that is *dangling*; the moment `source` and `target`
 * name cells, the cells' perimeters decide and the points are ignored. Learned by writing the
 * sequence template the other way first and watching all four of its messages stack into one line.
 */
export function anchors(exit: { x: number; y: number }, entry: { x: number; y: number }): string {
  return (
    `exitX=${exit.x};exitY=${exit.y};exitDx=0;exitDy=0;` +
    `entryX=${entry.x};entryY=${entry.y};entryDx=0;entryDy=0;`
  );
}

/** The default layer every shape parents to. Cell `1` — see `doc.ts` for why `0` and `1` exist. */
const LAYER = "1";

const DEFAULT_EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;";

export function vertex(spec: VertexSpec): string {
  const value = escapeXml(spec.value ?? "");
  return (
    `<mxCell id="${spec.id}" value="${value}" style="${spec.style}" vertex="1" ` +
    `parent="${spec.parent ?? LAYER}">` +
    `<mxGeometry x="${spec.x}" y="${spec.y}" width="${spec.width}" height="${spec.height}" ` +
    `as="geometry" /></mxCell>`
  );
}

export function edge(spec: EdgeSpec): string {
  const value = escapeXml(spec.value ?? "");
  return (
    `<mxCell id="${spec.id}" value="${value}" style="${spec.style ?? DEFAULT_EDGE_STYLE}" ` +
    `edge="1" parent="${spec.parent ?? LAYER}" source="${spec.source}" target="${spec.target}">` +
    `<mxGeometry relative="1" as="geometry" /></mxCell>`
  );
}

/**
 * Wraps cells in the document envelope.
 *
 * The attributes are draw.io's own defaults for a new file, kept verbatim rather than trimmed: they
 * are what the editor writes back on the first save anyway, and a document that differs from one
 * the editor would have produced is a document whose first autosave looks like an edit nobody made.
 */
export function model(cells: string[]): string {
  return (
    `<mxGraphModel dx="1100" dy="700" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" ` +
    `arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" ` +
    `shadow="0"><root><mxCell id="0" /><mxCell id="1" parent="0" />${cells.join("")}` +
    `</root></mxGraphModel>`
  );
}

/**
 * `base` with `addition`'s shapes appended to it.
 *
 * **This exists because draw.io's `merge` action does not do what its name says.** Sending
 * `{ action: "merge", xml }` to the embedded editor does not add the cells to the open drawing: it
 * merges at the *file* level, and the incoming model arrives as a **second page**. With the
 * page-tab strip hidden — see `editorConfig` — that page cannot be reached at all, so a generated
 * diagram looked like a button that did nothing. Verified against the vendored build.
 *
 * So the combining happens here and the result is sent as a plain `load`. Cells `0` and `1` are
 * skipped: they are the model root and the default layer, which the base already has.
 *
 * Parsed rather than spliced as strings — a regex over `<root>` would be shorter and would break on
 * the first label containing `</root>` as text. `XMLSerializer` also re-escapes on the way out, so
 * a document that survives this round trip is one mxGraph can read.
 */
export function appendCells(base: string, addition: string): string {
  const parser = new DOMParser();
  const target = parser.parseFromString(base, "text/xml");
  const source = parser.parseFromString(addition, "text/xml");
  const root = target.querySelector("root");
  // A base this cannot read is a base this must not silently empty. Returning the addition alone
  // would replace the user's drawing; returning the base loses only the generation, which is the
  // recoverable half.
  if (!root || target.querySelector("parsererror") || source.querySelector("parsererror")) {
    return base;
  }
  for (const cell of Array.from(source.querySelectorAll("root > *"))) {
    const id = cell.getAttribute("id");
    if (id === "0" || id === "1") continue;
    root.appendChild(target.importNode(cell, true));
  }
  return new XMLSerializer().serializeToString(target.documentElement);
}
