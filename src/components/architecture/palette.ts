/**
 * The canvas's palette, read from the app's theme: the six base tokens `applyThemeVars` writes
 * (all hex) turned into the diagram's colours by mixing, so the drawing follows every one of the 24
 * editor themes and the accent picker. Exports use the fixed light or dark palette instead, so a
 * file looks the same wherever it is opened.
 */
import { useEffect, useState } from "react";
import { DARK_PALETTE, LIGHT_PALETTE, mix, type ArchPalette } from "../../lib/architecture/svg";

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function themePalette(): ArchPalette {
  if (typeof document === "undefined") return LIGHT_PALETTE;
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const dark = root.dataset.theme === "dark";
  const base = dark ? DARK_PALETTE : LIGHT_PALETTE;
  const surface = v("--cf-surface"), text = v("--cf-text"), muted = v("--cf-text-muted"), border = v("--cf-border"), accent = v("--cf-accent");
  if (![surface, text, muted, border].every((c) => HEX.test(c))) return base;
  const tint = (amount: number) => mix(text, surface, amount);
  return {
    ...base,
    canvas: surface,
    halo: surface,
    card: dark ? mix(text, surface, 0.045) : surface,
    pill: dark ? mix(text, surface, 0.045) : surface,
    cloud: tint(dark ? 0.03 : 0.022),
    cloudHead: tint(dark ? 0.055 : 0.045),
    group: surface,
    groupHead: tint(dark ? 0.04 : 0.022),
    cluster: tint(dark ? 0.035 : 0.022),
    tier: tint(dark ? 0.07 : 0.05),
    line: border,
    lineStrong: mix(text, border, 0.12),
    dash: mix(text, surface, 0.38),
    cardBorder: mix(text, surface, dark ? 0.2 : 0.24),
    ink: text,
    ink2: muted,
    ink3: mix(muted, surface, 0.62),
    desc: mix(text, muted, 0.35),
    edge: mix(text, surface, 0.55),
    edgeAsync: mix(text, surface, 0.38),
    hot: HEX.test(accent) ? accent : base.hot,
    step: base.step,
    shadow: dark ? 0.35 : 0.08,
  };
}

/**
 * `next`, or `prev` itself when nothing in it changed. Any write to `<html>`'s style or class fires the
 * observer below, and a new palette object rebuilds every node on the canvas — mid-drag, that put the
 * card back where the document had it.
 */
export function samePalette(prev: ArchPalette, next: ArchPalette): ArchPalette {
  const keys = Object.keys(next) as Array<keyof ArchPalette>;
  return keys.length === Object.keys(prev).length && keys.every((key) => prev[key] === next[key]) ? prev : next;
}

/** The palette, re-read whenever the theme or the accent changes. */
export function useThemePalette(): ArchPalette {
  const [palette, setPalette] = useState(themePalette);
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setPalette((prev) => samePalette(prev, themePalette())));
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  return palette;
}
