import { motion, useReducedMotion } from "framer-motion";
import { ArrowUp, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { useUpdateStore } from "../../state/updateStore";
import { useT } from "../../state/languageStore";

/**
 * The whole update flow, in a card parked above the status bar's left corner.
 *
 * It's the only place updates surface, and it runs the update from right here — found, download
 * with its progress, restart — rather than handing off to a panel somewhere else. The bottom-left
 * corner is where the eye already goes for the project and branch, and the card floats over the
 * sidebar rather than sitting in the layout, so an update appearing mid-task can't reflow what
 * the user is looking at.
 *
 * Not dismissible: it *is* the update UI, so closing it would leave nothing to update from. It
 * goes away by being acted on — after the restart there's no newer version to report.
 */
export function UpdateAlert() {
  const t = useT();
  const reduceMotion = useReducedMotion();
  const status = useUpdateStore((s) => s.status);
  const update = useUpdateStore((s) => s.update);
  const progress = useUpdateStore((s) => s.progress);
  const installError = useUpdateStore((s) => s.installError);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);
  const openNotes = useUpdateStore((s) => s.openNotes);

  if (!update) return null;

  const downloading = status === "downloading";
  const ready = status === "ready";
  // A download that failed is worth saying here, because the user started it from here. A failed
  // *check* isn't — that one stays in Settings, where someone asked for it.
  const failed = installError !== "";
  if (!downloading && !ready && !failed && status !== "available") return null;

  const title = ready
    ? t("update.alertReadyTitle")
    : failed
      ? t("update.alertFailedTitle")
      : downloading
        ? t("update.alertDownloadingTitle")
        : t("update.alertTitle");

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.7 }}
      // Positioned against the status bar's own box (App.tsx makes that wrapper `relative`)
      // rather than the viewport: `bottom-full` puts the card's bottom edge on the bar's top
      // edge whatever height the bar ends up being, so no magic offset can drift out of step
      // with it. 240px wide (+ the 8px inset) keeps it inside a default sidebar rather than
      // spilling past its edge.
      className="absolute bottom-full left-2 z-40 flex w-[240px] items-start gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5 shadow-[var(--cf-shadow)] mb-2"
      role="status"
    >
      <span
        aria-hidden
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          failed
            ? "bg-[var(--cf-danger)]/10 text-[var(--cf-danger)]"
            : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
        }`}
      >
        {downloading ? (
          <Loader2 size={11} className="animate-spin" />
        ) : ready ? (
          <RotateCw size={11} />
        ) : failed ? (
          <TriangleAlert size={11} />
        ) : (
          <ArrowUp size={11} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold leading-snug text-[var(--cf-text)]">{title}</p>

        {downloading ? (
          <>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("settings.downloadingUpdate", { progress })}
            </p>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--cf-border)]">
              <div
                className="h-full rounded-full bg-[var(--cf-accent)] transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        ) : (
          <>
            {/* Wraps rather than truncates — half a sentence about an update reads like a bug. */}
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {ready
                ? t("update.alertReadyBody")
                : failed
                  ? t("update.alertFailedBody")
                  : t("update.alertBody", { version: `v${update.version}` })}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button
                onClick={ready ? () => void restart() : () => void install()}
                className="rounded-md bg-[var(--cf-accent)] px-2 py-1 text-[11px] font-medium text-white hover:brightness-110"
              >
                {ready ? t("settings.restartNow") : failed ? t("update.retry") : t("update.installNow")}
              </button>
              {/* Reading first is a legitimate answer to "should I update?", so it stays next to
                  the button that does it rather than being the only way in. */}
              {!ready && !failed && (
                <button
                  onClick={openNotes}
                  className="rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
                >
                  {t("update.seeWhatsNew")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
