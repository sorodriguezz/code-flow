/**
 * The draw.io embed protocol, as this app speaks it.
 *
 * draw.io runs in an iframe and talks over `postMessage` with JSON strings. Everything here was
 * checked against the vendored build (v31.1.8, see `scripts/build-drawio-webapp.mjs`) rather than
 * taken from documentation, because the parts that matter are the ones documentation is quietest
 * about. What the handshake actually does, in order:
 *
 * 1. `configure` — the editor asks for its configuration, once, before anything is drawn. Only sent
 *    when `configure=1` is in the URL. We answer with `{ action: "configure", config }`.
 * 2. `init` — the editor is ready. We answer with `{ action: "load", xml, autosave: 1 }`.
 * 3. `load` — confirmation, carrying the document back.
 * 4. `autosave` — **fires on every real user edit**, carrying the current `xml`. This is the only
 *    change signal we use. Note that it does *not* fire for a programmatic `merge`, which is why
 *    the AI path has to save explicitly rather than trusting this.
 * 5. `export` — the answer to `{ action: "export", format }`, carrying `data` as a **`data:` URI**
 *    (not raw markup) plus the `xml` it was rendered from.
 *
 * There is deliberately no `save` handling: the Save button is turned off in the URL, because a
 * document that autosaves has nothing for one to do, and a button that looks like it might not have
 * saved is worse than none.
 */

/** Where the vendored editor lives, relative to the app's own origin. Same origin is what lets
 *  `postMessage` work without loosening anything — see the URL built by `embedUrl`. */
const EDITOR_PATH = "/drawio/index.html";

/**
 * The URL the iframe loads.
 *
 * Every parameter here is a decision:
 *
 * - `embed=1&proto=json` — the embed protocol at all.
 * - `configure=1` — sends the `configure` event, without which `config` is never asked for.
 * - `libraries=1` — the shape palette. Off by default in embed mode, and the whole reason to embed
 *   draw.io rather than draw our own boxes.
 * - `noSaveBtn=1&noExitBtn=1&saveAndExit=0` — **all three**, verified together: with only the first
 *   two, the editor still draws a combined "Save and exit" button.
 * - `dark` — the theme, which cannot be changed after load, so the frame is remounted on a theme
 *   change (see `DrawioFrame`).
 * - `lang` — the editor's own UI language, following the app's.
 * - `noDevice=1` — no device/telemetry ping.
 */
export function embedUrl(options: { dark: boolean; language: string }): string {
  const params = new URLSearchParams({
    embed: "1",
    proto: "json",
    configure: "1",
    libraries: "1",
    noSaveBtn: "1",
    noExitBtn: "1",
    saveAndExit: "0",
    noDevice: "1",
    dark: options.dark ? "1" : "0",
    lang: options.language,
  });
  return `${EDITOR_PATH}?${params.toString()}`;
}

/**
 * Which shape sections start open.
 *
 * A constant because two things need it: the `configure` answer below, and [`seedEditorLibraries`],
 * which exists because that answer is not always obeyed.
 */
export const DEFAULT_LIBRARIES = "general;uml;er;flowchart";

/**
 * Where draw.io keeps its own settings. Same origin as the app, so this is the *app's* localStorage.
 */
const CONFIG_KEY = ".drawio-config";

/** Our marker, so the seed below happens once per value of [`DEFAULT_LIBRARIES`] and not on every
 *  boot. Bump it whenever that constant changes. */
const SEED_KEY = "cf.drawio.libraries.seed";
const SEED_VERSION = "1";

/**
 * Makes [`DEFAULT_LIBRARIES`] take effect on an editor that has already run once.
 *
 * **`defaultLibraries` is a seed, not a setting**, and that difference cost an afternoon. draw.io
 * writes the open sections into `.drawio-config` the first time it boots and reads them from there
 * ever after; the value handed to `configure` only applies when there is nothing stored. So
 * changing the constant fixes it on a fresh install and does nothing at all on a machine where the
 * editor has been opened — the shape palette keeps whatever the old default put there.
 *
 * This rewrites **only the `libraries` field**, once. Clearing the whole key would have been one
 * line and would also have deleted `customLibraries`, which is where the user's scratchpad lives.
 *
 * **Once**, tracked by our own marker, because after this the set belongs to the user: opening AWS
 * from "+ Más formas" is a choice draw.io persists in the same field, and re-imposing our value on
 * every boot would quietly undo it every time the app restarted.
 */
export function seedEditorLibraries(): void {
  try {
    if (localStorage.getItem(SEED_KEY) === SEED_VERSION) return;
    const raw = localStorage.getItem(CONFIG_KEY);
    // Nothing stored means a fresh editor, which `defaultLibraries` already handles. The marker is
    // still written, so the first real boot is not treated as a migration a second time.
    if (raw) {
      const config: unknown = JSON.parse(raw);
      if (config && typeof config === "object") {
        (config as Record<string, unknown>).libraries = DEFAULT_LIBRARIES;
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
      }
    }
    localStorage.setItem(SEED_KEY, SEED_VERSION);
  } catch {
    // Storage unavailable, or a config this build cannot parse. Neither is worth failing the
    // editor over — the palette is then whatever draw.io decides, which is a cosmetic loss.
  }
}

/**
 * What the editor is told about itself, once, at `configure` time.
 *
 * The shape libraries are **not** restricted. An `enabledLibraries` whitelist was the obvious knob
 * and is deliberately not used: the reason to embed draw.io is to get all of it, and a whitelist is
 * how the AWS shapes quietly stop existing three releases later. `defaultLibraries` only decides
 * which sections start open — everything else is one click away under "More shapes".
 */
export function editorConfig(dark: boolean): Record<string, unknown> {
  return {
    /**
     * Which sections of the shape palette start **open**, and nothing more than that.
     *
     * Six: General, Miscelánea and Avanzado (all three are `general`), Diagrama de flujo, Relación
     * de la entidad and UML — the shapes a codebase is drawn with. Everything else stays one click
     * away under "+ Más formas".
     *
     * The cloud sets used to be listed here, and the palette that produced was thirty-odd headings
     * deep: `aws4` alone unfolds into "AWS / Arrows", "AWS / Analytics", "AWS / Blockchain" and
     * twenty more, so the six sections anyone actually reaches for were pushed off the top of a
     * scrolling list. They are all still installed and still searchable — see the trim in
     * `scripts/build-drawio-webapp.mjs` for what is genuinely gone, which is not this.
     */
    defaultLibraries: DEFAULT_LIBRARIES,
    /**
     * The little restyling the embed allows, and the two things it removes.
     *
     * **The menubar is gone** — Archivo / Editar / Vista / Organizar / Extras / Ayuda. It is
     * draw.io's chrome rather than this app's, it repeats what the toolbar and the format panel
     * already offer, and half of what is left in it (Archivo's cloud entries, Ayuda's support
     * links) leads out of an app it should not lead out of.
     *
     * What that actually costs, checked rather than assumed: **almost nothing.** Align, distribute,
     * size and position live in the format panel's *Organizar* tab, which appears whenever a shape
     * is selected. Cut, copy, duplicate, order, edit style, edit data and edit link are all on the
     * right-click menu. The one casualty is `Extras → Editar diagrama`, which edits the document's
     * XML by hand and has no other door — bring the line below back if you ever want it.
     *
     * **No layout fix is needed with it.** draw.io recomputes the pane offsets from the visible
     * chrome, so `display: none` moves the toolbar to the top and the canvas up with it; verified,
     * rather than trusted.
     *
     * **The link out to draw.io's own GitHub repository is gone too**, for the plainest reason of
     * all: it sat in the corner of the page-tab bar and opened a browser onto somebody else's
     * project, from inside a diagram belonging to this workspace. Hidden rather than deleted from
     * the build — it is drawn by `app.min.js`, which ships whole whatever we do.
     */
    css:
      `.geToolbarContainer { font-family: inherit; }` +
      `.geMenubarContainer { display: none !important; }` +
      // The page-tab strip along the bottom. A diagram here is one drawing in one row of the tree,
      // so pages would be a second, invisible level of nesting inside it — and the gallery, the
      // search and the thumbnail all describe the first page only. Hiding the strip is what makes
      // "one diagram per window" true rather than merely usual. draw.io's own link out to its
      // GitHub repository lived in this strip and goes with it.
      `.geTabContainer { display: none !important; }`,
    // A diagram lives in this workspace's database. Fonts fetched from Google's CDN would be a
    // network call from inside a desktop app, and one the strict CSP would refuse anyway.
    defaultFonts: ["Helvetica", "Verdana", "Times New Roman", "Courier New"],
    // The editor's own dark flag, which controls the *canvas* chrome rather than the UI shell.
    darkMode: dark,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The events this app acts on. Others (`save`, `exit`, `openLink`, …) arrive and are ignored. */
export type EmbedEvent =
  | { event: "configure" }
  | { event: "init" }
  | { event: "load"; xml?: string }
  | { event: "autosave"; xml: string }
  | { event: "export"; format: string; data: string; xml?: string }
  | { event: string; [key: string]: unknown };

/**
 * Parses a message from the iframe.
 *
 * `null` for anything that is not one of the editor's JSON envelopes — the same window receives
 * messages from other sources, and a bare string that happens to arrive here must not throw inside
 * a listener.
 */
export function parseEmbedMessage(data: unknown): EmbedEvent | null {
  if (typeof data !== "string" || !data.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== "object" || parsed === null) return null;
    const event = (parsed as { event?: unknown }).event;
    return typeof event === "string" ? (parsed as EmbedEvent) : null;
  } catch {
    return null;
  }
}

/** The actions this app sends. */
export type EmbedAction =
  | { action: "configure"; config: Record<string, unknown> }
  | { action: "load"; xml: string; autosave: 1; title?: string }
  | { action: "merge"; xml: string }
  | {
      action: "export";
      /** `xmlsvg` embeds the document inside the SVG, so the file reopens as an editable diagram
       *  rather than as a picture of one. That is what makes it the right choice for a save and
       *  the wrong one for a thumbnail. */
      format: "png" | "svg" | "xmlsvg" | "pdf";
      background?: string;
      scale?: number;
      width?: number;
    };

/**
 * Sends one action to the editor.
 *
 * `targetOrigin` is the app's own origin rather than `"*"`. The editor is served from the same
 * origin as the app, so nothing is lost by being specific — and a `"*"` here would post the
 * document's contents to whatever happened to be in that frame if the src ever changed.
 */
export function postToEditor(frame: HTMLIFrameElement | null, action: EmbedAction): void {
  frame?.contentWindow?.postMessage(JSON.stringify(action), window.location.origin);
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/**
 * What the gallery's picture is exported as.
 *
 * **PNG at a fixed width, not SVG**, and the reason is bounded cost. An exported SVG grows with the
 * shape count — a two-hundred-box architecture diagram is hundreds of kilobytes of markup — while a
 * raster at a fixed width is bounded by its pixel count whatever is drawn in it. These rows are
 * fetched in batches to draw a grid of cards, and "the thumbnail got big because the diagram got
 * complicated" is exactly the failure that would make the gallery slow on the workspaces that use
 * it most.
 *
 * The white background is deliberate too: shape text is dark by default, so a transparent PNG is
 * unreadable on a dark card. A pale sheet under a drawing is what every other canvas tool shows.
 */
export const THUMBNAIL_EXPORT: EmbedAction = {
  action: "export",
  format: "png",
  background: "#ffffff",
  width: 320,
};

/**
 * The ceiling on a stored thumbnail, in characters of `data:` URI.
 *
 * Roughly 96 KB of base64, which a 320px-wide PNG only reaches if it is unusually dense. Past it
 * the picture is dropped and the card falls back to its placeholder glyph — a missing thumbnail is
 * a cosmetic loss, while an unbounded one is a column that grows without limit inside a batch
 * fetch. Dropped silently on purpose: nothing the user did was wrong.
 */
export const THUMBNAIL_MAX_CHARS = 128_000;

// ---------------------------------------------------------------------------
// This app's own toolbar buttons
// ---------------------------------------------------------------------------

/**
 * The glyphs for the injected buttons.
 *
 * **Drawn here rather than imported from lucide**, which is what the rest of the app uses. The
 * buttons live inside the iframe, in draw.io's document, where there is no React to render a
 * component into — and a React portal does not help, because React delegates its events at the
 * root container and nothing in another document is under it. So these are markup, and being
 * markup they are hand-drawn: 24-unit box, 2-unit stroke, round caps, `currentColor`, which is the
 * language draw.io's own toolbar icons are in. They sit beside them rather than among them.
 */
const ICONS = {
  template:
    '<rect x="3" y="3" width="18" height="6" rx="1"/>' +
    '<rect x="3" y="13" width="8" height="8" rx="1"/>' +
    '<rect x="15" y="13" width="6" height="8" rx="1"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/>',
  sparkles:
    '<path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>' +
    '<path d="M19 3v3"/><path d="M20.5 4.5h-3"/>',
} as const;

export type ToolbarIcon = keyof typeof ICONS;

export interface ToolbarButton {
  /** Stable, and the handle this module removes a previous injection by. */
  id: string;
  icon: ToolbarIcon;
  title: string;
  /** `at` is in the **parent document's** coordinates, so a menu opened from here lands under the
   *  pointer rather than offset by the iframe's position. */
  onClick: (at: { x: number; y: number }) => void;
}

/** Marks what this module put there, so re-injecting replaces rather than accumulates. */
const INJECTED = "data-cf-toolbar";

/**
 * Adds this app's buttons to the end of draw.io's toolbar, after its own last one.
 *
 * **Reaching into the editor's DOM, deliberately and with its eyes open.** The alternative was the
 * strip of CodeFlow chrome these buttons used to live in, which meant two toolbars stacked on top
 * of each other saying different things — and the actions are *about the drawing*, so they belong
 * beside the drawing's tools. The embed protocol offers no way to add one, so this is the only
 * route there is.
 *
 * What makes it safe enough to do: the toolbar is built once and **not rebuilt** — verified against
 * this vendored build by injecting a node and then selecting shapes, undoing, re-`load`ing the
 * document and resizing, with the node surviving all four. What would drop them is the frame
 * remounting, which is exactly when `DrawioFrame` calls this again.
 *
 * Returns whether the toolbar was there to inject into.
 */
export function injectToolbarButtons(
  frame: HTMLIFrameElement | null,
  buttons: ToolbarButton[],
): boolean {
  const doc = frame?.contentDocument;
  const toolbar = doc?.querySelector(".geToolbar");
  if (!doc || !toolbar) return false;

  for (const stale of toolbar.querySelectorAll(`[${INJECTED}]`)) stale.remove();

  const separator = doc.createElement("div");
  separator.className = "geSeparator";
  separator.setAttribute(INJECTED, "separator");
  toolbar.appendChild(separator);

  const offset = () => frame?.getBoundingClientRect() ?? { left: 0, top: 0 };

  for (const button of buttons) {
    const element = doc.createElement("a");
    element.className = "geButton";
    element.title = button.title;
    element.setAttribute(INJECTED, button.id);
    element.innerHTML =
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
      `style="margin:5px">${ICONS[button.icon]}</svg>`;
    element.addEventListener("click", (event) => {
      event.preventDefault();
      const box = offset();
      // Translated out of the iframe's coordinate space, or a menu opened from here appears
      // shifted left and up by however far the editor sits from the window's corner.
      button.onClick({ x: box.left + event.clientX, y: box.top + event.clientY });
    });
    toolbar.appendChild(element);
  }
  return true;
}
