import { readFileSync, rmSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const OUT_DIR = "src-tauri/resources/mobile";

/**
 * Emits the entry as `index.html`, and clears last build's hashed assets.
 *
 * # The rename
 *
 * The source file is `mobile.html` because it sits at the repository root beside `index.html`, the
 * desktop's own entry, and two files cannot both be called that. But the *output* has to be
 * `index.html`: the server hands this directory to `ServeDir`, which looks for that name when a
 * browser asks for `/`, and it is what the SPA fallback points at. Renaming here is three lines;
 * teaching the server about a differently-named entry would be a special case living forever in
 * Rust to explain a detail of the JavaScript build.
 *
 * `enforce: "post"` is load-bearing. Vite's own HTML plugin emits `mobile.html` during
 * `generateBundle`, so a plugin in the default phase runs *before* the file it is looking for
 * exists and silently does nothing — which is exactly what happened the first time.
 *
 * # The sweep
 *
 * `build.emptyOutDir` would be the obvious way to stop old hashed chunks piling up, and it cannot
 * be used: this directory also holds `README.md`, which is committed and must survive, because
 * `tauri.conf.json` lists the directory under `bundle.resources` and `tauri-build` refuses to
 * compile when a configured resource path does not exist. Emptying the directory would delete the
 * one file that keeps it in git, so a build would break `cargo check` on the next fresh clone.
 *
 * Clearing `assets/` alone gets both: nothing stale accumulates, and the README is untouched.
 * `index.html` needs no sweeping — it is overwritten under a fixed name every build.
 */
function mobileBundle(): Plugin {
  return {
    name: "codeflow-mobile-bundle",
    enforce: "post",
    buildStart() {
      rmSync(`${OUT_DIR}/assets`, { recursive: true, force: true });
      // The snapshots Tauri copied next to the binary, swept for the same reason.
      //
      // These are not bundler inputs and never reach an installer, so they cost nothing but disk —
      // and they cost correctness locally: a debug server now prefers the source tree (see
      // `mobile_dir` in `server.rs`), but a phone still holding an old page asks for old hashed
      // chunk names, and finding them here is what made a version skew *look* fine while serving a
      // mix of two builds. Sweeping means a stale request 404s, which is what the client's reload
      // check is listening for.
      for (const profile of ["debug", "release"]) {
        rmSync(`src-tauri/target/${profile}/mobile/assets`, { recursive: true, force: true });
      }
    },
    generateBundle(_options, bundle) {
      const entry = bundle["mobile.html"];
      if (!entry) {
        this.warn("mobile.html was not emitted — the output will have no index.html");
        return;
      }
      delete bundle["mobile.html"];
      entry.fileName = "index.html";
      bundle["index.html"] = entry;

      // The install metadata, at fixed unhashed names because `manifest.webmanifest` references
      // `/icon-512.png` by path and the HTML references the manifest by path.
      //
      // This is what gives **Android** what the `apple-mobile-web-app-*` meta tags in the HTML
      // give iOS. Those tags are Safari-only: without a manifest, "Añadir a pantalla de inicio" on
      // Android produces a plain bookmark that opens in a Chrome tab with the address bar showing,
      // rather than a standalone window with an icon. Two platforms, two mechanisms, and both are
      // needed for the same result.
      //
      // The icon is the app's own 512×512, read straight from where Tauri already keeps it. No
      // resizing step and no second copy in git: 512 is the largest size any installer asks for,
      // and every consumer downscales.
      this.emitFile({
        type: "asset",
        fileName: "manifest.webmanifest",
        source: readFileSync("src/mobile/manifest.webmanifest"),
      });
      this.emitFile({
        type: "asset",
        fileName: "icon-512.png",
        source: readFileSync("src-tauri/icons/icon.png"),
      });
    },
  };
}

/**
 * The mobile client's build — a second, independent Vite project in the same repository.
 *
 * # Why not a second entry in `vite.config.ts`
 *
 * Rollup's `manualChunks` there is tuned for the desktop bundle and is load-bearing: its first rule
 * exists to keep 4 MB of Monaco off the boot path, and it is written against the assumption that
 * every entry is the desktop one. Adding a second input would put the mobile client under those
 * same rules — sharing a `vendor` chunk with a desktop app it has nothing in common with — and
 * would make the desktop's carefully-checked preload list something that changes when a phone
 * screen is edited.
 *
 * Two configs cost a second `pnpm` script. One config would cost every future change to either
 * bundle a check against the other.
 *
 * # What the two builds share
 *
 * Types (`src/types/domain.ts`) and nothing else at runtime. That is on purpose: the type file is
 * the contract with the Rust side, and both clients call the same commands, so a field renamed in
 * Rust must break both at compile time. Everything else — strings, styles, state — is separate,
 * because the desktop's versions of all three are built for a screen this client does not have.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), mobileBundle()],
  // The repository root, so `/src/mobile/main.tsx` in `mobile.html` resolves and `src/types` is
  // reachable. `build.rollupOptions.input` is what makes this build the mobile page rather than
  // `index.html`.
  root: ".",
  // **Not** the default `public/`. Sharing a root with the desktop build means sharing its public
  // directory, which holds the ~98 MB draw.io webapp the Diagrams workspace embeds — all of it
  // copied into this bundle, and from there into the installer a second time. The mobile client
  // has no static assets of its own; everything it needs is imported.
  publicDir: false,
  build: {
    // Straight into the Tauri resource directory, which `tauri.conf.json` bundles and
    // `remotectl/server.rs` serves from. No copy step in between: a stale copy of a UI is worse
    // than no UI, because it fails in ways that look like backend bugs.
    outDir: OUT_DIR,
    // Deliberately off — `README.md` here is committed and must survive. See `mobileBundle`,
    // which sweeps `assets/` instead.
    emptyOutDir: false,
    rollupOptions: {
      input: "mobile.html",
      output: {
        // `index.html`, not `mobile.html`: the server serves this directory at `/`, so the file
        // the SPA fallback points at has to be the conventional name.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    // A separate port from the desktop dev server's 1420, so both can run at once.
    port: 1430,
    strictPort: true,
    // Reachable from the phone during development. The desktop's own dev server binds localhost
    // unless `TAURI_DEV_HOST` is set; this one has no reason not to, since the whole point of the
    // client is being opened from another device.
    host: true,
    proxy: {
      // Everything the client calls goes to the real server in the running app. This is what lets
      // the mobile UI be developed with HMR against a live CodeFlow — and it is why the Rust side
      // ships no CORS layer: there is no cross-origin request to allow, because the proxy makes
      // them same-origin. Change the port here if the server's was changed in settings.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        // The event stream is a WebSocket upgrade, which a plain HTTP proxy would drop.
        ws: true,
      },
    },
  },
});
