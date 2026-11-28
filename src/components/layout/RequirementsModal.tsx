import { useEffect } from "react";
import { Download, Sparkles, TriangleAlert, X } from "lucide-react";
import { useRequirementsStore } from "../../state/requirementsStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { buttonClass } from "../common/Button";
import { openToolInstallations } from "../common/ToolInstallationLink";

export function RequirementsModal() {
  const t = useT();
  const open = useRequirementsStore((s) => s.open);
  const problems = useRequirementsStore((s) => s.problems);
  const dismiss = useRequirementsStore((s) => s.dismiss);
  const tools = useToolSetupStore((s) => s.tools);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismiss]);

  if (!open) return null;
  const gitProblem = problems.some((problem) => problem.id === "git");
  const missing = (tools ?? []).filter((tool) => !tool.installed && (tool.group === "agent" || (tool.id === "git" && !gitProblem)));

  return (
    // `z-[60]`: above the tour's own overlay. The tour is held back while this is up (see `App`),
    // but a stray first-run race must not end with this screen behind the one about to drive the app.
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 pt-16">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cf-setup-title"
        className="flex max-h-[80vh] w-[600px] flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b border-[var(--cf-border)] p-4">
          <div className="min-w-0">
            <h3 id="cf-setup-title" className="flex items-center gap-1.5 text-[15px] font-semibold">
              <Sparkles size={14} className="shrink-0 text-[var(--cf-accent)]" />
              {t("toolSetup.title")}
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("toolSetup.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label={t("requirements.dismiss")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {problems.map((problem) => (
            <div key={problem.id} className="rounded-lg border border-[var(--cf-border)] p-3">
              <p className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--cf-text)]">
                <TriangleAlert size={13} className="shrink-0 text-[var(--cf-warning)]" />
                {t(`requirements.${problem.id}` as TranslationKey)}
              </p>
              <p className="mt-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
                {t(`requirements.${problem.id}Hint` as TranslationKey)}
              </p>
              {/* The machine's own words, and the one part of this box that is not ours to translate. */}
              {problem.detail && (
                <p className="mt-2 select-text break-all rounded-md bg-[var(--cf-hover)] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {problem.detail}
                </p>
              )}
            </div>
          ))}

          {missing.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t("toolSetup.missing")}>
              {missing.map((tool) => (
                <li key={tool.id} className="rounded-md border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text-muted)]">
                  {tool.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] p-3">
          <button type="button" onClick={dismiss} className={buttonClass({ variant: "ghost" })}>
            {t("toolSetup.continue")}
          </button>
          <button
            type="button"
            onClick={() => {
              openToolInstallations(gitProblem ? "git" : undefined);
              dismiss();
            }}
            className={buttonClass({ variant: "primary" })}
          >
            <Download size={13} />
            {t("installations.open")}
          </button>
        </div>
      </div>
    </div>
  );
}
