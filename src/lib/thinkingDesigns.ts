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
 * finished turn's gutter before the avatar takes its place. The Orbe and the Onda got one on 2026-10-08,
 * and Estrella was replaced by Gato the same day (a stored `star` reads as `cat`). Four more joined
 * then too — Fantasma, Cangrejo (Ferris's shape, for the Rust core), Panda (soon replaced by Luna),
 * Átomo — and Red neuronal was rebuilt as a layered network. On 2026-10-10 four more characters
 * joined (user: "más estilo mascota", but no pets): Chispa, a flame spirit; Nube, a cloud; Bombilla,
 * a light bulb; Marciano, a little alien.
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
  | "cat"
  | "pixels"
  | "ghost"
  | "crab"
  | "moon"
  | "atom"
  | "spark"
  | "cloud"
  | "bulb"
  | "alien";

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
  /** It draws «Hablando» (the reading aloud) itself, from the voice's loudness (`lib/thinking/voice`).
   *  Every other design is handed writing's look for it, and `.cf-orb--speaking` breathes it. */
  voice?: true;
}[] = [
  { id: "sphere", labelKey: "thinking.sphere", kind: "canvas" },
  { id: "orb", labelKey: "thinking.orb", kind: "canvas", finishMs: 1400, voice: true },
  { id: "halo", labelKey: "thinking.halo", kind: "css" },
  { id: "bot", labelKey: "thinking.bot", kind: "css" },
  { id: "blob", labelKey: "thinking.blob", kind: "css" },
  { id: "network", labelKey: "thinking.network", kind: "canvas", finishMs: 1400 },
  { id: "plasma", labelKey: "thinking.plasma", kind: "css" },
  { id: "wave", labelKey: "thinking.wave", kind: "canvas", finishMs: 1400, voice: true },
  { id: "liquid", labelKey: "thinking.liquid", kind: "canvas", finishMs: 1400 },
  { id: "crystal", labelKey: "thinking.crystal", kind: "canvas", finishMs: 1750 },
  { id: "cat", labelKey: "thinking.cat", kind: "canvas", finishMs: 1600 },
  { id: "pixels", labelKey: "thinking.pixels", kind: "canvas", finishMs: 1650 },
  { id: "ghost", labelKey: "thinking.ghost", kind: "canvas", finishMs: 1500 },
  { id: "crab", labelKey: "thinking.crab", kind: "canvas", finishMs: 1600 },
  { id: "moon", labelKey: "thinking.moon", kind: "canvas", finishMs: 1500 },
  { id: "atom", labelKey: "thinking.atom", kind: "canvas", finishMs: 1500 },
  { id: "spark", labelKey: "thinking.spark", kind: "canvas", finishMs: 1500, voice: true },
  { id: "cloud", labelKey: "thinking.cloud", kind: "canvas", finishMs: 1500, voice: true },
  { id: "bulb", labelKey: "thinking.bulb", kind: "canvas", finishMs: 1500, voice: true },
  { id: "alien", labelKey: "thinking.alien", kind: "canvas", finishMs: 1500, voice: true },
];

export function isThinkingDesign(value: unknown): value is ThinkingDesign {
  return THINKING_DESIGNS.some((design) => design.id === value);
}

/** Designs that were replaced by another rather than dropped: whoever had picked one keeps its
 *  successor instead of being sent back to the default. Estrella became Gato on 2026-10-08, and the
 *  Panda the Luna the same day. */
const SUCCESSORS: Readonly<Record<string, ThinkingDesign>> = { star: "cat", panda: "moon" };

/** What a stored setting reads as: its own design, a replaced one's successor, or the default —
 *  for an unset row, a retired mark (reactor, sparkle…) or an id from a newer release. */
export function storedThinkingDesign(value: unknown): ThinkingDesign {
  if (isThinkingDesign(value)) return value;
  if (typeof value === "string" && SUCCESSORS[value]) return SUCCESSORS[value];
  return DEFAULT_THINKING_DESIGN;
}

export function thinkingDesignKind(design: ThinkingDesign): ThinkingDesignKind {
  return THINKING_DESIGNS.find((d) => d.id === design)?.kind ?? "css";
}

/** Whether the design draws speaking from the voice itself, rather than being handed writing. */
export function thinkingSpeaksItself(design: ThinkingDesign): boolean {
  return !!THINKING_DESIGNS.find((d) => d.id === design)?.voice;
}

export function thinkingFinishMs(design: ThinkingDesign): number {
  return THINKING_DESIGNS.find((d) => d.id === design)?.finishMs ?? DEFAULT_FINISH_MS;
}
