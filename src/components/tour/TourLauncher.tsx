import { GraduationCap } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { appTourFor } from "../../lib/tour/steps";
import { useTourStore } from "../../state/tourStore";
import { Tooltip } from "../common/Tooltip";

/**
 * The way into the tour of whatever is on screen.
 *
 * **One button for all six tours**, at the foot of the app rail. It used to be two: this one for the
 * five workspace apps, and a second graduation cap in the title bar for the main tour. Two controls
 * with the same glyph, in two corners, whose only distinction was which of them you happened to
 * reach for — and a reader who wanted "the tour" had no way to know that the answer depended on
 * where they clicked. Here it is always the same button and always means "explain what I am looking
 * at": the app's tour on the five app screens, the main tour on the three repository views, which
 * are what the main tour is about.
 *
 * It sits under the very buttons that open those five apps, so what it points at is never in doubt.
 */
export function TourLauncher() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const startTour = useTourStore((s) => s.start);
  const active = useTourStore((s) => s.active);
  /** Unlit once the main tour has been finished or skipped. Until then the button wears the accent,
   *  so the one control that explains all the others is the one control that stands out. */
  const seen = useTourStore((s) => s.seen);
  const t = useT();

  const app = appTourFor(activeView, apiWorkspace);
  const label = app ? t("tour.appLaunch", { name: t(app.labelKey) }) : t("tour.launch");
  // Only while the button would actually start the main tour. On an app screen it starts that app's
  // tour instead, and a "you have never done this" dot over a button that does something else is a
  // dot pointing at the wrong thing.
  const unseen = seen === false && !app;

  return (
    <Tooltip side="left" label={label}>
      {/* Rendered — not disabled — while a tour is running: the closing step of every tour
          spotlights this button, and a greyed-out control under a highlight reads as "unavailable",
          which is the opposite of what that step says. The overlay swallows the click anyway. */}
      <button
        type="button"
        // Wrapped rather than passed straight through: `start` takes an options object, and handing
        // it the click event would make React's synthetic event the tour's options.
        onClick={() => (app ? startTour({ tour: app.tour }) : startTour())}
        data-tour="tour-launcher"
        aria-label={label}
        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.03] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.04] ${
          active || unseen ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        <GraduationCap size={15} />
        {unseen && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--cf-accent)]" />
        )}
      </button>
    </Tooltip>
  );
}
