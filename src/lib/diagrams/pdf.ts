import type { TVirtualFileSystem } from "pdfmake/interfaces";

/**
 * A drawing as a PDF, built here from the picture the editor draws.
 *
 * **Why this exists at all:** the bundled draw.io's embed `export` has no PDF branch. Asked for
 * `format: "pdf"` it falls through to `getSvg` and answers with an SVG, which this app used to write
 * under a `.pdf` name — a file every PDF reader refuses. So the PDF is made on this side.
 *
 * **Why from the PNG and not the SVG.** draw.io writes every HTML label (the default for most
 * shapes) as a `<foreignObject>`, and the SVG renderer behind pdfmake (svg-to-pdfkit) has no idea
 * what that is: the boxes arrive, the words in them do not. The PNG comes from the editor's own
 * canvas renderer, which draws exactly what is on screen, labels included. The price is a raster
 * page rather than vectors — at the dialog's default 200 % it prints sharply.
 *
 * **The page is the drawing.** A PNG exported at `scale` is `scale` times the drawing's size in
 * CSS pixels, and a CSS pixel is ¾ of a PDF point, so the page is `width / scale × 0.75` points
 * wide — the drawing at its own size, printable, with every one of the PNG's pixels still in it.
 * pdfmake is ~2 MB and is loaded by `import()` only when a PDF is asked for.
 */

/** The largest page a PDF reader is required to open (Acrobat's limit: 200 inches). */
const MAX_PAGE_POINTS = 14_400;

/** A CSS pixel in PDF points. */
const POINTS_PER_PIXEL = 0.75;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The pixel size a PNG declares in its `IHDR`, or `null` when these are not a PNG's bytes. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || PNG_SIGNATURE.some((byte, at) => png[at] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  // Bytes 12..16 name the first chunk, which the format requires to be IHDR.
  if (String.fromCharCode(png[12], png[13], png[14], png[15]) !== "IHDR") return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The page a PNG exported at `scale` prints on, in points — the drawing at its own size, shrunk
 *  only when it is larger than a PDF page may be. */
export function pageFor(size: { width: number; height: number }, scale: number): { width: number; height: number } {
  const factor = POINTS_PER_PIXEL / (scale > 0 ? scale : 1);
  let width = size.width * factor;
  let height = size.height * factor;
  const over = Math.max(width / MAX_PAGE_POINTS, height / MAX_PAGE_POINTS, 1);
  width /= over;
  height /= over;
  return { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  // In slices: `String.fromCharCode(...bytes)` over a few megabytes overflows the call stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

/** A one-page PDF holding the PNG, the page sized to the drawing. Throws when `png` is not one. */
export async function pngToPdf(png: Uint8Array, scale: number): Promise<Uint8Array> {
  const size = pngSize(png);
  if (!size) throw new Error("The editor did not return a PNG to build the PDF from.");
  const page = pageFor(size, scale);

  const [core, vfs] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  type Core = typeof core;
  const unwrap = <T,>(mod: unknown): T => (mod as { default?: T }).default ?? (mod as T);
  const pdfMake = unwrap<Core>(core);
  pdfMake.addVirtualFileSystem(unwrap<TVirtualFileSystem>(vfs));

  const base64 = await pdfMake
    .createPdf({
      pageSize: page,
      pageMargins: [0, 0, 0, 0],
      info: { creator: "CodeFlow" },
      content: [{ image: `data:image/png;base64,${base64Of(png)}`, width: page.width, height: page.height }],
    })
    .getBase64();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/**
 * An SVG made fit for a vector PDF.
 *
 * The SVG renderer behind pdfmake draws shapes, paths and `<text>`, and nothing of a
 * `<foreignObject>` — which is where draw.io puts an HTML label. draw.io pairs each one with a
 * `<text>` fallback inside a `<switch>` (what a viewer without HTML draws), so the HTML is dropped
 * and the fallback kept; a `<foreignObject>` with no fallback is replaced by its words as a `<text>`
 * at its centre. The "Text is not SVG — cannot display" notice draw.io appends for old viewers goes
 * too: it is exactly the viewer this makes the SVG not need.
 */
export function svgForPdf(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.nodeName.toLowerCase() !== "svg") throw new Error("The editor did not return an SVG to build the PDF from.");
  for (const link of Array.from(root.getElementsByTagName("a"))) {
    if ((link.textContent ?? "").includes("Text is not SVG")) link.parentNode?.removeChild(link);
  }
  for (const foreign of Array.from(root.getElementsByTagName("foreignObject"))) {
    const parent = foreign.parentNode as Element | null;
    const fallback = parent?.nodeName.toLowerCase() === "switch" && Array.from(parent.childNodes).some((n) => n !== foreign && n.nodeName.toLowerCase() === "text");
    if (!fallback) {
      const x = Number(foreign.getAttribute("x") ?? 0) + Number(foreign.getAttribute("width") ?? 0) / 2;
      const y = Number(foreign.getAttribute("y") ?? 0) + Number(foreign.getAttribute("height") ?? 0) / 2;
      const words = (foreign.textContent ?? "").replace(/\s+/g, " ").trim();
      if (words) {
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", String(x));
        text.setAttribute("y", String(y));
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "middle");
        text.setAttribute("font-family", "Helvetica");
        text.setAttribute("font-size", "12");
        text.textContent = words;
        parent?.insertBefore(text, foreign);
      }
    }
    parent?.removeChild(foreign);
  }
  return new XMLSerializer().serializeToString(document);
}

/** The drawing's size in CSS pixels, from the SVG's own width and height or its viewBox. */
function svgSize(svg: string): { width: number; height: number } {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const number = (value: string | null) => (value ? parseFloat(value) : NaN);
  let width = number(root.getAttribute("width"));
  let height = number(root.getAttribute("height"));
  const box = (root.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  if ((!(width > 0) || !(height > 0)) && box.length === 4) [width, height] = [box[2], box[3]];
  if (!(width > 0) || !(height > 0)) throw new Error("The SVG does not say how big it is.");
  return { width, height };
}

/**
 * A one-page PDF of the SVG as vectors — lines that stay sharp at any zoom and text that can be
 * selected and searched — the page sized to the drawing, like `pngToPdf`'s.
 */
export async function svgToPdf(svg: string): Promise<Uint8Array> {
  const clean = svgForPdf(svg);
  const page = pageFor(svgSize(clean), 1);
  const [core, vfs] = await Promise.all([import("pdfmake/build/pdfmake"), import("pdfmake/build/vfs_fonts")]);
  type Core = typeof core;
  const unwrap = <T,>(mod: unknown): T => (mod as { default?: T }).default ?? (mod as T);
  const pdfMake = unwrap<Core>(core);
  pdfMake.addVirtualFileSystem(unwrap<TVirtualFileSystem>(vfs));
  const base64 = await pdfMake
    .createPdf({
      pageSize: page,
      pageMargins: [0, 0, 0, 0],
      info: { creator: "CodeFlow" },
      content: [{ svg: clean, width: page.width, height: page.height }],
    })
    .getBase64();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
