import type { TranslationKey } from "./i18n/translations";

export type ThinkingDesign =
  | "sphere"
  | "orb"
  | "walle"
  | "bot"
  | "blob"
  | "axolotl"
  | "plasma"
  | "wave"
  | "liquid"
  | "crystal"
  | "cat"
  | "rocky"
  | "ghost"
  | "crab"
  | "tars"
  | "r2d2"
  | "calcifer"
  | "cloud"
  | "bulb"
  | "alien"
  | "nutcracker";

export type ThinkingDesignKind = "css" | "canvas";

export const DEFAULT_THINKING_DESIGN: ThinkingDesign = "sphere";

const DEFAULT_FINISH_MS = 900;
const NUTCRACKER_FINISH_MS = 1600;
const CHARACTER_FINISH_MS = 1600;
const STRING_TYPE = "string";
const CSS_KIND: ThinkingDesignKind = "css";

export const THINKING_DESIGNS: readonly {
  id: ThinkingDesign;
  labelKey: TranslationKey;
  kind: ThinkingDesignKind;
  finishMs?: number;
  voice?: true;
}[] = [
  { id: "sphere", labelKey: "thinking.sphere", kind: "canvas" },
  { id: "orb", labelKey: "thinking.orb", kind: "canvas", finishMs: 1400, voice: true },
  { id: "walle", labelKey: "thinking.walle", kind: "canvas", finishMs: CHARACTER_FINISH_MS, voice: true },
  { id: "bot", labelKey: "thinking.bot", kind: "css" },
  { id: "blob", labelKey: "thinking.blob", kind: "css" },
  { id: "axolotl", labelKey: "thinking.axolotl", kind: "canvas", finishMs: 1500, voice: true },
  { id: "plasma", labelKey: "thinking.plasma", kind: "css" },
  { id: "wave", labelKey: "thinking.wave", kind: "canvas", finishMs: 1400, voice: true },
  { id: "liquid", labelKey: "thinking.liquid", kind: "canvas", finishMs: 1400 },
  { id: "crystal", labelKey: "thinking.crystal", kind: "canvas", finishMs: 1750 },
  { id: "cat", labelKey: "thinking.cat", kind: "canvas", finishMs: 1600 },
  { id: "rocky", labelKey: "thinking.rocky", kind: "canvas", finishMs: 1650 },
  { id: "ghost", labelKey: "thinking.ghost", kind: "canvas", finishMs: 1500 },
  { id: "crab", labelKey: "thinking.crab", kind: "canvas", finishMs: 1600 },
  { id: "tars", labelKey: "thinking.tars", kind: "canvas", finishMs: CHARACTER_FINISH_MS, voice: true },
  { id: "r2d2", labelKey: "thinking.r2d2", kind: "canvas", finishMs: CHARACTER_FINISH_MS, voice: true },
  { id: "calcifer", labelKey: "thinking.calcifer", kind: "canvas", finishMs: CHARACTER_FINISH_MS, voice: true },
  { id: "cloud", labelKey: "thinking.cloud", kind: "canvas", finishMs: 1500, voice: true },
  { id: "bulb", labelKey: "thinking.bulb", kind: "canvas", finishMs: 1500, voice: true },
  { id: "alien", labelKey: "thinking.alien", kind: "canvas", finishMs: 1500, voice: true },
  { id: "nutcracker", labelKey: "thinking.nutcracker", kind: "canvas", finishMs: NUTCRACKER_FINISH_MS, voice: true },
];

export function isThinkingDesign(value: unknown): value is ThinkingDesign {
  return THINKING_DESIGNS.some((design) => design.id === value);
}

const SUCCESSORS: Readonly<Record<string, ThinkingDesign>> = { star: "cat", panda: "tars", pixels: "rocky", network: "axolotl", spark: "calcifer", halo: "walle", moon: "tars", atom: "r2d2" };

export function storedThinkingDesign(value: unknown): ThinkingDesign {
  const current = isThinkingDesign(value);
  if (current) return value;
  const text = typeof value === STRING_TYPE;
  if (!text) return DEFAULT_THINKING_DESIGN;
  const key = value as string;
  const knownSuccessor = Object.prototype.hasOwnProperty.call(SUCCESSORS, key);
  if (!knownSuccessor) return DEFAULT_THINKING_DESIGN;
  const successor = SUCCESSORS[key];
  if (successor) return successor;
  return DEFAULT_THINKING_DESIGN;
}

export function thinkingDesignKind(design: ThinkingDesign): ThinkingDesignKind {
  const entry = THINKING_DESIGNS.find((candidate) => candidate.id === design);
  return entry?.kind ?? CSS_KIND;
}

export function thinkingSpeaksItself(design: ThinkingDesign): boolean {
  const entry = THINKING_DESIGNS.find((candidate) => candidate.id === design);
  return !!entry?.voice;
}

export function thinkingFinishMs(design: ThinkingDesign): number {
  const entry = THINKING_DESIGNS.find((candidate) => candidate.id === design);
  return entry?.finishMs ?? DEFAULT_FINISH_MS;
}
