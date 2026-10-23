import { useEffect } from "react";
import { codiNarrate } from "../../lib/tauri/codiCommands";
import { spokenStep } from "../../lib/tour/spoken";
import { translate, useLanguageStore } from "../../state/languageStore";
import { tourStep, useTourStore } from "../../state/tourStore";

/** The beat between a step said and the next one shown — enough to see the spotlight land, and
 *  to say «Codi, para» before it moves. */
const STEP_GAP_MS = 700;

/**
 * Codi explaining the tour on screen: each step said aloud in its voice, and the next one shown once
 * it has been said whole (user, 2026-10-22: «que codi mientras vaya explicando el tour vaya
 * pasando»). The last step said ends the tour, like Finish.
 *
 * A step that was not said whole holds the tour where it is: the user talked over it («Codi,
 * siguiente» moves on and is said; «Codi, para» stops), paused it on the card, or Codi's sound is off
 * — which turns the narration off and says so on the card. Any way of arriving at a step (the
 * buttons, the keys, Codi) says it, from the top.
 */
export function useTourNarration(): void {
  const active = useTourStore((s) => s.active);
  const narrated = useTourStore((s) => s.narrated);
  const paused = useTourStore((s) => s.narrationPaused);
  const round = useTourStore((s) => s.narrationRound);
  const tourId = useTourStore((s) => s.tourId);
  const index = useTourStore((s) => s.index);
  const language = useLanguageStore((s) => s.language);

  useEffect(() => {
    if (!active || !narrated || paused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const text = spokenStep(tourStep(tourId, index), translate, language);
    codiNarrate(text)
      .then((how) => {
        if (cancelled) return;
        if (how !== "done") {
          useTourStore.getState().narrationEnded(how);
          return;
        }
        timer = setTimeout(() => {
          if (!cancelled) useTourStore.getState().next();
        }, STEP_GAP_MS);
      })
      .catch(() => {
        if (!cancelled) useTourStore.getState().narrationEnded("failed");
      });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, narrated, paused, round, tourId, index, language]);
}
