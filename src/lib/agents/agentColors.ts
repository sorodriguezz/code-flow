/**
 * The twelve colours an agent can wear. Stored as a key, never a hex, so every one has a light and
 * a dark value (`--cf-agent-<key>` in `index.css`) and a theme switch recolours the whole roster.
 */
import type { TranslationKey } from "../i18n/translations";
import { hashOf } from "./agentIcons";

export const AGENT_COLORS = [
  "indigo",
  "blue",
  "cyan",
  "teal",
  "green",
  "lime",
  "amber",
  "orange",
  "rose",
  "magenta",
  "purple",
  "slate",
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

export function colorNameKey(color: AgentColor): TranslationKey {
  return `crew.color.${color}` as TranslationKey;
}

/** The CSS value for an agent's colour: the chosen key, a custom hex, or one picked from its id. */
export function agentColorVar(color: string | undefined, seed: string): string {
  if (color && (AGENT_COLORS as readonly string[]).includes(color)) return `var(--cf-agent-${color})`;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  return `var(--cf-agent-${AGENT_COLORS[hashOf(seed) % AGENT_COLORS.length]})`;
}

/** A repository's colour on a chip, from its position — the same project always gets the same one. */
export function repoColorVar(projectId: string): string {
  return `var(--cf-agent-${AGENT_COLORS[hashOf(projectId) % AGENT_COLORS.length]})`;
}
