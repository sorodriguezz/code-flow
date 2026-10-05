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
 *    (not raw markup) plus the `xml` it was rendered from. The one exception is `format: "xml"`,
 *    which has nothing to render and answers on `xml` alone.
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
 * - `dark` — the theme the editor *boots* in. It can be changed afterwards without a reload; see
 *   [`setEditorDarkMode`], which is what a light/dark switch actually goes through.
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
// Dark mode, without a reload
// ---------------------------------------------------------------------------

/**
 * The parts of the editor's own window this module reaches for. Deliberately the smallest possible
 * surface, and every field optional: this is a description of somebody else's runtime, and the only
 * honest thing to assume about it is that any of it may be gone after a version bump.
 */
interface EditorUiLike {
  setDarkMode?: (dark: boolean) => void;
}

interface DrawioWindow extends Window {
  Editor?: { darkMode?: boolean };
  mxUtils?: { lightDarkColorSupported?: boolean };
  Draw?: { loadPlugin?: (plugin: (ui: EditorUiLike) => void) => void };
  App?: {
    prototype: { initializeEmbedMode?: () => void };
    embedModePluginsCount?: number;
  };
}

/** One editor instance per frame window, found once. Weak so a remounted frame is not held alive. */
const EDITOR_UIS = new WeakMap<Window, EditorUiLike>();

/**
 * The editor's own `EditorUi` instance, which draw.io keeps entirely to itself.
 *
 * It is a local inside `App.main` — nothing is hung on the window — so there is exactly one door:
 * in embed mode draw.io publishes `Draw.loadPlugin`, which calls back with the instance. That door
 * has a spring on it. Its `finally` decrements the plugin counter and calls `initializeEmbedMode()`
 * again, and that method *installs a second message handler* — the app would then receive every
 * `autosave` and `export` twice, and save the document twice for each edit.
 *
 * So the spring is held for the length of the call: `initializeEmbedMode` is stubbed on
 * `App.prototype` (the override that would actually run — `EditorUi.prototype` has its own, which
 * is not the one reached), and the counter is put back. Both are restored in a `finally` of our
 * own, so a plugin callback that threw could not leave the editor without its initialiser.
 *
 * Verified against the vendored build by driving a real embed handshake and confirming the protocol
 * log was unchanged across the call — `configure, init, load` before and after, no repeats.
 */
function editorUi(win: DrawioWindow): EditorUiLike | null {
  const cached = EDITOR_UIS.get(win);
  if (cached) return cached;

  const loadPlugin = win.Draw?.loadPlugin;
  const app = win.App;
  if (typeof loadPlugin !== "function" || !app?.prototype) return null;

  // A holder rather than a bare `let`, because the assignment happens inside a callback and the
  // compiler cannot see through that — it would narrow the variable to `null` for the read below.
  const found: { ui: EditorUiLike | null } = { ui: null };
  const initializer = app.prototype.initializeEmbedMode;
  const plugins = app.embedModePluginsCount;
  app.prototype.initializeEmbedMode = () => {};
  try {
    loadPlugin((ui) => {
      found.ui = ui;
    });
  } finally {
    app.prototype.initializeEmbedMode = initializer;
    app.embedModePluginsCount = plugins;
  }

  if (typeof found.ui?.setDarkMode !== "function") return null;
  EDITOR_UIS.set(win, found.ui);
  return found.ui;
}

/**
 * Repaints the open editor light or dark, in place.
 *
 * **Why this is worth reaching into the iframe for.** The theme is a URL parameter, so the obvious
 * way to change it is to remount the frame — and that reboots draw.io: tens of megabytes of
 * JavaScript, the document re-sent, the view refitted, a second or so of skeleton over the canvas
 * every time the app goes light or dark. Modern draw.io does not need any of that. Its dark mode is
 * a class on the container plus a `color-scheme`, with the whole editor stylesheet and the drawing
 * itself written in CSS `light-dark()` — so `setDarkMode` recolours the toolbar, the shape palette,
 * the format panel and the shapes on the canvas in one frame, with the document, the zoom and the
 * scroll position untouched. That is a reload replaced by a repaint.
 *
 * **Returns whether it worked, and the caller must respect a `false`.** Everything here is somebody
 * else's private runtime: `Draw.loadPlugin`, `App.prototype`, `Editor.darkMode`. A version bump is
 * entitled to move any of it, and the answer to that is a diagram that still changes theme by the
 * old, slow route (see `DrawioFrame`) — never a diagram stuck in the wrong one. The result is read
 * back from `Editor.darkMode` rather than inferred from "nothing threw", because the editor's own
 * `setDarkMode` is a no-op when the engine has no `light-dark()` and would otherwise report success
 * for having done nothing.
 */
export function setEditorDarkMode(frame: HTMLIFrameElement | null, dark: boolean): boolean {
  try {
    const win = frame?.contentWindow as DrawioWindow | null | undefined;
    // No `Editor` means the frame is between documents — booting, or already gone.
    if (!win?.Editor) return false;
    if (win.Editor.darkMode === dark) return true;
    if (!win.mxUtils?.lightDarkColorSupported) return false;

    const ui = editorUi(win);
    if (!ui?.setDarkMode) return false;
    ui.setDarkMode(dark);
    return win.Editor.darkMode === dark;
  } catch {
    // A cross-origin frame, a document swapped out mid-call, an internal that moved. All of them
    // mean the same thing to the caller, and none of them is worth an error over: the reload is
    // still there.
    return false;
  }
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
       *  the wrong one for a thumbnail.
       *
       *  `xml` is the odd one out and the reply says so: it answers on `xml` and leaves `data`
       *  unset, because there is nothing to render — the document *is* the file. Verified against
       *  the vendored build, which handles it as `message.xml = getFileData(true)`, i.e. the whole
       *  `<mxfile>` wrapper, uncompressed (`Editor.defaultCompressed` is false and nothing here
       *  turns it back on). That is what makes the saved file readable by anything, not just by
       *  draw.io. */
      format: "png" | "svg" | "xmlsvg" | "pdf" | "xml";
      /** The colour painted behind the drawing. `"none"` is `mxConstants.NONE`, which the handler
       *  turns straight back into `null` — the vector branch's only way of saying "no rectangle".
       *
       *  Careful on PNG: there it is a *fallback*, not an instruction. The canvas branch reads
       *  `fa = transparent ? null : graph.background` and then `null == fa && (fa = background)`,
       *  so a `background` sent alongside `transparent: true` fills the hole the flag just made
       *  and the file comes back opaque with no warning. See `exportMessage`, which is why the key
       *  is omitted rather than set to `null` in that case. */
      background?: string;
      scale?: number;
      /** Pixels across, and it **overrides `scale`** rather than combining with it — the canvas
       *  branch reads the scale, then does `null != width && (V = …width…)` and throws away what
       *  it just read (and caps the result at 1, so a width larger than the drawing does nothing).
       *  Two controls where one silently wins is not a dialog anybody can reason about, so the
       *  export dialog offers zoom and never this. Left in the type because the thumbnail path
       *  wants a fixed width by design — see `THUMBNAIL_EXPORT`. */
      width?: number;
      /** Empty space around the drawing, in points. Read by both branches: the canvas one passes
       *  it as `exportToCanvas`'s `border`, the vector one as `getSvg`'s third argument. */
      border?: number;
      /** PNG only, and it is a flag rather than a colour — `exportToCanvas`'s ninth argument. The
       *  vector branch never looks at it; an SVG or a PDF is made transparent by sending
       *  `background: "none"` instead. */
      transparent?: boolean;
      /** Both branches, with one asymmetry worth knowing: the vector branch computes
       *  `graph.shadowVisible || shadow`, so on a diagram that already has shadows turned on in
       *  the editor a `false` here cannot take them off again. PNG has no such `||` and obeys. */
      shadow?: boolean;
      /** PNG only. `exportToCanvas` draws the grid itself, onto the canvas, after the drawing —
       *  there is no equivalent anywhere in the vector branch. */
      grid?: boolean;
      /** PNG only, and for a duller reason than `grid`: the canvas branch reaches `getSvg`'s
       *  thirteenth parameter (`"page"` switches the bounds to `view.getBackgroundPageBounds()`),
       *  while the vector branch calls `getSvg` with twelve arguments and stops one short of it.
       *  So an SVG or a PDF is always the drawing's own bounds, whatever is asked for here.
       *
       *  `"diagram"` is *not* simply the same as omitting the key, and the difference is one line:
       *  `"diagram" == size && null != backgroundImage && (bounds.add(…the image…))`. Sent, a
       *  background image is inside the picture; omitted, the export crops to the cells and cuts
       *  it away. Sending it is the behaviour draw.io's own dialog has, so this is a fix rather
       *  than a regression — but it is a difference, and worth knowing before blaming a diagram
       *  that suddenly exports wider than it used to. */
      size?: "diagram" | "page";
      /** SVG and PDF only. It lands on `getSvg`'s twelfth parameter, which the vector branch does
       *  pass. The canvas branch derives its theme from `keepTheme` and never reads this key, so a
       *  light/dark choice cannot be expressed for a PNG at all. */
      theme?: "light" | "dark";
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
// Presses, forwarded back out of the frame
// ---------------------------------------------------------------------------

/**
 * Echoes a press inside the editor as a press on the `<iframe>` itself, so the app can see it.
 *
 * **Why anything is needed at all.** Every popover in this app closes the same way: a `mousedown`
 * listener on `document` or `window` that asks whether the press landed inside its own panel and
 * dismisses itself when it did not — the battery and usage meters, the notification panel, every
 * right-click menu in every tree, the model pickers, `useDismissOnOutside`. Events inside an iframe
 * are delivered in *that* document and do not cross into this one, so as far as all of them are
 * concerned, clicking on a diagram is not a click at all. Open the battery popover, click into the
 * canvas, and it stays there over the drawing — while clicking anywhere else in the window closes
 * it, which is what makes it read as the app ignoring the diagram rather than as a rule.
 *
 * So the press is repeated on the iframe element, which is a real node in this document. Nothing
 * has to know about diagrams: the echo bubbles to `document` and `window` like any other press, and
 * `event.target` is an element no popover contains — which is exactly the question every one of
 * those listeners was already asking.
 *
 * Three details do the work:
 *
 * - **Capture phase**, so an editor that stops the press on its way down cannot also stop the app
 *   from hearing that it happened. Whether draw.io swallows a click is its business; whether this
 *   window's menus close is not.
 * - **Coordinates translated out of the frame's space.** They are what a hit test would read, and
 *   `overlayDragRegion` runs one on every press: left unmapped, a click in the middle of a diagram
 *   arrives at the parent as a press near the window's top-left corner — the title bar.
 * - **`cancelable: false`.** This is a notification that something already happened. There is
 *   nothing left for a `preventDefault` to prevent, and saying so keeps a listener from believing
 *   it suppressed a press it never had.
 *
 * **What is listened for inside the frame is `pointerdown`; what is echoed out is a `mousedown`.**
 * The two are not the same choice and neither is arbitrary.
 *
 * Inbound it has to be `pointerdown`, because on Windows and Linux there is no `mousedown` to hear.
 * mxGraph binds whichever family `mxClient.IS_POINTER` selects — and that flag is
 * `window.PointerEvent != null && !(navigator.appVersion.indexOf('Mac') > 0)`, so it is false on
 * macOS and true everywhere else. On those platforms draw.io takes the press as a `pointerdown` and
 * consumes it, and a cancelled `pointerdown` suppresses the compatibility `mousedown` outright:
 * listening for one would work on the developer's Mac and silently do nothing on every other build.
 * `pointerdown` is dispatched for every press on every platform and nothing can suppress it.
 *
 * Outbound it stays a `mousedown`, and deliberately not a `click`: `startExternalLinks` opens
 * anchors on a document-level click, and an echo carrying the iframe as its target has no business
 * anywhere near that. It is also what the listeners on this side are written against — see
 * `useDismissOnOutside`, which hears both.
 *
 * Returns the unsubscribe.
 */
export function forwardFramePresses(frame: HTMLIFrameElement | null): () => void {
  const doc = frame?.contentDocument;
  if (!frame || !doc) return () => {};

  const echo = (event: PointerEvent) => echoPress(frame, event);
  doc.addEventListener("pointerdown", echo, true);
  return () => doc.removeEventListener("pointerdown", echo, true);
}

/** One press inside the editor, repeated on the iframe element — see `forwardFramePresses`. */
function echoPress(frame: HTMLIFrameElement, event: PointerEvent): void {
  const box = frame.getBoundingClientRect();
  frame.dispatchEvent(
    new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: false,
      button: event.button,
      buttons: event.buttons,
      // A real press, as far as anything counting clicks is concerned — the editor only ever
      // reaches this window through a press that genuinely landed on it.
      detail: 1,
      clientX: box.left + event.clientX,
      clientY: box.top + event.clientY,
    }),
  );
}

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
  // Lucide's sparkles, the glyph `AiGlyph` masks — this one is stroked with the logo's gradient
  // instead (see `flowingStroke`), so it is the same drawing as every other AI door in the app.
  sparkles:
    '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/>' +
    '<path d="M20 2v4"/><path d="M22 4h-4"/><circle cx="4" cy="20" r="2"/>',
  // A clock with the arrow going back round it: the same drawing every other history button in the
  // app wears, transcribed here because the icon set this toolbar is in is this object rather than
  // the component library the rest of the UI imports from.
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
    '<path d="M3 3v5h5"/>' +
    '<path d="M12 7v5l4 2"/>',
  // The laser pointer's pen, transcribed from `LaserGlyph` (`components/diagrams/Laser`). The spot it
  // throws is drawn by `spot`, because that part is coloured — see `ToolbarButton.spot`.
  laser:
    '<path d="M18.586 2.586 11.586 9.586a2 2 0 0 0 2.828 2.828l7-7a2 2 0 0 0-2.828-2.828z"/>' +
    '<path d="m10 14-1.5 1.5"/>',
  // The small arrow of a split button, for a `narrow` one.
  chevron: '<path d="m8 10 4 4 4-4"/>',
} as const;

export type ToolbarIcon = keyof typeof ICONS;

/** One loop of the AI glyphs' flow, in ms — `cf-ai-flow` in `index.css`, `FLOW_MS` in `AiGlyph`. */
const AI_FLOW_MS = 3000;

/**
 * The `stroke` and `<defs>` that make an injected glyph flow like `AiGlyph`.
 *
 * `AiGlyph` is a CSS mask over a sliding gradient, and none of that CSS exists in draw.io's document.
 * So the same motion is written into the SVG itself: a gradient one period `a b c b a` wide, two
 * glyphs long and repeating, slid one period rightward per loop by SMIL — which is what the mask's
 * strip does. The hues are read off this window's `--cf-ai-*` so there is still one place they are
 * defined, and the loop starts where the page's other glyphs already are (the `begin` offset), so the
 * sparkle in the editor's toolbar flows in step with the ones around it. Still under reduced motion,
 * at the frame the others rest on.
 */
function flowingStroke(): { stroke: string; defs: string } {
  const root = getComputedStyle(document.documentElement);
  const hue = (name: string, fallback: string) => root.getPropertyValue(name).trim() || fallback;
  const [a, b, c] = [hue("--cf-ai-a", "#8b5cf6"), hue("--cf-ai-b", "#6366f1"), hue("--cf-ai-c", "#06b6d4")];
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const begin = -((performance.now() % AI_FLOW_MS) / 1000);
  const motion = still
    ? ""
    : `<animateTransform attributeName="gradientTransform" type="translate" from="-48 0" to="0 0" ` +
      `dur="${AI_FLOW_MS / 1000}s" begin="${begin.toFixed(3)}s" repeatCount="indefinite"/>`;
  return {
    stroke: "url(#cf-ai-flow)",
    defs:
      `<defs><linearGradient id="cf-ai-flow" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="48" y2="0" ` +
      `spreadMethod="repeat">` +
      `<stop offset="0" stop-color="${a}"/><stop offset="0.25" stop-color="${b}"/>` +
      `<stop offset="0.5" stop-color="${c}"/><stop offset="0.75" stop-color="${b}"/>` +
      `<stop offset="1" stop-color="${a}"/>${motion}</linearGradient></defs>`,
  };
}

export interface ToolbarButton {
  /** Stable, and the handle this module removes a previous injection by. */
  id: string;
  icon: ToolbarIcon;
  /** Stroked with the logo's flowing gradient rather than the toolbar's ink — the AI button. */
  flowing?: boolean;
  /**
   * A spot of colour at the glyph's lower left — the ink the laser is loaded with. A literal: the
   * editor's document has none of this app's custom properties. Change it with `updateToolbarButton`.
   */
  spot?: string;
  /** A toggle's state, drawn as pressed. Leave it out for a plain action. */
  pressed?: boolean;
  /** Half width — the arrow half of a split button. */
  narrow?: boolean;
  /** Starts a group of its own: a separator is drawn before it. */
  separated?: boolean;
  title: string;
  /**
   * `at` is where the click landed and `anchor` is the button's own box, both in the **parent
   * document's** coordinates, so a menu opened from here lands under the pointer — or hangs off the
   * button, given the box — rather than offset by the iframe's position.
   */
  onClick: (at: { x: number; y: number }, anchor: ToolbarAnchor) => void;
}

/** A button's box in the parent document, the shape `ContextMenu`'s `anchor` takes. */
export interface ToolbarAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Marks what this module put there, so re-injecting replaces rather than accumulates. */
const INJECTED = "data-cf-toolbar";

/** The stylesheet below, by id, so a second injection into the same document finds it there. */
const STYLE_ID = "cf-toolbar-style";

/** Marks the coloured parts of an injected glyph — see the first rule of `TOOLBAR_STYLE`. */
const KEEP_COLOUR = "data-cf-keep-colour";

/** Set on the editor's root while the laser is on — see `captureLaser`. */
const LASER_ON = "data-cf-laser";

/**
 * The rules this app adds to the editor's document. A stylesheet in that document rather than
 * styles on the nodes, because two of the three key off state that changes after injection — the
 * dark-mode class flips live (`setEditorDarkMode` switches the running editor without a reload), and
 * the laser comes and goes.
 *
 * 1. **Undoes draw.io's dark-mode inversion on coloured glyphs, and only on them.** draw.io lightens
 *    its toolbar in dark mode by inverting every button whole — `.geDarkMode .geButton { filter:
 *    invert(1) }` — because its own icons are dark images. That suits a glyph drawn in
 *    `currentColor`, and it is what keeps the plain injected buttons legible beside them. A
 *    *coloured* glyph it turns into its complement: the AI sparkle's violet came out green and its
 *    cyan orange, a sparkle in no colour this app uses anywhere — and the laser's red spot would come
 *    out cyan. Inverting those parts a second time cancels the first exactly, and the button around
 *    them keeps the treatment its neighbours get: the hover wash and the resting opacity are still
 *    the editor's.
 * 2. **A pressed toggle.** A wash and full opacity, against the editor's resting 0.65. The wash is a
 *    translucent black, which the dark mode's inversion turns into a translucent white — a pressed
 *    look on either toolbar from one value. Specific enough to beat draw.io's resting-opacity rule.
 * 3. **No cursor over the drawing while the laser is on**: the laser's dot is the cursor, and
 *    mxGraph's own — `move` over a shape, set inline on every node — would sit on top of it.
 */
const TOOLBAR_STYLE =
  `.geDarkMode [${INJECTED}] [${KEEP_COLOUR}] { filter: invert(1); }\n` +
  `.geEditor .geButton[${INJECTED}][aria-pressed="true"] { opacity: 1; background-color: rgb(0 0 0 / 0.1); }\n` +
  `html[${LASER_ON}] .geDiagramContainer, html[${LASER_ON}] .geDiagramContainer * { cursor: none !important; }`;

/** Puts `TOOLBAR_STYLE` into the editor's document, once. */
function ensureToolbarStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = TOOLBAR_STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

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

  ensureToolbarStyle(doc);

  const separate = (id: string) => {
    const separator = doc.createElement("div");
    separator.className = "geSeparator";
    separator.setAttribute(INJECTED, id);
    toolbar.appendChild(separator);
  };
  separate("separator");

  const offset = () => frame?.getBoundingClientRect() ?? { left: 0, top: 0 };

  for (const button of buttons) {
    if (button.separated) separate(`${button.id}-separator`);
    const element = doc.createElement("a");
    element.className = "geButton";
    element.title = button.title;
    element.setAttribute(INJECTED, button.id);
    if (button.pressed !== undefined) element.setAttribute("aria-pressed", String(button.pressed));
    const paint = button.flowing ? flowingStroke() : { stroke: "currentColor", defs: "" };
    const glyph =
      `<svg ${button.narrow ? 'width="7.5" height="18" viewBox="7 0 10 24"' : 'width="18" height="18" viewBox="0 0 24 24"'} ` +
      `fill="none" stroke="${paint.stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` +
      // The hook the first rule of `TOOLBAR_STYLE` counter-inverts by, in dark mode.
      `${button.flowing ? ` ${KEEP_COLOUR}` : ""}`;
    const margin = button.narrow ? "5px 1px" : "5px";
    element.innerHTML =
      button.spot === undefined
        ? `${glyph} style="margin:${margin}">${paint.defs}${ICONS[button.icon]}</svg>`
        : // The spot is a second drawing laid exactly over the first, in a box of its own, so it can
          // keep its colour in dark mode while the pen beside it is inverted with the button like
          // every other glyph here.
          `<span style="position:relative;display:inline-flex;margin:${margin}">` +
          `${glyph}>${paint.defs}${ICONS[button.icon]}</svg>` +
          `<svg ${KEEP_COLOUR} data-cf-spot width="18" height="18" viewBox="0 0 24 24" ` +
          `style="position:absolute;left:0;top:0"><circle cx="5.5" cy="18.5" r="3" fill="${button.spot}"/></svg>` +
          `</span>`;
    element.addEventListener("click", (event) => {
      event.preventDefault();
      const box = offset();
      const own = element.getBoundingClientRect();
      // Translated out of the iframe's coordinate space, or a menu opened from here appears
      // shifted left and up by however far the editor sits from the window's corner.
      button.onClick(
        { x: box.left + event.clientX, y: box.top + event.clientY },
        {
          top: box.top + own.top,
          bottom: box.top + own.bottom,
          left: box.left + own.left,
          right: box.left + own.right,
        },
      );
    });
    toolbar.appendChild(element);
  }
  return true;
}

/**
 * Changes an injected button in place — a toggle's state, the laser's ink — without re-injecting the
 * toolbar, which would replace the node under the pointer and drop its hover.
 */
export function updateToolbarButton(
  frame: HTMLIFrameElement | null,
  id: string,
  state: { pressed?: boolean; spot?: string },
): void {
  const element = frame?.contentDocument?.querySelector(`[${INJECTED}="${id}"]`);
  if (!element) return;
  if (state.pressed !== undefined) element.setAttribute("aria-pressed", String(state.pressed));
  if (state.spot !== undefined) element.querySelector("[data-cf-spot] circle")?.setAttribute("fill", state.spot);
}

// ---------------------------------------------------------------------------
// The laser pointer
// ---------------------------------------------------------------------------

/** A point in the iframe's own pixels — which is the overlay's, since it lies exactly on the frame. */
export type FramePoint = [number, number];

/** What `captureLaser` reports. Every point is in the iframe's own pixels. */
export interface LaserCapture {
  down: (point: FramePoint, pointerId: number) => void;
  move: (points: FramePoint[], pointerId: number) => void;
  up: (pointerId: number) => void;
  /** Where the dot belongs — `null` once the pointer is off the drawing. */
  hover: (point: FramePoint | null) => void;
  /** Escape, pressed inside the editor while nothing of the editor's own wanted it. */
  escape: () => void;
}

/**
 * Takes the presses that land on the drawing for the laser, and nothing else.
 *
 * **Inside the editor's document, in the capture phase of its window**, which is the first thing to
 * see any event there — before mxGraph's listeners on the canvas, and before `forwardFramePresses`
 * on the document, so this repeats the press to the app itself (`echoPress`). Laying a surface over
 * the iframe would have been simpler and wrong: draw.io's menus and dialogs open *across* the
 * drawing, and a surface over the frame would lie over them too and draw where the user meant to
 * click. Here a press is taken only when its target is inside the drawing, so the toolbar, the
 * panels, every menu and dialog work as before, and the wheel is left alone entirely — scrolling and
 * zooming still do what they do, laser or not.
 *
 * Both event families are taken, because draw.io binds one or the other by platform — mouse events
 * on macOS, pointer events elsewhere (see `forwardFramePresses`) — plus the clicks a press still
 * produces and the context menu. Moves over the drawing are taken even with no button down, so its
 * hover affordances (the blue connection arrows, the tooltips) do not light up under the laser.
 *
 * Returns the release, which also lets go of a stroke still being drawn.
 */
export function captureLaser(frame: HTMLIFrameElement | null, laser: LaserCapture): () => void {
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument;
  const drawing = doc?.querySelector(".geDiagramContainer");
  if (!frame || !win || !doc || !drawing) return () => {};

  ensureToolbarStyle(doc);
  doc.documentElement.setAttribute(LASER_ON, "");

  /** The pointer drawing a stroke, or `null`. */
  let live: number | null = null;
  /**
   * A right-button drag on the drawing, let through: draw.io pans with the right button (and opens
   * its menu when nothing moved), so the laser keeps the way around the drawing (user ask). Cleared
   * a tick after its release, once the mouse events that follow the pointer ones have gone by too —
   * mxGraph listens to those on macOS.
   */
  let panning: number | null = null;
  const onDrawing = (target: EventTarget | null) =>
    target !== null && "nodeType" in target && drawing.contains(target as Node);
  const at = (event: { clientX: number; clientY: number }): FramePoint => [event.clientX, event.clientY];
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const release = (pointerId: number) => {
    if (live !== pointerId) return;
    live = null;
    laser.up(pointerId);
  };

  const onDown = (event: PointerEvent) => {
    if (!onDrawing(event.target)) return;
    if (event.button === 2 && live === null) {
      panning = event.pointerId;
      laser.hover(null);
      echoPress(frame, event);
      return;
    }
    swallow(event);
    echoPress(frame, event);
    if (event.button !== 0 || live !== null) return;
    live = event.pointerId;
    // Captured, so a stroke that wanders over the toolbar — or out of the frame — keeps drawing,
    // and its release is heard wherever it happens.
    try {
      drawing.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer knows. The stroke still draws while it stays on the canvas.
    }
    laser.hover(at(event));
    laser.down(at(event), event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (panning !== null) return;
    if (event.pointerId === live) {
      event.stopImmediatePropagation();
      // Every sample the browser merged into this event — see `LaserLayer`.
      const merged = event.getCoalescedEvents?.() ?? [];
      laser.move((merged.length > 0 ? merged : [event]).map(at), event.pointerId);
      laser.hover(at(event));
      return;
    }
    if (!onDrawing(event.target)) {
      laser.hover(null);
      return;
    }
    event.stopImmediatePropagation();
    laser.hover(at(event));
  };
  const onUp = (event: PointerEvent) => {
    if (panning !== null) {
      if (event.pointerId === panning) win.setTimeout(() => (panning = null), 0);
      return;
    }
    if (event.pointerId !== live) {
      if (onDrawing(event.target)) swallow(event);
      return;
    }
    swallow(event);
    release(event.pointerId);
  };
  const onMouse = (event: Event) => {
    if (panning !== null) return;
    if (live !== null || onDrawing(event.target)) swallow(event);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    // A menu or a dialog of the editor's own is nearer, and answers it first.
    const open = doc.querySelectorAll(".mxPopupMenu, .geDialog");
    if ([...open].some((node) => node.getClientRects().length > 0)) return;
    swallow(event);
    laser.escape();
  };
  const onOut = (event: PointerEvent) => {
    // Out of the frame altogether. Mid-stroke the capture keeps the events coming, and the dot with
    // them.
    if (event.relatedTarget === null && live === null) laser.hover(null);
  };
  const onLost = (event: PointerEvent) => release(event.pointerId);

  const listeners: [string, EventListener][] = [
    ["pointerdown", onDown as EventListener],
    ["pointermove", onMove as EventListener],
    ["pointerup", onUp as EventListener],
    ["pointercancel", onUp as EventListener],
    ["pointerout", onOut as EventListener],
    ["mousedown", onMouse],
    ["mousemove", onMouse],
    ["mouseup", onMouse],
    ["click", onMouse],
    ["dblclick", onMouse],
    ["contextmenu", onMouse],
    ["keydown", onKey as EventListener],
  ];
  for (const [type, listener] of listeners) win.addEventListener(type, listener, true);
  // A capture can end without a `pointerup` reaching here — the window losing focus mid-stroke —
  // and a stroke nobody releases is one that never fades.
  drawing.addEventListener("lostpointercapture", onLost as EventListener);

  return () => {
    for (const [type, listener] of listeners) win.removeEventListener(type, listener, true);
    drawing.removeEventListener("lostpointercapture", onLost as EventListener);
    doc.documentElement.removeAttribute(LASER_ON);
    if (live !== null) {
      try {
        drawing.releasePointerCapture(live);
      } catch {
        // Already gone with the pointer.
      }
      release(live);
    }
    laser.hover(null);
  };
}
