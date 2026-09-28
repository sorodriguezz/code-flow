/**
 * The Content-Security-Policy of the app's own pages — `index.html` (the main window) and
 * `window.html` (every satellite) — written into them as a `<meta>` at build time by
 * `vite.config.ts`.
 *
 * # Why this exists when every HTML sink already goes through DOMPurify
 *
 * Defence in depth, and the depth is unusually large here: the webview can invoke some 900 Tauri
 * commands, so a single injection that got past the sanitiser would run with the whole app's
 * power — the credential store, the terminal, the database. This policy is what makes such an
 * injection inert: no inline script runs, no script loads from anywhere but the bundle, and nothing
 * can be sent anywhere but IPC and the loopback bridges the app itself opens.
 *
 * # Why a `<meta>` at build time, and not Tauri's `security.csp`
 *
 * Tauri's own setting rewrites *every* HTML asset it serves — the bundled draw.io webapp under
 * `public/drawio` included, and that editor is built on inline scripts it cannot run without. The
 * meta is written only into the two entries Vite builds, so draw.io's pages (loaded from their own
 * URLs, never inheriting a parent's policy) and the phone's page (a different bundle, served by the
 * phone server) are untouched. And only at build: the dev server injects an inline React-refresh
 * preamble that no policy without `'unsafe-inline'` scripts would let run.
 *
 * # What each allowance is for — the audit
 *
 * Every source below is here because something the app does needs it; anything not listed is
 * refused. Kept as data rather than a string so the test beside this file can say which ones must
 * never appear.
 */
export const CSP_DIRECTIVES: Record<string, readonly string[]> = {
  "default-src": ["'self'"],
  // `'unsafe-eval'` is required, not convenience: the API client runs pre-request and test scripts
  // through `new Function` (`lib/api/sandbox.ts`), and the bundled quicktype and DBML parsers build
  // code the same way. `'unsafe-inline'` is what this policy exists to withhold, and nothing in the
  // two entries needs it: Vite emits every script as a file.
  "script-src": ["'self'", "'unsafe-eval'"],
  // Inline style *attributes* are how React, framer-motion and every positioned popover set a
  // coordinate, and Monaco and xterm inject `<style>` elements at runtime.
  "style-src": ["'self'", "'unsafe-inline'"],
  // `data:` for the rendered previews (a response's image, an SVG, a notebook's figure, a diagram
  // thumbnail), `blob:` for exports drawn through a canvas, `https:` for the pictures in rendered
  // markdown and in sandboxed HTML previews. The asset protocol is not registered today (no
  // `convertFileSrc`, no `assetProtocol` in `tauri.conf.json`); allowed for images and media so the
  // first feature that turns it on is not refused in silence.
  "img-src": ["'self'", "data:", "blob:", "https:", "asset:", "http://asset.localhost"],
  "media-src": ["'self'", "data:", "blob:", "asset:", "http://asset.localhost"],
  // The bundled Instrument Sans / JetBrains Mono subsets and Monaco's codicon font, all files in
  // the bundle; `data:` for any Vite chose to inline.
  "font-src": ["'self'", "data:"],
  // Tauri's IPC — `ipc://localhost` on macOS and Linux, `http://ipc.localhost` on Windows — and the
  // loopback WebSocket bridge noVNC reads a remote screen through (`remotes/wsbridge.rs`, bound to
  // 127.0.0.1 only). `'self'` covers the icon sets fetched from the bundle. Every other network call
  // the app makes is Rust's, so nothing here reaches beyond this machine.
  "connect-src": [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "ws://127.0.0.1:*",
    "ws://localhost:*",
    "data:",
    "blob:",
  ],
  // Monaco's language workers are bundle files; `blob:` for a worker built from a string.
  // `child-src` repeats it for WebKit builds that predate `worker-src`.
  "worker-src": ["'self'", "blob:"],
  "child-src": ["'self'", "blob:"],
  // The draw.io editor, served from this origin. The sandboxed `srcdoc` previews need no source —
  // and inherit this policy, which is why `https:` images are allowed above.
  "frame-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'none'"],
};

/** The policy as the `content` of a `<meta http-equiv="Content-Security-Policy">`. */
export function contentSecurityPolicy(directives = CSP_DIRECTIVES): string {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");
}
