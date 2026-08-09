/**
 * `@types/pdfmake` ships declarations for `build/pdfmake` and `build/vfs_fonts` but not for the
 * `build/standard-fonts/*` modules, which are what `docsPdf.ts` uses to get a monospace face.
 *
 * Those files are font *containers*: an AFM metrics table for one of the PDF base-14 fonts plus the
 * `fonts` entry that names it. Nothing is embedded in the output — every reader already has Courier
 * — so the whole cost is the metrics, which is why this is worth a declaration rather than
 * shipping a TTF.
 */
declare module "pdfmake/build/standard-fonts/Courier" {
  import type { TFontContainer } from "pdfmake/interfaces";
  const fontContainer: TFontContainer;
  export = fontContainer;
}
