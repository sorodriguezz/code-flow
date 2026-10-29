import { useEffect, useState } from "react";
import { Download, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { useRequirementsStore } from "../../state/requirementsStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { buttonClass } from "../common/Button";
import { ToolInstallRow } from "../common/ToolInstallRow";

/**
 * «Preparar CodeFlow» — the first-launch screen: what is wrong, if anything, and which of `git` and
 * the AI CLIs to install, ticked and installed in one go.
 *
 * **At most once per installation, and only with something to say.** A machine with everything
 * already there sees nothing — see `requirementsStore`. The guided tour waits for this to close.
 *
 * **Dismissable, not blocking.** Nothing here stops the app from starting, and one problem — a data
 * directory that cannot be written — will already have taken the app down before this could be
 * drawn. So it says what is wrong, offers what can be installed, and lets go; everything it offers
 * is in Settings too (Motores de IA › Proveedores, Comportamiento Git › Instalación).
 *
 * **It quotes the machine.** A problem row carries the exact output — `git version 2.51.0`, or the
 * OS error verbatim — and a tool row the exact command it will run.
 */
export function RequirementsModal() {
  const t = useT();
  const open = useRequirementsStore((s) => s.open);
  const problems = useRequirementsStore((s) => s.problems);
  const dismiss = useRequirementsStore((s) => s.dismiss);
  const tools = useToolSetupStore((s) => s.tools);
  const installing = useToolSetupStore((s) => s.installing);
  const installMany = useToolSetupStore((s) => s.installMany);
  const [picked, setPicked] = useState<Set<string> | null>(null);

  // Nothing ticked but a missing git: the CLIs are the person's choice.
  useEffect(() => {
    if (!open || picked || !tools) return;
    setPicked(new Set(tools.filter((tool) => tool.id === "git" && !tool.installed && tool.command).map((tool) => tool.id)));
  }, [open, picked, tools]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !installing) dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismiss, installing]);

  if (!open) return null;

  // `git` is offered in the tool list, so its problem row would say the same thing twice.
  const shownProblems = problems.filter((problem) => !(problem.id === "git" && tools?.some((tool) => tool.id === "git")));
  const chosen = (tools ?? []).filter((tool) => picked?.has(tool.id) && !tool.installed);
  const toggle = (id: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current ?? []);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

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
            onClick={dismiss}
            disabled={!!installing}
            aria-label={t("requirements.dismiss")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-40"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {shownProblems.map((problem) => (
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

          {!tools ? (
            <p className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={13} className="animate-spin" />
              {t("toolSetup.checking")}
            </p>
          ) : (
            tools.map((tool) => (
              <ToolInstallRow key={tool.id} tool={tool} selected={picked?.has(tool.id) ?? false} onSelect={(on) => toggle(tool.id, on)} />
            ))
          )}
          <p className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("toolSetup.later")}</p>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] p-3">
          <button onClick={dismiss} disabled={!!installing} className={buttonClass({ variant: "ghost" })}>
            {t(chosen.length > 0 ? "toolSetup.skip" : "toolSetup.continue")}
          </button>
          <button
            onClick={() => void installMany(chosen.map((tool) => tool.id))}
            disabled={chosen.length === 0 || !!installing}
            className={buttonClass({ variant: "primary" })}
          >
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t(installing ? "toolSetup.installing" : "toolSetup.installSelected", { n: chosen.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
