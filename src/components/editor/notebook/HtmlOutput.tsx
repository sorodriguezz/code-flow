import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";

/** The tallest an HTML output grows before it scrolls inside itself. */
const MAX_HEIGHT = 1600;
const MIN_HEIGHT = 24;

export interface OutputPalette {
  scheme: "light" | "dark";
  text: string;
  muted: string;
  border: string;
  stripe: string;
  hover: string;
  accent: string;
}

/**
 * The stylesheet an HTML output is drawn with — what makes a pandas `DataFrame` look like part of
 * the app rather than like a 1998 web page: hairlines instead of a bordered grid, right-aligned
 * tabular figures, a faint stripe. `scope` is `body` inside the frame and a wrapper class in the
 * measuring copy, which is what keeps the two laid out identically.
 */
export function outputCss(scope: string, palette: OutputPalette): string {
  return `
${scope} { margin: 0; padding: 2px 0; color: ${palette.text}; background: transparent;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; overflow-wrap: anywhere; }
${scope} table { border-collapse: collapse; border: none; font-size: 12px; font-variant-numeric: tabular-nums; margin: 2px 0; }
${scope} th, ${scope} td { padding: 3px 10px; border: none; border-bottom: 1px solid ${palette.border}; text-align: right; vertical-align: top; white-space: nowrap; }
${scope} thead th { font-weight: 600; border-bottom: 1px solid ${palette.muted}; }
${scope} tbody th { font-weight: 600; }
${scope} tbody tr:nth-child(odd) { background: ${palette.stripe}; }
${scope} tbody tr:hover { background: ${palette.hover}; }
${scope} a { color: ${palette.accent}; }
${scope} img, ${scope} svg { max-width: 100%; height: auto; }
${scope} pre, ${scope} code { font-family: "JetBrains Mono Variable", ui-monospace, Menlo, monospace; font-size: 12px; }
${scope} p { margin: 0.4em 0; }
`;
}

/**
 * An HTML output, in a frame that runs nothing.
 *
 * `sandbox=""` — no scripts, no forms, no navigation of this window, and an opaque origin, so even a
 * frame that tried could reach neither the app's DOM nor its IPC. That is the rule for anything a
 * notebook prints, whoever wrote the notebook: in this app a script that got into the page could
 * start processes.
 *
 * The cost is height: with no script inside and no shared origin, the frame cannot say how tall it
 * is and the page cannot ask it. So the height is measured on a copy — the same HTML, sanitized,
 * laid out under the same stylesheet inside a shadow root (which isolates its styles both ways)
 * off-screen at the same width, then thrown away. Images in it are waited for, since they are most
 * of a figure's height.
 */
export function HtmlOutput({ html, palette }: { html: string; palette: OutputPalette }) {
  const frameBox = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT * 4);
  const [width, setWidth] = useState(0);

  const srcDoc = useMemo(
    () =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="${palette.scheme}">` +
      `<style>${outputCss("body", palette)}</style></head><body>${html}</body></html>`,
    [html, palette],
  );

  useLayoutEffect(() => {
    const box = frameBox.current;
    if (!box) return;
    setWidth(box.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width <= 0) return;
    let cancelled = false;
    const host = document.createElement("div");
    host.style.cssText =
      `position:fixed;left:-100000px;top:0;width:${width}px;visibility:hidden;pointer-events:none;contain:layout style;`;
    const root = host.attachShadow({ mode: "closed" });
    const clean = DOMPurify.sanitize(html, { FORCE_BODY: true });
    root.innerHTML = `<style>${outputCss(".nb-body", palette)}</style><div class="nb-body">${clean}</div>`;
    document.body.appendChild(host);
    const measure = () => {
      if (cancelled) return;
      const body = root.querySelector(".nb-body") as HTMLElement | null;
      const measured = Math.ceil((body?.getBoundingClientRect().height ?? 0) + 6);
      setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, measured)));
    };
    measure();
    const images = Array.from(root.querySelectorAll("img"));
    const settle = images.length
      ? Promise.race([
          Promise.all(images.map((img) => img.decode().catch(() => undefined))),
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ])
      : Promise.resolve();
    void settle.then(() => {
      measure();
      host.remove();
    });
    return () => {
      cancelled = true;
      host.remove();
    };
  }, [html, palette, width]);

  return (
    <div ref={frameBox} className="w-full">
      <iframe
        title="output"
        sandbox=""
        srcDoc={srcDoc}
        className="block w-full border-0 bg-transparent"
        // The frame's scheme on the element too: when the two differ the browser paints the frame
        // an opaque canvas, a dark box on the notebook.
        style={{ height, colorScheme: palette.scheme }}
        scrolling={height >= MAX_HEIGHT ? "yes" : "no"}
      />
    </div>
  );
}
