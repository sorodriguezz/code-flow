/**
 * From the text a diagram holds to the page it is shown as — one function for the viewer in the app
 * and for the file a user downloads, so what they save is what they were looking at.
 */
import { archifyDocKind, type ArchifyDocument, type ArchifyMode, type ArchifyParseError } from "./ir";
import { buildScene } from "./layout/build";
import type { ArchifyScene } from "./scene";
import { buildViewerHtml, type HostTheme, type Preset, type ViewerLabels } from "./viewer/html";

export type ArchifyPage =
  /** A page archify itself rendered: shown exactly as it is, sandboxed. */
  | { kind: "html"; html: string }
  /** A document, drawn by this viewer. */
  | { kind: "viewer"; html: string; ir: ArchifyDocument; scene: ArchifyScene }
  | { kind: "invalid"; error: ArchifyParseError; mode?: string };

export interface PageOptions {
  title: string;
  language: "en" | "es";
  theme: "dark" | "light";
  /** The viewer's words — which depend on the type, so a function of it is accepted. */
  labels: ViewerLabels | ((mode: ArchifyMode) => ViewerLabels);
  presetNames: Record<string, string>;
  preset?: Preset;
  /** Whether a source becomes a link: on in a downloaded file, off in the sandboxed frame. */
  linkSources: boolean;
  /** Framed inside the app: no title block, no theme, style or export controls. */
  embed: boolean;
  host?: HostTheme;
}

export function pageFromScene(scene: ArchifyScene, options: PageOptions): string {
  return buildViewerHtml({
    scene,
    labels: typeof options.labels === "function" ? options.labels(scene.mode) : options.labels,
    presetNames: options.presetNames,
    language: options.language,
    theme: options.theme,
    preset: options.preset,
    embed: options.embed,
    host: options.host,
  });
}

export function renderArchifyPage(doc: string, options: PageOptions): ArchifyPage {
  const found = archifyDocKind(doc, options.title);
  if (found.kind === "html") return { kind: "html", html: doc };
  if (found.kind === "invalid") return { kind: "invalid", error: found.error, mode: found.mode };
  const scene = buildScene(found.ir, { linkSources: options.linkSources });
  // The row's title wins over the document's own, so the page is headed by the name the user sees.
  scene.title = options.title.trim() || scene.title;
  return { kind: "viewer", html: pageFromScene(scene, options), ir: found.ir, scene };
}
