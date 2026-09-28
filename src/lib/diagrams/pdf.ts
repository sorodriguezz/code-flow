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
