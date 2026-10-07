/**
 * The looks the "a model is thinking" mark can take — picked in Settings › AI assistant ›
 * Thinking design, and worn by every `ThinkingOrb` in every window, the run card's included.
 *
 * **What all of them keep.** The mark means one thing in this app: an engine is running *right
 * now* — an agent turn, a review stage, a story being written — and it has been spent consistently
 * enough that people read it (see `ThinkingOrb`). So a design may change its shape, never that
 * meaning. Every one is drawn in the assistant's own hues (`--cf-ai-*`), fills the orb's square
 * exactly at every size (so switching design moves no row by a pixel), and has a still frame for
 * reduced motion.
 *
 * **Two kinds.** `css` designs are plain elements animated with `transform` and `opacity` (their
 * rules are in `index.css`, under "Thinking marks"). `canvas` designs paint every frame — a dot
 * globe, a shader, a graph — through `lib/thinking`: one shared animation loop that only paints
 * marks on screen, and for the shader one shared WebGL context, so a task list showing a dozen
 * costs one loop, not a dozen.
 *
 * Replaced wholesale on 2026-10-07 (the twelve CSS marks before — reactor, sparkle, aurora… — are
 * gone); a stored id from that set falls back to the default. Four more joined the same day —
 * Líquido, Cristal, Estrella, Píxeles — each with a finish of its own (`finishMs`): what plays in a
 * finished turn's gutter before the avatar takes its place.
 */

import type { TranslationKey } from "./i18n/translations";

export type ThinkingDesign =
  | "sphere"
  | "orb"
  | "halo"
  | "bot"
  | "blob"
  | "network"
  | "plasma"
  | "wave"
  | "liquid"
  | "crystal"
  | "star"
  | "pixels";

export type ThinkingDesignKind = "css" | "canvas";

/** The dot globe — the mark the run card was designed around. */
export const DEFAULT_THINKING_DESIGN: ThinkingDesign = "sphere";

/** How long a design's finish runs when nobody says otherwise — the old marks' brief resolve. */
const DEFAULT_FINISH_MS = 900;

export const THINKING_DESIGNS: readonly {
  id: ThinkingDesign;
  labelKey: TranslationKey;
  kind: ThinkingDesignKind;
  /** How long its finish animation runs, for the avatar to wait out. */
  finishMs?: number;
}[] = [
  { id: "sphere", labelKey: "thinking.sphere", kind: "canvas" },
  { id: "orb", labelKey: "thinking.orb", kind: "canvas" },
  { id: "halo", labelKey: "thinking.halo", kind: "css" },
  { id: "bot", labelKey: "thinking.bot", kind: "css" },
  { id: "blob", labelKey: "thinking.blob", kind: "css" },
  { id: "network", labelKey: "thinking.network", kind: "canvas" },
  { id: "plasma", labelKey: "thinking.plasma", kind: "css" },
  { id: "wave", labelKey: "thinking.wave", kind: "canvas" },
  { id: "liquid", labelKey: "thinking.liquid", kind: "canvas", finishMs: 1500 },
  { id: "crystal", labelKey: "thinking.crystal", kind: "canvas", finishMs: 1750 },
  { id: "star", labelKey: "thinking.star", kind: "canvas", finishMs: 1700 },
  { id: "pixels", labelKey: "thinking.pixels", kind: "canvas", finishMs: 1650 },
];

export function isThinkingDesign(value: unknown): value is ThinkingDesign {
  return THINKING_DESIGNS.some((design) => design.id === value);
}

export function thinkingDesignKind(design: ThinkingDesign): ThinkingDesignKind {
  return THINKING_DESIGNS.find((d) => d.id === design)?.kind ?? "css";
}

export function thinkingFinishMs(design: ThinkingDesign): number {
  return THINKING_DESIGNS.find((d) => d.id === design)?.finishMs ?? DEFAULT_FINISH_MS;
}
