import type { EmbedAction } from "./embed";
import type { ExportFormat } from "./exportFile";

/**
 * What the user gets to decide about a picture of a diagram, and how that becomes a message.
 *
 * # Why this is not in `exportFile.ts`
 *
 * That module's job starts once the bytes exist: it asks where they go and writes them. This one
 * runs before any of that, and its whole subject is the *request* — what the editor is asked to
 * draw. Keeping them apart is what stops the file-dialog module from growing a dependency on the
 * embed protocol, which is the one thing about draw.io that changes when the vendored build is
 * bumped.
 *
 * # Why these options and not the ones draw.io's own dialog shows
 *
 * The native "Image" dialog belongs to `EditorUi`, which runs *inside* the iframe and writes the
 * file through the browser. Nothing reachable from `postMessage` shares its code. The only surface
 * this app has is the `"export"` handler, and the list below is that handler read line by line in
 * `public/drawio/js/app.min.js` — offering anything else would be a control the user can move and
 * the file cannot notice.
 *
 * The handler forks once, on `"png" == format`:
 *
 * - **PNG** goes to `Editor.prototype.exportToCanvas(cb, width, null, background, err, null, null,
 *   scale, transparent, shadow, null, graph, border, null, grid, keepThemeTheme, size)`.
 * - **Everything else** — `svg`, and `pdf`, which has no branch of its own — goes to
 *   `graph.getSvg(bg, scale, border, null, null, null, null, imgExport, null,
 *   graph.shadowVisible || shadow, null, theme)`. Twelve arguments, where `getSvg` takes
 *   seventeen: `size` is the thirteenth and `grid` has no parameter there at all.
 *
 * That fork is the entire matrix. Grid and size are PNG because only the canvas path can express
 * them; appearance is SVG and PDF because only `getSvg` is handed a theme (the canvas path derives
 * one from `keepTheme`, which is a different question — "match the app" rather than "be light").
 *
 * # Why there is no DPI, and no "selection"
 *
 * **DPI** is the one the screenshot of draw.io's dialog makes people ask for. The handler never
 * reads a `dpi` key, in either branch. The `pHYs` chunk that carries it is written by
 * `EditorUi.createImageDataUri`, on draw.io's own download path — code this app never reaches,
 * because it exports by asking the frame and saving the answer itself. A DPI field here would spin
 * and produce identical files, which is worse than not offering it: the user would go looking for
 * what else they got wrong.
 *
 * **Selection** as a size is missing for the opposite reason — it would not fail, it would lie.
 * `getSvg` only consults the selection when its `ignoreSelection` argument is false, and both
 * branches leave that argument null, which the function defaults to *true*. So `size: "selection"`
 * would quietly come back as the whole drawing. (A modal living outside the iframe could not know
 * whether anything is selected anyway.)
 */

/** The formats that produce a picture, which is to say every one but `.drawio`. */
export type ImageExportFormat = Exclude<ExportFormat, "drawio">;

/** The choices the export dialog collects. */
export interface ImageExportOptions {
  /** Per cent, exactly as it is typed — 100 is the diagram at its own size. Divided by 100 on the
   *  way out, because the protocol's `scale` is a factor and a field labelled "2" would be read as
   *  200 % by everyone who has used any other export dialog. */
  zoom: number;
  /** Empty space around the drawing, in points. */
  border: number;
  transparent: boolean;
  shadow: boolean;
  grid: boolean;
  size: "diagram" | "page";
  /** `"auto"` means "send no theme", which leaves the editor's own `"auto"` in place — the SVG
   *  adapts to whoever opens it. The other two pin it. */
  appearance: "auto" | "light" | "dark";
}

/**
 * What the dialog starts from, and what "restore defaults" goes back to.
 *
 * **Zoom is 200 and not 100 on purpose.** Two hundred per cent is precisely what the hard-coded
 * `scale: 2` in `DrawioFrame` sent before this dialog existed, so anyone who opens the dialog,
 * reads it and presses Export gets the PNG they got yesterday. A default of 100 would have made
 * this feature quietly halve everyone's exports, and would have made `tour.diagrams.export.body`
 * ("at twice the resolution", in both languages) false the day it shipped.
 *
 * Two defaults are *not* what the old code sent, and both are deliberate. Transparency is `false`
 * for all three formats, where SVG used to be hard-coded transparent — see `exportMessage`. And
 * `size: "diagram"` is sent where nothing used to be, which on a diagram carrying a background
 * image widens the PNG to include it; see the `size` note in `embed.ts`.
 */
export const DEFAULT_EXPORT_OPTIONS: ImageExportOptions = {
  zoom: 200,
  border: 0,
  transparent: false,
  shadow: false,
  grid: false,
  size: "diagram",
  appearance: "auto",
};

export type ExportOptionKey = keyof ImageExportOptions;

/**
 * The one-way channel between the menu that asks for an export and the frame that performs it.
 *
 * A discriminated union rather than two fields, because the rule it encodes was previously only
 * written in prose in `DrawioFrame`: a `.drawio` export has no picture options, and a picture
 * export is never sent without them. As two independent fields that rule would hold until the day
 * somebody set one and forgot the other; as this, it is the compiler's problem.
 */
export type PendingExport =
  | { format: "drawio" }
  | { format: ImageExportFormat; options: ImageExportOptions };

/**
 * The formats each option reaches, for the ones that do not reach all three.
 *
 * Kept as data next to `exportMessage` so the dialog's greyed-out rows and the message it builds
 * cannot disagree: this table is the reason a row is disabled, and the branches below are the
 * reason the table says what it says.
 */
const RESTRICTED_TO: Partial<Record<ExportOptionKey, readonly ImageExportFormat[]>> = {
  grid: ["png"],
  size: ["png"],
  appearance: ["svg", "pdf"],
};

/** Whether an option means anything for this format. Anything not in the table applies to all. */
export function supportsOption(format: ImageExportFormat, option: ExportOptionKey): boolean {
  const only = RESTRICTED_TO[option];
  return only === undefined || only.includes(format);
}

/**
 * The options, as the message that carries them.
 *
 * **`background` is omitted rather than nulled when transparency is on, and that is a bug fix
 * rather than a matter of taste.** `exportToCanvas` opens with:
 *
 * ```js
 * var fa = Z ? null : Q.background;      // Z = transparent
 * fa == mxConstants.NONE && (fa = null);
 * null == fa && (fa = H);                // H = background
 * ```
 *
 * so a `background` sent next to `transparent: true` walks straight back into the hole the flag
 * made, and the PNG arrives opaque with nothing anywhere reporting a conflict. `background: null`
 * would happen to work — `null == fa` stays true and the `0 == Z` guard on the default page colour
 * is false while `Z` is `true` — but "omit the key" is the version that reads like what it means.
 *
 * The vector branch has no transparency flag at all; there, `"none"` is `mxConstants.NONE`, which
 * the handler converts to `null` before handing it to `getSvg`. Worth stating because it is a
 * behaviour change: `DrawioFrame` used to hard-code `background: "none"` for SVG, so every SVG this
 * app has ever written was transparent. With the dialog they are opaque unless the box is ticked —
 * deliberate, since a dialog exists so that what comes out is what was asked for, and the box is
 * remembered from the first time it is ticked.
 */
export function exportMessage(format: ImageExportFormat, options: ImageExportOptions): EmbedAction {
  const { zoom, border, transparent, shadow, grid, size, appearance } = options;
  if (format === "png") {
    return {
      action: "export",
      format: "png",
      scale: zoom / 100,
      border,
      shadow,
      grid,
      size,
      ...(transparent ? { transparent: true } : { background: "#ffffff" }),
    };
  }
  return {
    action: "export",
    format,
    scale: zoom / 100,
    border,
    shadow,
    background: transparent ? "none" : "#ffffff",
    ...(appearance === "auto" ? {} : { theme: appearance }),
  };
}

/**
 * Options from whatever was stored — or from whatever was typed.
 *
 * Both callers go through here on purpose. A value read back from `app_settings` and a value the
 * user has just keyed into the dialog are the same kind of untrusted input, and a second, laxer
 * path for the second one is how a 0 % zoom reaches the editor from the only direction nobody
 * tested.
 *
 * Zoom is clamped to 10–1000 rather than trusted to the input's own `min`/`max`, which only fire
 * on a native form submit and there is no form here. The ceiling is not arbitrary:
 * `Editor.getMaxCanvasScale` caps the canvas at 16384 px (8192 on Firefox) and silently lowers the
 * scale to fit, so an absurd zoom does not raise anything — it returns a picture at a scale nobody
 * chose. Better to refuse the number where the user can still see the field.
 */
export function parseExportOptions(raw: string | null): ImageExportOptions {
  if (!raw) return DEFAULT_EXPORT_OPTIONS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_EXPORT_OPTIONS;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_EXPORT_OPTIONS;
  const stored = parsed as Partial<Record<ExportOptionKey, unknown>>;
  return {
    zoom: clamp(stored.zoom, 10, 1000, DEFAULT_EXPORT_OPTIONS.zoom),
    border: Math.round(clamp(stored.border, 0, 1000, DEFAULT_EXPORT_OPTIONS.border)),
    transparent: bool(stored.transparent, DEFAULT_EXPORT_OPTIONS.transparent),
    shadow: bool(stored.shadow, DEFAULT_EXPORT_OPTIONS.shadow),
    grid: bool(stored.grid, DEFAULT_EXPORT_OPTIONS.grid),
    size: stored.size === "page" ? "page" : "diagram",
    appearance:
      stored.appearance === "light" || stored.appearance === "dark" ? stored.appearance : "auto",
  };
}

/**
 * A number from a stored value or from a field.
 *
 * Strings are accepted because the dialog keeps its numeric fields as text — see
 * `ExportImageModal` — but a blank one falls back to the default instead of to `Number("")`, which
 * is `0`: clamping that would turn an emptied zoom box into a 10 % export rather than into "you
 * did not change it".
 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
