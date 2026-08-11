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
        manualChunks: {
          monaco: ["monaco-editor", "@monaco-editor/react"],
          xterm: ["@xterm/xterm", "@xterm/addon-fit"],
          novnc: ["@novnc/novnc"],
          // `framer-motion` only. Its own `motion-dom`/`motion-utils` internals come with it —
          // nothing else in the app imports them, so Rollup files them under this chunk on its
          // own. Naming `motion-dom` explicitly is what you would expect to work and does not:
          // pnpm doesn't hoist a transitive dependency to the project root, so the bare specifier
          // is unresolvable from here and the build dies with "Could not resolve entry module".
          motion: ["framer-motion"],
          vendor: ["react", "react-dom", "zustand"],
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
