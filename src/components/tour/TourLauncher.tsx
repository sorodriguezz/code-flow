import { GraduationCap } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { appTourFor } from "../../lib/tour/steps";
import { useTourStore } from "../../state/tourStore";

/**
 * The way into the tour of whichever workspace app is on screen.
 *
 * One button that changes what it starts, rather than a graduation cap bolted into five different
 * panel headers — see the note on `appTourFor`. It sits at the foot of the app rail, under the very
 * buttons that open those five, so it is unambiguously "explain *this*".
 *
 * Absent on the three repository views. Those are what the main tour is about, and a button that
 * looked identical but started the same tour the title bar starts would read as a second, different
 * tour.
 */
export function TourLauncher() {
  const activeView = useUiStore((s) => s.activeView);
  const apiWorkspace = useUiStore((s) => s.apiWorkspace);
  const startTour = useTourStore((s) => s.start);
  const active = useTourStore((s) => s.active);
  const t = useT();

  const app = appTourFor(activeView, apiWorkspace);
  if (!app) return null;

  const label = t("tour.appLaunch", { name: t(app.labelKey) });

  return (
    // Rendered — not disabled — while a tour is running, for the same reason the title bar's
    // launcher is: the last step of the main tour spotlights this button, and a greyed-out control
    // under a highlight reads as "unavailable", which is the opposite of what that step says. The
    // overlay swallows the click anyway.
    <button
      type="button"
      onClick={() => startTour({ tour: app.tour })}
      data-tour="app-tour-launcher"
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-black/[0.03] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.04] ${
        active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      <GraduationCap size={15} />
    </button>
  );
}
