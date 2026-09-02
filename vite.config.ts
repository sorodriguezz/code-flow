import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Fails the build when the emitted chunks import each other in a cycle.
 *
 * A cycle between two chunks is not a style problem, it is a dead app. ES modules evaluate a
 * dependency before the importer's own body runs, so in a cycle one of the two chunks always
 * executes against the other's uninitialised bindings — and when one of them is `vendor`, what
 * that costs is react. There is no warning: rollup emits the cycle happily, the bundle is
 * well-formed, `tauri build` succeeds, the installer installs, and the window comes up blank with
 * a single `TypeError` in a console nobody sees because it is inside a packaged webview.
 *
 * That is precisely how 1.18.17 shipped. `manualChunks` above carries the post-mortem; this is the
 * part that makes the next one impossible to miss, because the invariant it protects used to be a
 * sentence in a comment asking whoever touched the chunking to go and check the build by hand.
 */
function assertNoChunkCycles(): Plugin {
  return {
    name: "assert-no-chunk-cycles",
    apply: "build",
    generateBundle(_options, bundle) {
      const importsOf = new Map<string, string[]>();
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type === "chunk") importsOf.set(fileName, output.imports);
      }

      // Static imports only. A *dynamic* edge back into an ancestor is the normal shape of a lazy
      // view and evaluates long after the entry has finished, so `dynamicImports` is left out on
      // purpose — including it would fail every build this app has ever produced.
      const VISITING = 1;
      const DONE = 2;
      const state = new Map<string, number>();
      const stack: string[] = [];

      const walk = (chunk: string) => {
        const seen = state.get(chunk);
        if (seen === DONE) return;
        if (seen === VISITING) {
          const cycle = [...stack.slice(stack.indexOf(chunk)), chunk].join(" → ");
          this.error(
            `Chunk cycle: ${cycle}\n` +
              "Two chunks that statically import each other leave one of them running against " +
              "the other's uninitialised bindings, which is a blank window at runtime rather than " +
              "a build error. Give the modules they share an explicit home in `manualChunks` — " +
              "the chunk both sides already depend on — instead of letting rollup place them.",
          );
        }
        state.set(chunk, VISITING);
        stack.push(chunk);
        for (const next of importsOf.get(chunk) ?? []) walk(next);
        stack.pop();
        state.set(chunk, DONE);
      };

      for (const chunk of importsOf.keys()) walk(chunk);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), assertNoChunkCycles()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // The app genuinely ships a code editor, a terminal emulator and a VNC client. Warning at
    // 500 kB just means a wall of warnings nobody reads; 1 MB is the size at which a chunk here
    // is actually worth a second look.
    chunkSizeWarningLimit: 1000,
    // Only in a debug build. A release build with sourcemaps writes ~20 MB of `.map` next to the
    // bundle and Tauri packages whatever is in `dist`.
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      // Two entries, not one. `window.html` is what a satellite window loads, and its whole reason
      // for existing is that the shell is not in its module graph: `src/satellite.tsx` never
      // reaches `Sidebar`, `AppRail`, `SettingsView`, `CommandPalette` or the guided tour, so none
      // of them can be fetched, parsed or held resident by a window that shows one thing.
      //
      // `mobile.html` is deliberately absent: it is built by `vite.mobile.config.ts` against a
      // different source tree and a different set of assumptions.
      input: {
        main: "index.html",
        window: "window.html",
      },
      output: {
        // Split by *lifetime*, not by size. Monaco, xterm and noVNC are behind dynamic imports
        // (`App` lazies the Editor, the terminal dock and the Remote view), so naming them here
        // keeps each one in a single file the browser can cache instead of letting Rollup smear
        // them across whichever entry chunks happen to reach them first. `vendor` is the opposite
        // case: react/zustand are on the boot path and change only when a dependency is bumped.
        //
        // # Why this is a function and not the `{ name: [packages] }` object it used to be
        //
        // The object form does not mean "put these packages in this chunk". It means "put these
        // packages *and every module they reach* in this chunk" — and what monaco reaches includes
        // Vite's own virtual `\0vite/preload-helper`, the `__vitePreload` function that every
        // chunk performing a dynamic `import()` needs. Filed under `monaco`, that one helper made
        // the entry chunk statically import 4 MB of editor to get a single function: the built
        // `index.html` carried `<link rel="modulepreload" href="/assets/monaco-*.js">` plus the
        // 162 KB `monaco-*.css`, so the whole editor was fetched, parsed and evaluated before the
        // first frame of *every* launch — including the majority of sessions that never open one.
        // In the emitted entry the entire edge looked like this, and nothing else:
        //
        //     import{_ as Me}from"./monaco-Dkc70ZHx.js"
        //
        // Which is why it survived making `main.tsx`, `apiStore`, `SplitFileDiff` and
        // `ConflictResolveModal` lazy: no source file was importing monaco any more, and the
        // preload was still there. Matching on module ids claims exactly the files named and
        // nothing else.
        //
        // The first rule below is the whole point and must stay first. Returning `undefined` for
        // the helper is *not* enough: an unassigned module is one Rollup then places itself, and
        // what it picks for a module shared by many chunks is a common ancestor — which, for a
        // helper whose heaviest user is monaco's own lazy language loading, was the monaco chunk
        // again. The helper has to be pinned somewhere the entry already depends on, and `vendor`
        // is that place: react is on the boot path by definition, so parking one function beside
        // it costs nothing and every other chunk imports it from there.
        //
        // The `node_modules` check keeps our own sources unassigned, so Rollup goes on splitting
        // them per lazy view, which is what the `React.lazy` calls in `App.tsx` are for.
        //
        // Order matters below it too: `@monaco-editor/react` must be matched before the react
        // rule, which would otherwise claim it for `vendor` and put the editor's React wrapper —
        // and through it the editor — back on the boot path.
        //
        // After touching any of this, check the build: `dist/index.html` must list only `vendor`
        // and `motion` under `modulepreload`, and must not link `monaco-*.css`.
        manualChunks(id: string) {
          if (id.includes("vite/preload-helper")) return "vendor";
          // `commonjsHelpers` is `getDefaultExportFromCjs` and essentially nothing else — the one
          // function react's own ESM facade calls to unwrap its CJS export. Pinned here for the
          // same reason as the line above it, and with the same consequence when it is not.
          if (id.includes("commonjsHelpers")) return "vendor";

          // `@rollup/plugin-commonjs` names the modules it generates after the file they wrap and
          // decorates the name with a `\0` prefix and a `?commonjs-…` suffix:
          //
          //     \0/…/node_modules/react/index.js?commonjs-module
          //
          // Those modules are where `requireReact()` and the `var React = …` facade actually live,
          // so they are react in every sense that matters to a chunking rule and have to land in
          // react's chunk. Undecorating the id is what lets the rules below claim them. Bailing
          // out on `\0` instead — which is what this did — left them unassigned, and that was the
          // whole of the 1.18.17 blank-window bug:
          //
          //   • With one entry, rollup's common-ancestor placement for an unassigned module
          //     happened to land on `vendor`, and nothing was visibly wrong.
          //   • Adding `window.html` as a second entry moved that ancestor, and it landed on
          //     `motion`. The built `vendor` then opened with `import{W as Xn}from"./motion-….js"`
          //     while `motion` opened with `import{r,a,g}from"./vendor-….js"` — a cycle. ES
          //     modules evaluate a dependency before the importer's own body, so `motion` ran
          //     first, called into `vendor` before `vendor` had initialised anything, and the app
          //     died on the first line it executed:
          //
          //         Uncaught TypeError: Cannot set properties of undefined (setting 'Fragment')
          //
          //     A blank window on every launch, with a clean start and a clean shutdown in the
          //     Rust log, because the whole failure is inside the webview.
          //
          // Matching on the file inside the id keeps each package's interop modules in that
          // package's own chunk, which is the only placement that cannot produce a cycle.
          // `assertNoChunkCycles` fails the build if one comes back anyway.
          const file = id
            .replace(/\0/g, "")
            .replace(/^commonjs-[a-z]+:/, "")
            .replace(/\?.*$/, "");

          if (!file.includes("node_modules")) return;
          if (file.includes("/monaco-editor/") || file.includes("/@monaco-editor/")) return "monaco";
          if (file.includes("/@xterm/")) return "xterm";
          if (file.includes("/@novnc/")) return "novnc";
          // `motion-dom` / `motion-utils` are framer-motion's own internals and nothing else
          // imports them. They came along for free under the object form; under this one they
          // have to be named, and they cannot be named as bare specifiers — pnpm does not hoist
          // a transitive dependency to the project root, which is why the old form could only
          // list `framer-motion`.
          if (
            file.includes("/framer-motion/") ||
            file.includes("/motion-dom/") ||
            file.includes("/motion-utils/")
          ) {
            return "motion";
          }
          if (
            file.includes("/react/") ||
            file.includes("/react-dom/") ||
            file.includes("/scheduler/") ||
            file.includes("/zustand/")
          ) {
            return "vendor";
          }
          return;
        },
      },
    },
    // No `target` key on purpose. The bundle currently contains zero downlevel helpers, so
    // lowering the target can only add them — and `src/index.css` uses `color-mix(in oklab, …)`,
    // which needs Safari 16.2+ anyway, so there is no older WebKit this could be built for.
    // `cssCodeSplit` is likewise left alone: it is on by default, and turning it off is the
    // opposite of what splitting the views was for.
  },
}));
