/**
 * The page an archify diagram is shown and downloaded as: one self-contained HTML file — styles,
 * script and data inline, nothing fetched — so the file a user saves is the page they were looking at.
 *
 * Every string from the diagram reaches the page as data: the skeleton below has no interpolated
 * markup except the escaped `<title>` and `lang`, and the script fills `textContent` and attributes
 * from a JSON block whose `<` is escaped — a label reading `</script>` stays a label.
 *
 * **It cannot run in a `srcdoc` frame inside the app.** A `srcdoc` document inherits the policy of the
 * page that holds it, and the app's build-time policy (`lib/csp.ts`) withholds inline scripts — so
 * the page would be an empty SVG in a packaged build while working in `pnpm tauri dev`, which has no
 * policy at all. `ArchifyViewer` loads it through `public/archify/host.html` instead.
 */
import type { ArchifyScene } from "../scene";
import runtime from "./runtime.js?raw";
import { VIEWER_CSS } from "./css";

export interface ViewerLabels {
  [key: string]: string | Record<string, string>;
  types: Record<string, string>;
}

/** Colours the app hands the page so it looks like the window it is in. */
export interface HostTheme {
  scheme: "dark" | "light";
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  line2: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accent2: string;
  hover: string;
}

export const PRESETS = ["classic", "signal-flow", "blueprint", "editorial"] as const;
export type Preset = (typeof PRESETS)[number];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function buildViewerHtml(args: {
  scene: ArchifyScene;
  labels: ViewerLabels;
  /** Display names of the presets, by id. */
  presetNames: Record<string, string>;
  language: "en" | "es";
  theme: "dark" | "light";
  preset?: Preset;
  /** Framed inside the app: no title block, no theme, style or export controls. */
  embed: boolean;
  host?: HostTheme;
}): string {
  const { scene } = args;
  const payload = JSON.stringify({
    title: scene.title,
    scene,
    labels: args.labels,
    theme: args.theme,
    preset: args.preset ?? "classic",
    embed: args.embed,
    host: args.host ?? null,
    presets: PRESETS.map((id) => ({ id, label: args.presetNames[id] ?? id })),
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  return [
    "<!doctype html>",
    `<html lang="${args.language}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    // The page's own policy, for the file once it is downloaded: nothing loads, nothing is sent.
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'\">",
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="CodeFlow archify viewer">',
    `<title>${escapeHtml(scene.title)}</title><style>${VIEWER_CSS}</style></head>`,
    `<body>${SKELETON}`,
    `<script type="application/json" id="data">${payload}</script><script>${runtime}</script>`,
    "</body></html>",
  ].join("");
}

const SKELETON = [
  '<div id="app" class="app">',
  '<header class="head"><p id="eyebrow" class="eyebrow"></p><h1 id="title"></h1><p id="subtitle" class="subtitle"></p></header>',
  '<div class="toolbar" role="toolbar">',
  '<label class="search"><span class="ic" id="searchIcon"></span><input id="search" type="search" autocomplete="off" spellcheck="false"><span class="count" id="searchCount"></span></label>',
  '<span class="group"><button class="tb" id="zoomOut" type="button"></button><span class="pct" id="zoomPct"></span><button class="tb" id="zoomIn" type="button"></button><button class="tb" id="fit" type="button"></button></span>',
  '<span class="sep-v"></span>',
  '<span class="seg" id="reach" role="group"><button type="button" data-reach="direct"></button><button type="button" data-reach="up"></button><button type="button" data-reach="down"></button></span>',
  '<button class="tb" id="routeBtn" type="button"></button>',
  '<span class="spacer"></span>',
  '<select class="select" id="preset"></select>',
  '<button class="tb" id="motionBtn" type="button"></button>',
  '<button class="tb" id="themeBtn" type="button"></button>',
  '<span class="menu-wrap"><button class="tb" id="exportBtn" type="button"></button><div class="menu" id="exportMenu" hidden></div></span>',
  '<button class="tb" id="presentBtn" type="button"></button>',
  '<button class="tb" id="panelBtn" type="button"></button>',
  "</div>",
  '<div class="body">',
  '<main class="stage" id="stage"><svg id="map" role="img" preserveAspectRatio="xMidYMid meet"></svg></main>',
  '<aside class="panel" id="panel" aria-live="polite"><div class="panel-head"><div><p class="eyebrow" id="panelEyebrow"></p><h2 id="panelTitle"></h2></div><button class="close" id="closePanel" type="button"></button></div><div class="panel-body" id="panelBody"></div></aside>',
  "</div>",
  '<footer class="foot"><div class="legend" id="legend"></div><span class="status" id="status"></span></footer>',
  '<button class="tb exit-present" id="exitPresent" type="button"></button>',
  "</div>",
].join("");
