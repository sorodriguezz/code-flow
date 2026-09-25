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
