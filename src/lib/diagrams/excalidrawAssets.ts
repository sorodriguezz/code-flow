declare global {
  interface Window {
    /** Where Excalidraw loads its fonts from — see `excalidrawFonts` in `vite.config.ts`. */
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/** The CDN Excalidraw appends to every face as a last resort — `ASSETS_FALLBACK_URL` in the package. */
const CDN_SOURCE = /url\(\s*["']?https:\/\/esm\.sh\/@excalidraw\/[^)]*\)\s*(?:format\([^)]*\))?/g;

/**
 * Points Excalidraw at the fonts this app serves itself, and takes the CDN out of their sources.
 *
 * **Call it before the package is imported, not from a module that imports it** — `DiagramsView`'s
 * lazy loader and the AI panel's do. Excalidraw works out each face's addresses when it registers
 * them, which can be while the package itself is being evaluated, and a module's imports are
 * evaluated before its own body.
 *
 * **The CDN goes because the policy refuses it anyway.** Every face Excalidraw builds lists this
 * app's copy first and esm.sh after it, and the app's policy allows fonts from itself only
 * (`font-src 'self'`). The browser checks the whole list when a face is registered, so opening a
 * whiteboard printed some two hundred and thirty refused loads to the console — none of which
 * reached the network or changed what was drawn, and all of which buried anything real. A face
 * keeps its own source either way; only the one the policy would block is removed. The constructor
 * is wrapped narrowly: a source list that names no Excalidraw CDN passes through untouched.
 */
export function pointExcalidrawAtBundledFonts(): void {
  window.EXCALIDRAW_ASSET_PATH = "/excalidraw/";
  if ((window.FontFace as { cfWithoutCdn?: true }).cfWithoutCdn) return;
  const Native = window.FontFace;
  class FontFaceWithoutCdn extends Native {
    static cfWithoutCdn = true as const;
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      if (typeof source === "string" && source.includes("esm.sh/@excalidraw/")) {
        const local = source
          .replace(CDN_SOURCE, "")
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .join(", ");
        super(family, local || source, descriptors);
      } else {
        super(family, source, descriptors);
      }
    }
  }
  window.FontFace = FontFaceWithoutCdn;
}
