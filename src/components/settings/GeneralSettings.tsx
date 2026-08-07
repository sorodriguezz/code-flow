import { GraduationCap, LogOut, Trash2 } from "lucide-react";
import { ActivePill } from "../common/ActivePill";
import { APP_TOURS, type TourId } from "../../lib/tour/steps";
import { tourLength, useTourStore } from "../../state/tourStore";
import { useUiStore } from "../../state/uiStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { Language } from "../../lib/i18n/translations";
import { quitApp, resetAppData } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { usePlatform } from "../../lib/platform";
import { UpdateSection } from "./UpdateSection";
import { SettingsHeader } from "../api/settingsChrome";

// Language names stay in their own language (endonyms) — "English"/"Español" don't change
// depending on the currently selected UI language, same as any language picker.
const OPTIONS: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "es", label: "Español" },
];

export function GeneralSettings() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const platform = usePlatform();
  const dataPath = platform === "windows" ? "C:\\CodeFlow" : "~/CodeFlow";
  const startTour = useTourStore((s) => s.start);
  const closeSettings = useUiStore((s) => s.closeSettings);

  /**
   * Settings is closed first, then the tour is started.
   *
   * Every tour begins by staging a screen behind this dialog — the sidebar for the main one, an app
   * for the other five — and starting from underneath an open settings would put the first
   * spotlight on something nobody can see. The tour reopens it at the end anyway: this dialog is
   * part of the state it snapshots, so finishing returns you to the screen you launched from.
   */
  const launch = (tour?: TourId) => {
    closeSettings();
    startTour(tour ? { tour } : undefined);
  };

  return (
    <section>
      <SettingsHeader title={t("settings.general")} hint={t("settings.languageHint")} />
      <div className="flex gap-2">
        {OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => setLanguage(opt.id)}
            className={`relative flex-1 rounded-lg border px-3 py-2.5 text-[13px] font-medium ${
              language === opt.id
                ? "border-transparent text-[var(--cf-accent)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            }`}
          >
            {language === opt.id && <ActivePill layoutId="cf-language-pill" inset="-inset-px" radius="rounded-lg" />}
            <span className="relative">{opt.label}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.translationNote")}</p>

      <UpdateSection />

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("tour.settingsTitle")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("tour.settingsHint")}</p>
        {/* Every tour there is, from one screen. The launchers in the chrome are contextual by
            design — the cap in the tab bar only offers the app you already have open — which is
            right when you are working and wrong when you are looking for one. This is the list. */}
        <button
          onClick={() => launch()}
          className="flex w-full items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-left text-[13px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <GraduationCap size={14} className="shrink-0 text-[var(--cf-accent)]" />
          {t("tour.restart")}
          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
            {t("tour.stepCount", { n: tourLength("main") })}
          </span>
        </button>

        <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("tour.settingsApps")}
        </p>
        {/* Two columns: five rows in one column is a long thin list for five short names, and the
            settings pane is wide enough that a single column wastes most of it. */}
        <div className="grid grid-cols-2 gap-2">
          {APP_TOURS.map(({ tour, labelKey, icon: Icon }) => (
            <button
              key={tour}
              onClick={() => launch(tour)}
              className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-left text-[13px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 truncate">{t(labelKey)}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                {t("tour.stepCount", { n: tourLength(tour) })}
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{t("tour.settingsAppsHint")}</p>
      </div>

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.appLifecycle")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.appLifecycleHint")}</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={async () => {
              if (await confirmAction(t("settings.quitConfirm"))) void quitApp();
            }}
            className="flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-[13px] font-medium text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)]"
          >
            <LogOut size={14} />
            {t("settings.quitApp")}
          </button>
        </div>
      </div>

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.resetData")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
          {t("settings.resetDataHint", { path: dataPath })}
        </p>
        <button
          onClick={async () => {
            if (await confirmAction(t("settings.resetDataConfirm", { path: dataPath }))) void resetAppData();
          }}
          className="flex items-center gap-2 rounded-md border border-[var(--cf-danger)]/40 px-3 py-2 text-[13px] font-medium text-[var(--cf-danger)] hover:bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)]"
        >
          <Trash2 size={14} />
          {t("settings.resetDataButton")}
        </button>
      </div>
    </section>
  );
}
