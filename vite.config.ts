import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

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
          if (id.includes("\0")) return;
          if (!id.includes("node_modules")) return;
          if (id.includes("/monaco-editor/") || id.includes("/@monaco-editor/")) return "monaco";
          if (id.includes("/@xterm/")) return "xterm";
          if (id.includes("/@novnc/")) return "novnc";
          // `motion-dom` / `motion-utils` are framer-motion's own internals and nothing else
          // imports them. They came along for free under the object form; under this one they
          // have to be named, and they cannot be named as bare specifiers — pnpm does not hoist
          // a transitive dependency to the project root, which is why the old form could only
          // list `framer-motion`.
          if (
            id.includes("/framer-motion/") ||
            id.includes("/motion-dom/") ||
            id.includes("/motion-utils/")
          ) {
            return "motion";
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/") ||
            id.includes("/zustand/")
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
