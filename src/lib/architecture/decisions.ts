/** The arithmetic of the Decisions lens: an option's weighted score, the option a decision lands on,
 *  and the next free id for a new entry. */
import type { Decision, DecisionOption } from "./types";

export function weightedTotal(d: Decision, option: NonNullable<Decision["options"]>[number]): number {
  const crit = d.criteria ?? [];
  const max = crit.reduce((a, c) => a + 5 * c.weight, 0) || 1;
  return crit.reduce((a, c) => a + (option.scores?.[c.id] ?? 0) * c.weight, 0) / max;
}

/** The option a decision lands on: the one marked by hand, or else the best total. */
export function chosenOption(d: Decision): { option: DecisionOption; index: number; byHand: boolean } | null {
  const options = d.options ?? [];
  const marked = options.findIndex((o) => o.recommended);
  if (marked >= 0) return { option: options[marked], index: marked, byHand: true };
  let best = -1;
  options.forEach((o, i) => { if (best < 0 || weightedTotal(d, o) > weightedTotal(d, options[best])) best = i; });
  return best >= 0 ? { option: options[best], index: best, byHand: false } : null;
}

/** `ADR-003` after `ADR-001`, `ADR-002`, `ADR-007`→`ADR-008`: one past the highest, never a number in use. */
export function nextId(prefix: string, ids: string[], pad = 0): string {
  const used = ids.map((id) => (id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN)).filter(Number.isFinite);
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}${String(n).padStart(pad, "0")}`;
}
