import { useEffect } from "react";
import { TriangleAlert, X } from "lucide-react";
import { useRequirementsStore } from "../../state/requirementsStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The first-launch report, shown only when something is actually wrong.
 *
 * **It appears at most once per installation, and usually never.** A clean machine sees nothing —
 * the check writes its flag and gets out of the way, leaving the guided tour the screen it opens
 * on. See `requirementsStore` for why that is the right default and where the flag lives.
 *
 * **Dismissable, not blocking.** Neither of these stops the app from starting, and one of them —
 * a data directory that cannot be written — will already have taken the app down before this could
 * be drawn, which makes this screen a message about the *previous* launch as much as this one. A
 * modal that refused to close would leave someone unable to reach Settings, the terminal or the
 * documentation, which is where the fix is. So it says what is wrong, says what to do, and lets go.
 *
 * **It quotes the machine.** Each row carries the exact output — `git version 2.51.0`, or the OS
 * error verbatim — rather than only our own summary of it. That line is the difference between
 * "git is missing" and a stale shim that exists and exits non-zero, which are different problems
 * with different fixes and look identical in a sentence we wrote.
 */
export function RequirementsModal() {
  const t = useT();
  const open = useRequirementsStore((s) => s.open);
  const problems = useRequirementsStore((s) => s.problems);
  const dismiss = useRequirementsStore((s) => s.dismiss);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismiss]);

  if (!open || problems.length === 0) return null;

  return (
    // `z-[60]`: above the tour's own overlay. The tour is held back while this is up (see `App`),
    // but a stray first-run race must not end with the one screen explaining the breakage behind
    // the one that is about to drive the app around it.
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-20" onClick={dismiss}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[70vh] w-[540px] flex-col rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--cf-border)] p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
              <TriangleAlert size={14} className="shrink-0 text-[var(--cf-warning)]" />
              {t("requirements.title")}
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("requirements.subtitle")}
            </p>
          </div>
          <button
            onClick={dismiss}
            aria-label={t("requirements.dismiss")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {problems.map((problem) => (
            <div key={problem.id} className="rounded-lg border border-[var(--cf-border)] p-3">
              <p className="text-[12.5px] font-medium text-[var(--cf-text)]">
                {t(`requirements.${problem.id}` as TranslationKey)}
              </p>
              <p className="mt-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                {t(`requirements.${problem.id}Hint` as TranslationKey)}
              </p>
              {/* The machine's own words, and the one part of this box that is not ours to
                  translate. Monospace and selectable, because the next thing somebody does with an
                  unfamiliar error is search for it. */}
              {problem.detail && (
                <p className="mt-2 select-text break-all rounded-md bg-black/[0.04] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)] dark:bg-white/[0.06]">
                  {problem.detail}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="flex shrink-0 justify-end border-t border-[var(--cf-border)] p-3">
          <button
            onClick={dismiss}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12.5px] font-medium text-white"
          >
            {t("requirements.dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
