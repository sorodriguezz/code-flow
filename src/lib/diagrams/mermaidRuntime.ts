import type { Mermaid } from "mermaid";

/**
 * Mermaid, loaded on first use from the file the `mermaidRuntime` vite plugin serves beside the app.
 *
 * A `<script>` tag rather than an `import`, so the bundler never sees Mermaid — see the plugin in
 * `vite.config.ts` for why that matters. Loaded once per window; the promise is kept so concurrent
 * callers share the one load, and dropped on failure so the next attempt tries again.
 */

declare global {
  interface Window {
    mermaid?: Mermaid;
  }
}

let loading: Promise<Mermaid> | null = null;

function load(): Promise<Mermaid> {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (loading) return loading;
  loading = new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mermaid.min.js";
    script.async = true;
    script.onload = () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error("Mermaid did not load"));
    };
    script.onerror = () => reject(new Error("Mermaid could not be loaded"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

let configured: "dark" | "default" | null = null;
let serial = 0;

/**
 * Renders Mermaid source to an SVG string. Throws Mermaid's own parse error, whose message names
 * the line — the editor shows it as it is.
 *
 * `securityLevel: "strict"`: no click handlers and HTML labels sanitised, since a diagram may come
 * from a file someone else wrote.
 */
export async function renderMermaid(source: string, dark: boolean): Promise<string> {
  const mermaid = await load();
  const theme = dark ? "dark" : "default";
  if (configured !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "inherit",
      // Labels as SVG text, not HTML in a `<foreignObject>`: the PNG export draws the SVG on a canvas,
      // and HTML inside one taints it.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      // A parse error is the editor's to show, under the source; Mermaid's own bomb graphic is not.
      suppressErrorRendering: true,
    });
    configured = theme;
  }
  // Every render gets its own element id: Mermaid parks a scratch node under it while it measures,
  // and two renders in flight under one id would trip over each other's.
  const { svg } = await mermaid.render(`cf-mermaid-${++serial}`, source);
  return svg;
}
