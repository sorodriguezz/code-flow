import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pageFor, pngSize, pngToPdf } from "./pdf";
import { DEFAULT_EXPORT_OPTIONS, exportMessage, supportsOption } from "./exportOptions";

/**
 * draw.io's "Export PDF" wrote an SVG under a `.pdf` name — the embedded editor has no PDF branch.
 * These hold the replacement down: the editor is asked for a PNG, and the file written is a real
 * PDF whose page is the drawing's size.
 */

/** A real, decodable PNG: `width`×`height`, white, RGB. pdfmake decodes the image to embed it, so a
 *  signature and a header alone would not do. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolour, deflate, no filter method, no interlace
  const raw = new Uint8Array(height * (1 + width * 3)).fill(255);
  for (let row = 0; row < height; row++) raw[row * (1 + width * 3)] = 0; // filter byte: none
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("the PDF export", () => {
  it("asks the editor for the PNG a PNG export would give, options and all", () => {
    const options = { ...DEFAULT_EXPORT_OPTIONS, zoom: 300, grid: true };
    expect(exportMessage("pdf", options)).toEqual(exportMessage("png", options));
    expect(exportMessage("pdf", options)).toMatchObject({ format: "png", scale: 3, grid: true });
    expect(supportsOption("pdf", "grid")).toBe(true);
    expect(supportsOption("pdf", "size")).toBe(true);
    expect(supportsOption("pdf", "appearance")).toBe(false);
    expect(supportsOption("svg", "appearance")).toBe(true);
  });

  it("reads a PNG's size and refuses what is not one", () => {
    expect(pngSize(png(40, 20))).toEqual({ width: 40, height: 20 });
    expect(pngSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("sizes the page to the drawing at its own size, and within what a reader opens", () => {
    // 400×200 px at 200 % is a 200×100 px drawing: 150×75 pt.
    expect(pageFor({ width: 400, height: 200 }, 2)).toEqual({ width: 150, height: 75 });
    const huge = pageFor({ width: 40_000, height: 1_000 }, 1);
    expect(huge.width).toBeLessThanOrEqual(14_400);
    expect(huge.width / huge.height).toBeCloseTo(40, 0);
  });

  it("writes bytes that are a PDF, one page, the drawing's size", async () => {
    const bytes = await pngToPdf(png(400, 200), 2);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toMatch(/\/MediaBox \[0 0 150 75\]/);
    expect(text).toMatch(/\/Count 1\b/);
    expect(text).toMatch(/\/Subtype \/Image/);
  });

  it("refuses to wrap an SVG, which is what the editor used to hand back", async () => {
    await expect(pngToPdf(new TextEncoder().encode("<svg/>"), 1)).rejects.toThrow();
  });
});
