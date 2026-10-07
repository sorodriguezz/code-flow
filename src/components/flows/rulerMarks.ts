import type { FlowTriggerView } from "../../lib/tauri/flowsCommands";

/** The Programación ruler covers the next 24 hours. */
export const RULER_SPAN_MS = 24 * 60 * 60 * 1000;

/** Up to this many runs in view are dots; more would overlap, so they become thin ticks. */
const DOTS = 30;

/** One mark on a schedule's row; `left` and `width` are fractions of the ruler. */
export type RulerMark =
  | { kind: "dot" | "tick"; at: string; left: number }
  | { kind: "band"; from: string; to: string; left: number; width: number };

/**
 * Where a schedule's runs land on the ruler, from `now`. Only what falls inside it: the backend's
 * list runs a day past the schedule's *next* run (`schedule::outlook`), so some of it lies beyond the
 * right edge, and clamping would pile it there. Busy stretches are clipped to the ruler instead.
 */
export function rulerMarks(trigger: Pick<FlowTriggerView, "upcoming" | "busy">, now: number): RulerMark[] {
  const at = (iso: string) => (Date.parse(iso) - now) / RULER_SPAN_MS;
  const bands = trigger.busy.flatMap(({ from, to }): RulerMark[] => {
    const left = Math.max(at(from), 0);
    const right = Math.min(at(to), 1);
    return right > left ? [{ kind: "band", from, to, left, width: right - left }] : [];
  });
  const shown = trigger.upcoming.filter((iso) => at(iso) >= 0 && at(iso) <= 1);
  const kind = shown.length > DOTS ? "tick" : "dot";
  return [...bands, ...shown.map((iso): RulerMark => ({ kind, at: iso, left: at(iso) }))];
}
