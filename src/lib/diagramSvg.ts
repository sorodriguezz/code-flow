import type { DiagramLayout, DiagramNode } from "./db/erLayout";

/**
 * Drawing an entity-relationship diagram as SVG, and getting it back out as a file.
 *
 * Both halves of this app that draw a schema use it: the Database workspace's live-catalogue panel
 * and the Diagrams workspace's DBML canvas. They render different things — one a database as it is,
 * the other a document being typed — but the *geometry* of a box-and-key diagram, and what it takes
 * to turn one into a PNG somebody can paste into a ticket, are the same problem twice.
 *
 * It lived inside `db/DiagramPanel.tsx` until there was a second caller. Nothing here changed on the
 * way out except `standaloneSvg` taking the id of the group to un-pan, which used to be a literal.
 */

/**
 * The line between two tables, anchored on the columns the key is actually made of.
 *
 * Anchoring on the *column row* rather than the box is what makes a composite key readable: two
 * lines between the same pair of tables leave from two different rows and arrive at two different
 * rows, instead of overlapping into one thick line that says nothing about which column is which.
 *
 * A cubic with horizontal control points, so the curve leaves and arrives perpendicular to the box
 * edge — an arrow that meets a box at a slant reads as pointing past it.
 */
export function edgePath(
  from: DiagramNode,
  to: DiagramNode,
  fromColumn: string,
  toColumn: string,
): string {
  const { x1, y1, x2, y2, c1, c2 } = edgeEnds(from, to, fromColumn, toColumn);
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}

/** Where that curve starts and ends, for a canvas that wants to mark its endpoints. */
export interface EdgeEnds {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** The horizontal control points, so the caller draws the same curve `edgePath` writes. */
  c1: number;
  c2: number;
}

/**
 * The geometry behind `edgePath`, on its own.
 *
 * Split out so the DBML canvas can put a dot on each end of the line without recomputing — and,
 * more to the point, without recomputing it *slightly differently*: a dot half a pixel off the end
 * of its own curve is the kind of thing nobody can name and everybody can see.
 */
export function edgeEnds(
  from: DiagramNode,
  to: DiagramNode,
  fromColumn: string,
  toColumn: string,
): EdgeEnds {
  const y1 = from.y + (from.rowY[fromColumn] ?? from.height / 2);
  const y2 = to.y + (to.rowY[toColumn] ?? to.height / 2);

  if (from.id === to.id) {
    // A self-reference (`employee.manager_id → employee`) loops out of the right edge and back.
    const x = from.x + from.width;
    return { x1: x, y1, x2: x, y2, c1: x + 46, c2: x + 46 };
  }

  const fromRight = from.x + from.width / 2 <= to.x + to.width / 2;
  const x1 = fromRight ? from.x + from.width : from.x;
  const x2 = fromRight ? to.x : to.x + to.width;
  const reach = Math.max(30, Math.abs(x2 - x1) * 0.45);
  return {
    x1,
    y1,
    x2,
    y2,
    c1: fromRight ? x1 + reach : x1 - reach,
    c2: fromRight ? x2 - reach : x2 + reach,
  };
}

/**
 * Truncates to what fits `width` pixels.
 *
 * `advance` is the width of one character at the size and face the caller is drawing in — 5.9 is
 * the app's sans at the 10–11px the boxes use, and it is the default only because that is what
 * every caller wanted before there was a canvas setting its rows in a monospace. Guessing it wrong
 * is not cosmetic: too small and the "truncated" label overruns the box it was truncated to fit.
 */
export function clip(text: string, width: number, advance = 5.9): string {
  const max = Math.max(3, Math.floor(width / advance));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The rendered diagram as a file that opens anywhere.
 *
 * The screen's SVG is themed with CSS custom properties, which mean nothing outside this window —
 * an export that kept them would open as black text on a black background, or as nothing at all. So
 * every `var(--cf-…)` is resolved against the live theme on the way out, and the viewBox is set to
 * the whole diagram rather than to the current pan, because a saved picture should be the schema,
 * not the part of it that happened to be scrolled into view.
 */
export function standaloneSvg(
  source: SVGSVGElement,
  layout: DiagramLayout,
  canvasId: string,
): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const styles = getComputedStyle(document.documentElement);
  const resolve = (value: string) =>
    value.replace(/var\((--[a-z0-9-]+)\)/gi, (_match, name: string) =>
      (styles.getPropertyValue(name) || "#888").trim(),
    );

  for (const element of clone.querySelectorAll("*")) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.value.includes("var(--")) {
        element.setAttribute(attribute.name, resolve(attribute.value));
      }
    }
  }

  // Undo the pan/zoom: the file is the whole diagram at 1:1.
  clone.querySelector(`#${canvasId}`)?.setAttribute("transform", "translate(0 0)");
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // On screen the text inherits its face from the page. Detached from the page it would fall back to
  // whatever the viewer calls default — usually a serif, always wider than the boxes were measured
  // for, so names that fit here would overrun there. Named explicitly, and the raster export goes
  // through the same string, so the PNG matches the SVG.
  clone.setAttribute("font-family", getComputedStyle(source).fontFamily || "system-ui, sans-serif");
  clone.setAttribute("width", String(Math.ceil(layout.width)));
  clone.setAttribute("height", String(Math.ceil(layout.height)));
  clone.setAttribute("viewBox", `0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}`);
  clone.removeAttribute("class");

  // An opaque background, prepended so it sits behind everything: an SVG with a transparent ground
  // opens as dark-on-dark in any viewer whose own page is dark.
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", resolve("var(--cf-bg)"));
  clone.insertBefore(background, clone.firstChild);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
}

/** Above this many pixels a canvas stops being allocated and starts returning a blank one, which
 * would save a transparent rectangle where the schema should be. */
const MAX_RASTER_PIXELS = 24e6;
const MAX_RASTER_EDGE = 8192;

/**
 * The same picture as pixels, Base64-encoded and ready for `apiSaveBinaryFile`.
 *
 * Drawn at 2× so it stays sharp in a document or a ticket, but scaled back down for a schema large
 * enough to hit a canvas limit — a smaller PNG is worth having and a blank one is not. Routed
 * through the *standalone* SVG rather than the live one on purpose: every `var(--cf-…)` has already
 * been resolved there, and an image element gets no stylesheet to resolve them against, so
 * rasterising what is on screen would produce a picture drawn entirely in the fallback grey.
 */
export function rasterize(
  svgText: string,
  layout: DiagramLayout,
  maxScale = 2,
): Promise<string> {
  const scale = Math.min(
    maxScale,
    MAX_RASTER_EDGE / Math.max(layout.width, layout.height),
    Math.sqrt(MAX_RASTER_PIXELS / (layout.width * layout.height)),
  );

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(layout.width * scale));
      canvas.height = Math.max(1, Math.ceil(layout.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("no 2d context"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      // `toDataURL` hands back `data:image/png;base64,…`; the command wants the payload alone.
      const encoded = canvas.toDataURL("image/png").split(",")[1];
      if (encoded) resolve(encoded);
      else reject(new Error("empty raster"));
    };
    image.onerror = () => reject(new Error("the diagram could not be rasterised"));
    image.src = svgDataUri(svgText);
  });
}

/** Base64 rather than percent-encoding, because a schema is full of characters — the `↗` on an
 * external stub, an accented column name — that a URI-encoded `data:` payload gets wrong often
 * enough to matter. Chunked, since spreading a megabyte of bytes into one call overflows the stack. */
export function svgDataUri(svgText: string): string {
  const bytes = new TextEncoder().encode(svgText);
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}
