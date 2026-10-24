/**
 * Colours: read one in any common notation, write it in all of them, and check the WCAG contrast
 * of a pair. OKLCH is computed with Björn Ottosson's OKLab matrices — the space the app's own theme
 * tokens are written in.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–1. */
  a: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00",
  cyan: "#00ffff", magenta: "#ff00ff", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080",
  pink: "#ffc0cb", brown: "#a52a2a", navy: "#000080", teal: "#008080", olive: "#808000", maroon: "#800000",
  lime: "#00ff00", silver: "#c0c0c0", gold: "#ffd700", indigo: "#4b0082", violet: "#ee82ee", coral: "#ff7f50",
  salmon: "#fa8072", tomato: "#ff6347", crimson: "#dc143c", turquoise: "#40e0d0", rebeccapurple: "#663399",
  transparent: "#00000000",
};

function hueToRgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hueToRgb(p, q, hh + 1 / 3) * 255, hueToRgb(p, q, hh) * 255, hueToRgb(p, q, hh - 1 / 3) * 255];
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h * 60, s, l];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToOklch(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  const H = C < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return [L, C, H];
}

export function oklchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function num(text: string, scale: number): number {
  const t = text.trim();
  return t.endsWith("%") ? (Number(t.slice(0, -1)) / 100) * scale : Number(t);
}

/** Reads `#rgb`, `#rrggbbaa`, `rgb()`, `hsl()`, `oklch()`, `0xRRGGBB` and the common names. */
export function parseColor(input: string): Rgba {
  let t = input.trim().toLowerCase();
  if (NAMED[t]) t = NAMED[t];
  if (/^0x[0-9a-f]{6}$/.test(t)) t = `#${t.slice(2)}`;
  if (/^[0-9a-f]{6}$|^[0-9a-f]{3}$/.test(t)) t = `#${t}`;
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (m) {
    let hex = m[1];
    if (hex.length <= 4) hex = hex.split("").map((c) => c + c).join("");
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^(rgba?|hsla?|oklch)\(([^)]*)\)$/.exec(t);
  if (!m) throw new Error("Unrecognised colour");
  const args = m[2].split(/[\s,/]+/).filter(Boolean);
  if (args.length < 3) throw new Error("A colour function needs three values");
  const alpha = args[3] !== undefined ? clamp(num(args[3], 1), 0, 1) : 1;
  let rgb: [number, number, number];
  if (m[1].startsWith("rgb")) rgb = [num(args[0], 255), num(args[1], 255), num(args[2], 255)];
  else if (m[1].startsWith("hsl")) rgb = hslToRgb(parseFloat(args[0]), num(args[1].endsWith("%") ? args[1] : `${args[1]}%`, 1), num(args[2].endsWith("%") ? args[2] : `${args[2]}%`, 1));
  else rgb = oklchToRgb(num(args[0], 1), num(args[1], 0.4), parseFloat(args[2]));
  if (rgb.some((v) => Number.isNaN(v))) throw new Error("Invalid number in the colour");
  return { r: clamp(rgb[0], 0, 255), g: clamp(rgb[1], 0, 255), b: clamp(rgb[2], 0, 255), a: alpha };
}

const hex2 = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

export interface ColorFormats {
  hex: string;
  rgb: string;
  hsl: string;
  oklch: string;
  /** `0xAARRGGBB`, what Android and some game engines take. */
  argbInt: string;
}

export function formatColor(c: Rgba): ColorFormats {
  const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
  const [L, C, H] = rgbToOklch(c.r, c.g, c.b);
  const alpha = c.a < 1 ? ` / ${round(c.a, 3)}` : "";
  return {
    hex: `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${c.a < 1 ? hex2(c.a * 255) : ""}`,
    rgb: `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)}${alpha})`,
    hsl: `hsl(${round(h)} ${round(s * 100, 1)}% ${round(l * 100, 1)}%${alpha})`,
    oklch: `oklch(${round(L * 100, 2)}% ${round(C, 4)} ${round(H, 2)}${alpha})`,
    argbInt: `0x${hex2(c.a * 255)}${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`.toUpperCase().replace("0X", "0x"),
  };
}

export function relativeLuminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG 2.x contrast ratio, 1–21. Translucent colours are composited over white first. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const over = (c: Rgba, base: Rgba): Rgba => ({ r: c.r * c.a + base.r * (1 - c.a), g: c.g * c.a + base.g * (1 - c.a), b: c.b * c.a + base.b * (1 - c.a), a: 1 });
  const b = over(bg, { r: 255, g: 255, b: 255, a: 1 });
  const f = over(fg, b);
  const [l1, l2] = [relativeLuminance(f), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function wcagGrades(ratio: number): { aaNormal: boolean; aaLarge: boolean; aaaNormal: boolean; aaaLarge: boolean } {
  return { aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 };
}
