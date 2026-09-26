/**
 * The see-through window's numbers and the one function that paints them.
 *
 * The native half — the blurred backdrop the platform draws under the page — is `glass.rs`; this is
 * the page's half: how much of the scheme's own colour covers that backdrop, as three percentages on
 * `<html>` that `index.css` reads (`--cf-glass-frame`, `--cf-glass-sheet`, `--cf-glass-solo`) and a
 * `data-glass` attribute that switches the rules on. See the note above those rules.
 *
 * **`glass.rs` computes the same three numbers** for the script that stamps them before a window's
 * first paint. The tests on both sides pin the same points, so the two cannot drift into a window
 * that opens at one tint and jumps to another once its store boots.
 */

/** `"true"` when the window lets the desktop through. Unset means off. Same key as `glass.rs`. */
export const GLASS_KEY = "window_glass";
/** 0–100, how see-through. Same key as `glass.rs`. */
export const GLASS_LEVEL_KEY = "window_glass_level";
export const DEFAULT_GLASS_LEVEL = 50;

export interface GlassFills {
  /** The frame's own colour over the backdrop: title row, projects, rail, status bar. */
  frame: number;
  /** A sheet's, over the frame: the view, the assistant, the dock. */
  sheet: number;
  /** The two together, for a window that is one sheet and no frame (the quick-ask box). */
  solo: number;
}

/**
 * How much of each layer's colour covers the backdrop at a slider level, in percent.
 *
 * The sheet falls more slowly than the frame because it is read, not glanced at: at the far end of
 * the slider the frame is mostly backdrop and the work is still mostly the work.
 */
export function glassFills(level: number): GlassFills {
  const t = clampGlassLevel(level) / 100;
  const frame = 80 - 65 * t;
  const sheet = 80 - 50 * t;
  const solo = 100 - ((100 - frame) * (100 - sheet)) / 100;
  return { frame, sheet, solo };
}

/** The most a scheme's glass is thickened, in points: past it, the glass would stop being glass. */
export const MAX_GLASS_BOOST = 20;

/** What the backdrop measures behind the page, as a grey from 0 to 1, over a mid-toned wallpaper:
 *  the dark material lets through about half (0.74 over a white wallpaper); the light one lifts what
 *  is under it (0.59 over navy, 0.94 over white). Measured on macOS's HUD material, 2026-09-25. */
const BACKDROP_GREY = { dark: 0.5, light: 0.75 } as const;

/** Muted text on the frame and on a sheet should keep this contrast over the glass — or 70% / 80% of
 *  what it has on its own opaque ground, for a scheme that never had it. CodeFlow's own two schemes
 *  clear both at the default level, so they are never thickened. */
const MUTED_ON_FRAME = 2.8;
const MUTED_ON_SHEET = 4.2;

/**
 * How many points denser a scheme's glass is painted than the slider says (`--cf-glass-boost`), so
 * its quietest text — `textMuted`, the section labels, dates, authors — stays readable.
 *
 * The slider's numbers are tuned on CodeFlow's own schemes, whose greys sit far from their grounds.
 * Dracula's or Nord's sit close, and at the same density the backdrop ate them (1.7:1 on the
 * frame, measured). So each scheme is tested at the default level over the backdrop's usual grey,
 * and thickened by the fewest whole points that keep its muted text at `MUTED_ON_FRAME` on the frame
 * and `MUTED_ON_SHEET` on a sheet. The same boost holds along the whole slider.
 */
export function glassBoost(scheme: { mode: "light" | "dark"; ui: { bg: string; surface: string; textMuted: string } }): number {
  const backdrop = BACKDROP_GREY[scheme.mode];
  const ground = srgb(scheme.ui.bg);
  const sheet = srgb(scheme.ui.surface);
  const muted = srgb(scheme.ui.textMuted);
  const onFrameTarget = Math.min(MUTED_ON_FRAME, contrast(muted, ground) * 0.7);
  const onSheetTarget = Math.min(MUTED_ON_SHEET, contrast(muted, sheet) * 0.8);
  const fills = glassFills(DEFAULT_GLASS_LEVEL);
  for (let boost = 0; boost < MAX_GLASS_BOOST; boost++) {
    const onFrame = over(ground, Math.min(fills.frame + boost, 100) / 100, [backdrop, backdrop, backdrop]);
    const onSheet = over(sheet, Math.min(fills.sheet + boost, 100) / 100, onFrame);
    if (contrast(muted, onFrame) >= onFrameTarget && contrast(muted, onSheet) >= onSheetTarget) return boost;
  }
  return MAX_GLASS_BOOST;
}

type Rgb = readonly [number, number, number];

/** `#rrggbb` as three channels from 0 to 1. */
function srgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16) / 255) as unknown as Rgb;
}

/** `top` at `alpha` over `under`, blended the way the page composites: in sRGB. */
function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return top.map((channel, i) => alpha * channel + (1 - alpha) * under[i]) as unknown as Rgb;
}

/** WCAG's contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function luminance([r, g, b]: Rgb): number {
  const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** A stored or dragged level as a whole number from 0 to 100; anything unreadable is the default. */
export function clampGlassLevel(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_GLASS_LEVEL;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_GLASS_LEVEL;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

const VARS = ["--cf-glass-frame", "--cf-glass-sheet", "--cf-glass-solo"] as const;

/** Puts the page's half on (at `level`) or takes it off. Cheap — three properties — so the slider
 *  calls it on every step of a drag. */
export function paintGlass(enabled: boolean, level: number, root: HTMLElement = document.documentElement): void {
  if (!enabled) {
    root.removeAttribute("data-glass");
    for (const name of VARS) root.style.removeProperty(name);
    return;
  }
  const { frame, sheet, solo } = glassFills(level);
  root.setAttribute("data-glass", "");
  root.style.setProperty("--cf-glass-frame", `${frame.toFixed(1)}%`);
  root.style.setProperty("--cf-glass-sheet", `${sheet.toFixed(1)}%`);
  root.style.setProperty("--cf-glass-solo", `${solo.toFixed(1)}%`);
}

/** Whether this window is painted see-through right now — the page's answer, which is also what
 *  `glass.rs`'s first-paint script leaves behind when it built the window with its backdrop on. */
export function isGlassPainted(root?: HTMLElement): boolean {
  // Read at module load by `themeStore`, so it must also answer where there is no document at all.
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return target?.hasAttribute("data-glass") ?? false;
}
