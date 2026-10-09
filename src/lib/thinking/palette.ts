/**
 * The theme's colours as numbers, for the thinking marks that paint on a canvas.
 *
 * A canvas cannot say `var(--cf-ai-a)`, and the tokens are not all hex: a theme may write them as
 * `rgb()`, `oklch()` or a `color-mix()`. So each one is resolved the way the page resolves it — a
 * probe element's computed colour — and then flattened to sRGB by painting one pixel with it,
 * which accepts every colour syntax the engine itself understands.
 *
 * Read lazily and thrown away whenever the root's theme attributes change (`themeStore` writes
 * `data-theme` and the scheme's variables on `<html>`), so a mark follows a theme switch on its
 * next frame without anyone telling it.
 */

export type Rgb = readonly [number, number, number];

export interface Palette {
  text: Rgb;
  surface: Rgb;
  a: Rgb;
  b: Rgb;
  c: Rgb;
  success: Rgb;
  warning: Rgb;
  /** A failed run's colour. */
  danger: Rgb;
  /** Whether the page is dark — additive blending only reads as light on a dark ground. */
  dark: boolean;
}

const FALLBACK: Palette = {
  text: [232, 233, 241],
  surface: [18, 19, 25],
  a: [139, 92, 246],
  b: [99, 102, 241],
  c: [6, 182, 212],
  success: [74, 222, 128],
  warning: [251, 191, 36],
  danger: [248, 113, 113],
  dark: true,
};

let cached: Palette | null = null;
let watching = false;

export function palette(): Palette {
  if (typeof document === "undefined") return FALLBACK;
  watch();
  if (!cached) cached = read();
  return cached;
}

function watch() {
  if (watching) return;
  watching = true;
  const drop = () => {
    cached = null;
  };
  new MutationObserver(drop).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style", "class", "data-theme", "data-glass"],
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", drop);
}

function read(): Palette {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const resolve = (token: string, fallback: Rgb): Rgb => {
    probe.style.color = "";
    probe.style.color = `var(${token})`;
    const computed = getComputedStyle(probe).color;
    if (!ctx || !computed) return fallback;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = ctx.getImageData(0, 0, 1, 1).data;
    return alpha === 0 ? fallback : [r, g, b];
  };
  const result: Palette = {
    text: resolve("--cf-text", FALLBACK.text),
    surface: resolve("--cf-surface", FALLBACK.surface),
    a: resolve("--cf-ai-a", FALLBACK.a),
    b: resolve("--cf-ai-b", FALLBACK.b),
    c: resolve("--cf-ai-c", FALLBACK.c),
    success: resolve("--cf-success", FALLBACK.success),
    warning: resolve("--cf-warning", FALLBACK.warning),
    danger: resolve("--cf-danger", FALLBACK.danger),
    dark: false,
  };
  probe.remove();
  const [r, g, b] = result.surface;
  result.dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  return result;
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = amount < 0 ? 0 : amount > 1 ? 1 : amount;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

export function rgb(color: Rgb): string {
  return `rgb(${color[0] | 0},${color[1] | 0},${color[2] | 0})`;
}

/** The assistant's three hues as one ramp: `at` 0 is violet, 0.5 indigo, 1 cyan. */
export function aiHue(p: Palette, at: number): Rgb {
  return at < 0.5 ? mix(p.a, p.b, at * 2) : mix(p.b, p.c, (at - 0.5) * 2);
}
