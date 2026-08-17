/**
 * The brand mark for each service the app names — the AI engines, and the platforms it integrates
 * with. One map because the drawing problem is identical and the ids never collide; two sections
 * because the two are chosen in different screens.
 *
 * **Copied, not fetched.** The ones marked `logos:…` below are verbatim from
 * `@iconify-json/logos` v1.2.12 (the gilbarbara/logos set, CC0-1.0) — the same package
 * `icons/catalog.ts` already loads for the file-icon picker. One more (`devicon:azuredevops`, MIT)
 * is verbatim from a set this app does not install, because `logos` has no Azure DevOps mark. They are *bundled* rather than read
 * through that catalogue because it fetches the whole 7.45 MB set on the first `logos:` id anyone
 * asks for, and these marks are everyday chrome: the providers list, the chat's model picker, the
 * review tag, the quota panel, every agent row. Downloading a set the size of the app to paint a
 * 14px glyph is not a trade worth making. Together they cost a few kilobytes.
 *
 * Redrawing them by hand was the other option and is the one `dbChrome` rules out for the database
 * engines ("five trademarks redrawn by hand is a licensing question rather than a design one").
 * Taking them from a CC0 set sidesteps that for the five: the geometry is the official artwork, not
 * an approximation of it.
 *
 * **To refresh one**, or to add a provider that the set has since gained: find it in
 * `node_modules/@iconify-json/logos/icons.json` and copy `body`, plus `width`/`height` — which
 * default to the set's 256 when the icon omits them, and are the viewBox `ProviderGlyph` draws in.
 *
 * Keyed by the id each registry already uses — `aiProviders.ts` for the engines,
 * `vcsProviders.ts` for the platforms — so nothing needs a lookup table. Anything with no entry
 * here keeps the Lucide icon its own registry gives it.
 *
 * **Two of them are not from that set, and are marked as such below.** Neither Cline nor opencode
 * ships a logo anywhere reachable — not in the `logos` set, not in either npm package — so those
 * two are drawn here from the artwork the user supplied, which is the same exception
 * `icons/localSet.ts` records for the IRIS mark: an explicit request, naming the product whose
 * rows it marks. **Their geometry is an approximation**, and replacing it is one field: drop the
 * official SVG's paths into `body` and keep `width`/`height` in step with its viewBox.
 *
 * **Monochrome marks carry no fill of their own** (OpenAI's flower, xAI's slash): they inherit
 * `fill` from the element they are drawn in, which is why `ProviderGlyph` sets `currentColor`.
 * Without it they would be black, and invisible on a dark theme.
 */
export interface BrandLogo {
  /** Inner SVG markup, from the source set. Never built from user input — which is what makes
   * rendering it with `dangerouslySetInnerHTML` safe, the same argument `CatalogGlyph` makes. */
  body: string;
  /** The viewBox this was drawn in. */
  width: number;
  height: number;
}

export const BRAND_LOGOS: Record<string, BrandLogo> = {
  /**
   * `logos:claude-icon`.
   *
   * Anthropic's mark, in its own clay orange — the one colour here that needs no help from the
   * theme.
   */
  claude: {
    width: 256,
    height: 257,
    body:
      "<path fill=\"#d97757\" d=\"m50.228 170.321l50.357-28.257l.843-2.463l-.843-1.361h-2.462l-8.426-.518l-28.775-.778l-24.952-1.037l-24.175-1.296l-6.092-1.297L0 125.796l.583-3.759l5.12-3.434l7.324.648l16.202 1.101l24.304 1.685l17.629 1.037l26.118 2.722h4.148l.583-1.685l-1.426-1.037l-1.101-1.037l-25.147-17.045l-27.22-18.017l-14.258-10.37l-7.713-5.25l-3.888-4.925l-1.685-10.758l7-7.713l9.397.649l2.398.648l9.527 7.323l20.35 15.75L94.817 91.9l3.889 3.24l1.555-1.102l.195-.777l-1.75-2.917l-14.453-26.118l-15.425-26.572l-6.87-11.018l-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0l10.63 1.426l4.472 3.888l6.61 15.101l10.694 23.786l16.591 32.34l4.861 9.592l2.592 8.879l.973 2.722h1.685v-1.556l1.36-18.211l2.528-22.36l2.463-28.776l.843-8.1l4.018-9.722l7.971-5.25l6.222 2.981l5.12 7.324l-.713 4.73l-3.046 19.768l-5.962 30.98l-3.889 20.739h2.268l2.593-2.593l10.499-13.934l17.628-22.036l7.778-8.749l9.073-9.657l5.833-4.601h11.018l8.1 12.055l-3.628 12.443l-11.342 14.388l-9.398 12.184l-13.48 18.147l-8.426 14.518l.778 1.166l2.01-.194l30.46-6.481l16.462-2.982l19.637-3.37l8.88 4.148l.971 4.213l-3.5 8.62l-20.998 5.184l-24.628 4.926l-36.682 8.685l-.454.324l.519.648l16.526 1.555l7.065.389h17.304l32.21 2.398l8.426 5.574l5.055 6.805l-.843 5.184l-12.962 6.611l-17.498-4.148l-40.83-9.721l-14-3.5h-1.944v1.167l11.666 11.406l21.387 19.314l26.767 24.887l1.36 6.157l-3.434 4.86l-3.63-.518l-23.526-17.693l-9.073-7.972l-20.545-17.304h-1.36v1.814l4.73 6.935l25.017 37.59l1.296 11.536l-1.814 3.76l-6.481 2.268l-7.13-1.297l-14.647-20.544l-15.1-23.138l-12.185-20.739l-1.49.843l-7.194 77.448l-3.37 3.953l-7.778 2.981l-6.48-4.925l-3.436-7.972l3.435-15.749l4.148-20.544l3.37-16.333l3.046-20.285l1.815-6.74l-.13-.454l-1.49.194l-15.295 20.999l-23.267 31.433l-18.406 19.702l-4.407 1.75l-7.648-3.954l.713-7.064l4.277-6.286l25.47-32.405l15.36-20.092l9.917-11.6l-.065-1.686h-.583L44.07 198.125l-12.055 1.555l-5.185-4.86l.648-7.972l2.463-2.593l20.35-13.999z\"/>",
  },
  /**
   * `logos:google-bard-icon`.
   *
   * The Gemini spark. Filed under Bard in the set — the product was renamed, the mark was not —
   * and it is the *icon* variant on purpose: `logos:google-gemini` is the spark plus the wordmark
   * at 512x188, which in a 14px slot is a legible spark and four unreadable letters.
   */
  gemini: {
    width: 256,
    height: 258,
    body:
      "<defs>" +
      "<radialGradient id=\"SVG1xuhSd8h\" cx=\"78.302%\" cy=\"55.52%\" r=\"78.115%\" fx=\"78.302%\" fy=\"55.52%\" gradientTransform=\"matrix(.19314 .98115 -.98064 .19324 1.176 -.32)\">" +
      "<stop offset=\"0%\" stop-color=\"#1ba1e3\"/><stop offset=\".01%\" stop-color=\"#1ba1e3\"/>" +
      "<stop offset=\"30.022%\" stop-color=\"#5489d6\"/><stop offset=\"54.552%\" stop-color=\"#9b72cb\"/>" +
      "<stop offset=\"82.537%\" stop-color=\"#d96570\"/><stop offset=\"100%\" stop-color=\"#f49c46\"/>" +
      "</radialGradient>" +
      "<radialGradient id=\"SVGm6NA5dhq\" cx=\"-3.409%\" cy=\"-54.219%\" r=\"169.363%\" fx=\"-3.409%\" fy=\"-54.219%\" gradientTransform=\"matrix(.19314 .98115 -.98062 .19324 -.56 -.404)\">" +
      "<stop offset=\"0%\" stop-color=\"#1ba1e3\"/><stop offset=\".01%\" stop-color=\"#1ba1e3\"/>" +
      "<stop offset=\"30.022%\" stop-color=\"#5489d6\"/><stop offset=\"54.552%\" stop-color=\"#9b72cb\"/>" +
      "<stop offset=\"82.537%\" stop-color=\"#d96570\"/><stop offset=\"100%\" stop-color=\"#f49c46\"/>" +
      "</radialGradient></defs>" +
      "<path fill=\"url(#SVG1xuhSd8h)\" d=\"m122.062 172.77l-10.27 23.52c-3.947 9.042-16.459 9.042-20.406 0l-10.27-23.52c-9.14-20.933-25.59-37.595-46.108-46.703L6.74 113.52c-8.987-3.99-8.987-17.064 0-21.053l27.385-12.156C55.172 70.97 71.917 53.69 80.9 32.043L91.303 6.977c3.86-9.303 16.712-9.303 20.573 0l10.403 25.066c8.983 21.646 25.728 38.926 46.775 48.268l27.384 12.156c8.987 3.99 8.987 17.063 0 21.053l-28.267 12.547c-20.52 9.108-36.97 25.77-46.109 46.703\"/>" +
      "<path fill=\"url(#SVGm6NA5dhq)\" d=\"m217.5 246.937l-2.888 6.62c-2.114 4.845-8.824 4.845-10.937 0l-2.889-6.62c-5.148-11.803-14.42-21.2-25.992-26.34l-8.898-3.954c-4.811-2.137-4.811-9.131 0-11.269l8.4-3.733c11.87-5.273 21.308-15.017 26.368-27.22l2.966-7.154c2.067-4.985 8.96-4.985 11.027 0l2.966 7.153c5.06 12.204 14.499 21.948 26.368 27.221l8.4 3.733c4.812 2.138 4.812 9.132 0 11.27l-8.898 3.953c-11.571 5.14-20.844 14.537-25.992 26.34\"/>",
  },
  /**
   * `logos:openai-icon`.
   *
   * Codex is OpenAI's CLI, so it wears OpenAI's mark. Deliberately the same glyph as the `openai`
   * row below: they are the same company, and inventing a difference would be the misleading choice.
   */
  codex: {
    width: 256,
    height: 260,
    body:
      "<path d=\"M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z\"/>",
  },
  /** `logos:openai-icon`. */
  openai: {
    width: 256,
    height: 260,
    body:
      "<path d=\"M239.184 106.203a64.72 64.72 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.72 64.72 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.67 64.67 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.77 64.77 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483m-97.56 136.338a48.4 48.4 0 0 1-31.105-11.255l1.535-.87l51.67-29.825a8.6 8.6 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601M37.158 197.93a48.35 48.35 0 0 1-5.781-32.589l1.534.921l51.722 29.826a8.34 8.34 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803M23.549 85.38a48.5 48.5 0 0 1 25.58-21.333v61.39a8.29 8.29 0 0 0 4.195 7.316l62.874 36.272l-21.845 12.636a.82.82 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405zm179.466 41.695l-63.08-36.63L161.73 77.86a.82.82 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.54 8.54 0 0 0-4.4-7.213m21.742-32.69l-1.535-.922l-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.72.72 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391zM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87l-51.67 29.825a8.6 8.6 0 0 0-4.246 7.367zm11.868-25.58L128.067 97.3l28.188 16.218v32.434l-28.086 16.218l-28.188-16.218z\"/>",
  },
  /**
   * `logos:grok-icon`.
   *
   * xAI's slash. Monochrome with no fill of its own, like OpenAI's — see the note on `currentColor`.
   */
  grok: {
    width: 256,
    height: 246,
    body:
      "<path d=\"M63.83 56.843c27.469-27.48 67.635-34.865 101.712-21.87l2.314.917c7.645 2.844 14.309 6.89 19.507 10.651l-28.857 13.342c-26.869-11.286-57.649-3.609-76.435 15.2c-25.405 25.414-30.539 69.484-.764 97.96L0 245.764c4.296-5.923 9.457-11.573 14.75-17.178l5.815-6.13l2.608-2.774c15.53-16.655 28.81-33.77 20.496-56.709l-.766-1.98c-14.592-35.497-6.094-77.096 20.928-104.15m156.956-21.587L256 0l-10.128 14.069c-21.094 29.716-30.456 48.424-21.11 88.659l-.065-.065c7.23 30.728-.503 64.803-25.472 89.802c-31.478 31.538-81.852 38.558-123.336 10.17l28.923-13.407c26.476 10.41 55.442 5.839 76.26-15.003c20.818-20.844 25.493-51.2 15.03-76.462c-1.989-4.79-7.952-5.992-12.125-2.909L98.87 157.755L220.786 35.147z\"/>",
  },
  /**
   * **Drawn here, not from the `logos` set** — Cline ships no mark anywhere reachable. Redrawn
   * from the artwork the user supplied: the robot head, its two ears, and the two eyes.
   *
   * The eyes and the screen of `opencode` below are *holes* (`fill-rule="evenodd"`), not white
   * shapes. That is what keeps them right in both themes: a white eye would disappear the moment
   * the head turned light, while a hole always shows whatever the row is painted on.
   */
  cline: {
    width: 256,
    height: 256,
    body:
      "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M30 136A40 40 0 0 1 70 96H72A26 26 0 0 1 124 96H132A26 26 0 0 1 184 96H186A40 40 0 0 1 226 136V174A40 40 0 0 1 186 214H70A40 40 0 0 1 30 174ZM98 132A12 12 0 0 0 86 144V166A12 12 0 0 0 110 166V144A12 12 0 0 0 98 132ZM158 132A12 12 0 0 0 146 144V166A12 12 0 0 0 170 166V144A12 12 0 0 0 158 132Z\"/>",
  },
  /**
   * **Drawn here, not from the `logos` set** — same as Cline above. Redrawn from the supplied
   * artwork: the frame, with the wider mount along the bottom, around a hollow screen.
   */
  opencode: {
    width: 256,
    height: 256,
    body:
      "<path fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M64 20H192A20 20 0 0 1 212 40V216A20 20 0 0 1 192 236H64A20 20 0 0 1 44 216V40A20 20 0 0 1 64 20ZM76 56V166A6 6 0 0 0 82 172H174A6 6 0 0 0 180 166V56A6 6 0 0 0 174 50H82A6 6 0 0 0 76 56Z\"/>",
  },

  // ---------------------------------------------------------------------------
  // The platforms `vcsProviders.ts` lists — repositories, pull requests and boards.
  //
  // Four come from `logos` like the engines above. **Azure DevOps comes from Devicon** (MIT,
  // github.com/devicons/devicon) because `logos` has no Azure DevOps mark and its nearest
  // neighbour, `logos:microsoft-azure`, is a *different product's* logo — Azure the cloud. Drawing
  // it by hand was tried first and thrown away: it did not read as the mark.
  // ---------------------------------------------------------------------------

  /**
   * `devicon:azuredevops` — the one entry not from the `logos` set, for the reason above.
   *
   * Verbatim, gradient id included: `BrandGlyph` scopes that id per instance, so the opaque name
   * is harmless and keeping it means this is a copy rather than an edit.
   */
  azure: {
    width: 128,
    height: 128,
    body:
      "<defs><linearGradient id=\"SVG6uMEBcPj\" x1=\"9\" x2=\"9\" y1=\"16.97\" y2=\"1.03\" " +
      "gradientTransform=\"scale(7.11111)\" gradientUnits=\"userSpaceOnUse\">" +
      "<stop offset=\"0\" stop-color=\"#0078d4\"/><stop offset=\".16\" stop-color=\"#1380da\"/>" +
      "<stop offset=\".53\" stop-color=\"#3c91e5\"/><stop offset=\".82\" stop-color=\"#559cec\"/>" +
      "<stop offset=\"1\" stop-color=\"#5ea0ef\"/></linearGradient></defs>" +
      "<path fill=\"url(#SVG6uMEBcPj)\" d=\"M120.89 28.445v69.262l-28.445 23.324l-44.09-16.07v15.93" +
      "L23.395 88.25l72.746 5.688V31.574ZM96.64 31.93L55.82 7.11v16.285L18.348 34.418L7.109 48.852" +
      "v32.785l16.075 7.11V46.718Zm0 0\"/>",
  },
  /**
   * `logos:github-icon`.
   *
   * GitHub's Octocat. **Its one hardcoded fill is stripped** so the mark inherits `currentColor`:
   * the source paints it `#161614`, which on a dark row is black on near-black. The mark is
   * monochrome by design — GitHub renders it in the surrounding text colour too — so this loses
   * nothing but the assumption that the page is white.
   */
  github: {
    width: 256,
    height: 250,
    body:
      "<path d=\"M128.001 0C57.317 0 0 57.307 0 128.001c0 56.554 36.676 104.535 87.535 121.46c6.397 1.185 8.746-2.777 8.746-6.158c0-3.052-.12-13.135-.174-23.83c-35.61 7.742-43.124-15.103-43.124-15.103c-5.823-14.795-14.213-18.73-14.213-18.73c-11.613-7.944.876-7.78.876-7.78c12.853.902 19.621 13.19 19.621 13.19c11.417 19.568 29.945 13.911 37.249 10.64c1.149-8.272 4.466-13.92 8.127-17.116c-28.431-3.236-58.318-14.212-58.318-63.258c0-13.975 5-25.394 13.188-34.358c-1.329-3.224-5.71-16.242 1.24-33.874c0 0 10.749-3.44 35.21 13.121c10.21-2.836 21.16-4.258 32.038-4.307c10.878.049 21.837 1.47 32.066 4.307c24.431-16.56 35.165-13.12 35.165-13.12c6.967 17.63 2.584 30.65 1.255 33.873c8.207 8.964 13.173 20.383 13.173 34.358c0 49.163-29.944 59.988-58.447 63.157c4.591 3.972 8.682 11.762 8.682 23.704c0 17.126-.148 30.91-.148 35.126c0 3.407 2.304 7.398 8.792 6.14C219.37 232.5 256 184.537 256 128.002C256 57.307 198.691 0 128.001 0m-80.06 182.34c-.282.636-1.283.827-2.194.39c-.929-.417-1.45-1.284-1.15-1.922c.276-.655 1.279-.838 2.205-.399c.93.418 1.46 1.293 1.139 1.931m6.296 5.618c-.61.566-1.804.303-2.614-.591c-.837-.892-.994-2.086-.375-2.66c.63-.566 1.787-.301 2.626.591c.838.903 1 2.088.363 2.66m4.32 7.188c-.785.545-2.067.034-2.86-1.104c-.784-1.138-.784-2.503.017-3.05c.795-.547 2.058-.055 2.861 1.075c.782 1.157.782 2.522-.019 3.08m7.304 8.325c-.701.774-2.196.566-3.29-.49c-1.119-1.032-1.43-2.496-.726-3.27c.71-.776 2.213-.558 3.315.49c1.11 1.03 1.45 2.505.701 3.27m9.442 2.81c-.31 1.003-1.75 1.459-3.199 1.033c-1.448-.439-2.395-1.613-2.103-2.626c.301-1.01 1.747-1.484 3.207-1.028c1.446.436 2.396 1.602 2.095 2.622m10.744 1.193c.036 1.055-1.193 1.93-2.715 1.95c-1.53.034-2.769-.82-2.786-1.86c0-1.065 1.202-1.932 2.733-1.958c1.522-.03 2.768.818 2.768 1.868m10.555-.405c.182 1.03-.875 2.088-2.387 2.37c-1.485.271-2.861-.365-3.05-1.386c-.184-1.056.893-2.114 2.376-2.387c1.514-.263 2.868.356 3.061 1.403\"/>",
  },
  /**
   * `logos:gitlab-icon`.
   *
   * The fox, in its own oranges. Deliberately the icon and not `logos:gitlab`, which is the fox plus
   * the wordmark at 512x111 — four unreadable letters in a 13px slot.
   */
  gitlab: {
    width: 256,
    height: 247,
    body:
      "<path fill=\"#e24329\" d=\"m251.845 97.642l-.328-.986l-34.85-90.903c-.657-1.808-1.972-3.287-3.616-4.274Q210.586 0 207.627 0c-1.973 0-3.78.822-5.26 1.973a8.73 8.73 0 0 0-3.124 4.767l-23.506 71.999H80.56l-23.506-72c-.493-1.808-1.644-3.451-3.123-4.766C52.45.822 50.643 0 48.67 0s-3.781.329-5.425 1.48c-1.644.986-2.96 2.465-3.617 4.273L4.781 96.656l-.33.986c-10.355 26.959-1.479 57.37 21.535 74.794h.328c0 .164 53.096 39.944 53.096 39.944l26.3 19.89l15.946 12c3.78 2.96 9.205 2.96 12.986 0l15.945-12l26.3-19.89l53.424-39.944c23.014-17.425 31.726-47.835 21.37-74.794z\"/>" +
      "<path fill=\"#fc6d26\" d=\"m251.845 97.642l-.328-.986c-17.26 3.616-33.205 10.85-46.849 21.04c-.164 0-41.424 31.398-76.602 57.863a18377 18377 0 0 0 48.657 36.821l53.424-39.944c23.013-17.425 31.726-47.835 21.37-74.794z\"/>" +
      "<path fill=\"#fca326\" d=\"m79.245 212.38l26.301 19.89l15.945 12c3.78 2.96 9.206 2.96 12.986 0l15.945-12l26.301-19.89s-22.684-17.095-48.657-36.82c-26.136 19.725-48.82 36.82-48.82 36.82\"/>" +
      "<path fill=\"#fc6d26\" d=\"M51.465 117.697c-13.644-10.192-29.589-17.589-46.849-21.04l-.329.985c-10.356 26.959-1.479 57.37 21.534 74.794h.33c0 .164 53.094 39.944 53.094 39.944s22.685-17.095 48.821-36.82c-35.013-26.466-76.272-57.699-76.601-57.863\"/>",
  },
  /**
   * `logos:jira`.
   *
   * Atlassian's Jira mark, gradients and all. Its `<linearGradient>` ids are scoped per instance by
   * `BrandGlyph` — see the note there on why that matters.
   */
  jira: {
    width: 256,
    height: 256,
    body:
      "<defs><linearGradient id=\"SVGSBI7obaC\" x1=\"98.031%\" x2=\"58.888%\" y1=\".161%\" y2=\"40.766%\">" +
      "<stop offset=\"18%\" stop-color=\"#0052cc\"/><stop offset=\"100%\" stop-color=\"#2684ff\"/>" +
      "</linearGradient>" +
      "<linearGradient id=\"SVGHifZlbzE\" x1=\"100.665%\" x2=\"55.402%\" y1=\".455%\" y2=\"44.727%\">" +
      "<stop offset=\"18%\" stop-color=\"#0052cc\"/><stop offset=\"100%\" stop-color=\"#2684ff\"/>" +
      "</linearGradient></defs>" +
      "<path fill=\"#2684ff\" d=\"M244.658 0H121.707a55.5 55.5 0 0 0 55.502 55.502h22.649V77.37c.02 30.625 24.841 55.447 55.466 55.467V10.666C255.324 4.777 250.55 0 244.658 0\"/>" +
      "<path fill=\"url(#SVGSBI7obaC)\" d=\"M183.822 61.262H60.872c.019 30.625 24.84 55.447 55.466 55.467h22.649v21.938c.039 30.625 24.877 55.43 55.502 55.43V71.93c0-5.891-4.776-10.667-10.667-10.667\"/>" +
      "<path fill=\"url(#SVGHifZlbzE)\" d=\"M122.951 122.489H0c0 30.653 24.85 55.502 55.502 55.502h22.72v21.867c.02 30.597 24.798 55.408 55.396 55.466V133.156c0-5.891-4.776-10.667-10.667-10.667\"/>",
  },
  /**
   * `logos:monday-icon`.
   *
   * monday.com's three strokes, in their own red/yellow/green.
   */
  monday: {
    width: 256,
    height: 156,
    body:
      "<path fill=\"#f62b54\" d=\"M31.846 153.489a31.97 31.97 0 0 1-27.86-16.167a30.91 30.91 0 0 1 .875-31.823l57.373-90.096A31.99 31.99 0 0 1 90.556.015a31.93 31.93 0 0 1 27.41 16.896c5.349 10.113 4.68 22.28-1.725 31.774L58.904 138.78a31.98 31.98 0 0 1-27.058 14.709\"/>" +
      "<path fill=\"#fc0\" d=\"M130.256 153.488c-11.572 0-22.22-6.187-27.812-16.13a30.81 30.81 0 0 1 .875-31.737l57.264-89.89A31.94 31.94 0 0 1 188.93.016c11.669.255 22.244 6.782 27.592 16.993a30.81 30.81 0 0 1-2.066 31.92l-57.252 89.889a31.93 31.93 0 0 1-26.948 14.671\"/>" +
      "<ellipse cx=\"226.466\" cy=\"125.324\" fill=\"#00ca72\" rx=\"29.538\" ry=\"28.918\"/>",
  },
};
