/**
 * The looks the "a model is thinking" mark can take — picked in Settings › AI assistant ›
 * Thinking design, and worn by every `ThinkingOrb` in every window.
 *
 * **What all of them keep.** The mark means one thing in this app: an engine is running *right
 * now* — an agent turn, a review stage, a story being written — and it has been spent consistently
 * enough that people read it (see `ThinkingOrb`). So a design may change its shape, never that
 * meaning. Every one of these is drawn in the assistant's own hues (`--cf-ai-*`, with the accent),
 * and none is a single ring turning or a row of dots bouncing: those are what the app's plain
 * spinner and `BouncingDots` look like, and they are what non-AI work wears. An AI design that
 * could be mistaken for a download would take the distinction away.
 *
 * **What they cost.** The same as the original: `transform` and `opacity` only, which the
 * compositor moves without repainting, no filters and no JS loop — a task list can hold twenty of
 * these. Each still fills the orb's square exactly, at every size, so switching design moves no
 * row by a pixel. The CSS is in `index.css`, right after the reactor's.
 */

import type { TranslationKey } from "./i18n/translations";

export type ThinkingDesign = "reactor" | "spark" | "aurora" | "orbit" | "pulse" | "voice" | "matrix" | "helix";

/** The reactor — the mark the app has always drawn. */
export const DEFAULT_THINKING_DESIGN: ThinkingDesign = "reactor";

export const THINKING_DESIGNS: readonly { id: ThinkingDesign; labelKey: TranslationKey }[] = [
  { id: "reactor", labelKey: "thinking.reactor" },
  { id: "spark", labelKey: "thinking.spark" },
  { id: "aurora", labelKey: "thinking.aurora" },
  { id: "orbit", labelKey: "thinking.orbit" },
  { id: "pulse", labelKey: "thinking.pulse" },
  { id: "voice", labelKey: "thinking.voice" },
  { id: "matrix", labelKey: "thinking.matrix" },
  { id: "helix", labelKey: "thinking.helix" },
];

export function isThinkingDesign(value: unknown): value is ThinkingDesign {
  return THINKING_DESIGNS.some((design) => design.id === value);
}
