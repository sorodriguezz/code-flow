import { useEffect, useState } from "react";
import { FolderOpen, GraduationCap, LogOut, Trash2 } from "lucide-react";
import { ActivePill } from "../common/ActivePill";
import { APP_TOURS, type TourId } from "../../lib/tour/steps";
import { tourLength, useTourStore } from "../../state/tourStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { Language } from "../../lib/i18n/translations";
import { deleteLegacyData, quitApp, resetAppData, revealInFileManager } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { useDataDirsStore } from "../../state/dataDirsStore";
import { useToastStore } from "../../state/toastStore";
// Shared with the backup panel, which formats the same kind of number for the same reason.
import { formatBytes } from "../../lib/tauri/backupCommands";
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
  const startTour = useTourStore((s) => s.start);
  // Asked, not guessed. This line used to be
  // `platform === "windows" ? "C:\\CodeFlow" : "~/CodeFlow"` — a second, independent copy of
  // `paths.rs`'s platform branch, which was right until the v1.19 layout change made it wrong and
  // would have gone on being displayed with total confidence.
  const layout = useDataDirsStore((s) => s.status);
  const loadLayout = useDataDirsStore((s) => s.load);
  const refreshLayout = useDataDirsStore((s) => s.refresh);
  const [deleting, setDeleting] = useState(false);
  const pushToast = useToastStore((s) => s.pushToast);
  const dataPath = layout?.stateDir ?? "…";

  useEffect(() => {
    void loadLayout();
  }, [loadLayout]);

  /**
   * Starting the tour is the whole of it. It closes this dialog itself.
   *
   * Every tour begins by staging a screen behind this dialog — the sidebar for the main one, an app
   * for the other five — and the stage is applied whole, so `settingsOpen` comes out false on the
   * first step whether or not anybody closed it first. Which makes the `closeSettings()` that used
   * to run here not merely redundant but the bug: `start` snapshots the app *before* it stages
   * anything, so closing the dialog one line earlier meant the snapshot recorded settings as
   * already shut. Finishing then restored it faithfully — to closed — and the tour that promises to
   * leave every panel as it found it dropped you on the graph instead of back on this screen.
   *
   * Left to `applyStage` rather than reordered into `closeSettings(); startTour()`, because the
   * stage is the thing that decides what the first step needs on screen: a tour whose opening step
   * one day *wants* a settings section would have had that undone by a close sitting out here.
   */
  const launch = (tour?: TourId) => {
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
        {/* Two columns: one row per app in a single column is a long thin list for a handful of
            short names, and the settings pane is wide enough that one column wastes most of it. */}
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

      {/* Where the files are.
          Three rows rather than one, because since v1.19 there are three directories and they are
          not siblings — and because the row that matters most to a person is the third one, which
          says that the reset button below cannot reach their repositories. */}
      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.dataLocations")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.dataLocationsHint")}</p>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {(
            [
              ["settings.dataStateDir", layout?.stateDir],
              ["settings.dataCacheDir", layout?.cacheDir],
              ["settings.dataUserDir", layout?.userDir],
            ] as const
          ).map(([key, path]) => (
            <div
              key={key}
              className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0"
            >
              <span className="w-[150px] shrink-0 text-[12.5px] text-[var(--cf-text-muted)]">{t(key)}</span>
              <span className="min-w-0 flex-1 select-text truncate font-mono text-[11.5px]" title={path ?? ""}>
                {path ?? "…"}
              </span>
              <button
                disabled={!path}
                onClick={() => path && void revealInFileManager(path)}
                aria-label={t("settings.dataReveal")}
                title={t("settings.dataReveal")}
                className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.06]"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          ))}
        </div>

        {/* Only after a migration actually left one behind. A row that says "0 bytes to reclaim"
            on every clean install would be a permanent question with no answer. */}
        {layout && layout.legacyCopies.length > 0 && (
          <div className="mt-3 rounded-lg border border-[var(--cf-border)] p-3">
            <p className="text-[12.5px] font-medium">{t("settings.legacyCopy")}</p>
            <p className="mt-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
              {t("settings.legacyCopyHint", {
                path: layout.legacyDir,
                size: formatBytes(layout.legacyCopyBytes),
              })}
            </p>
            <button
              disabled={deleting}
              onClick={async () => {
                if (!(await confirmAction(t("settings.legacyCopyConfirm")))) return;
                setDeleting(true);
                try {
                  const freed = await deleteLegacyData();
                  await refreshLayout();
                  pushToast(t("settings.legacyCopyDone", { size: formatBytes(freed) }), "success");
                } catch (e) {
                  pushToast(String(e));
                } finally {
                  setDeleting(false);
                }
              }}
              className="mt-2 flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12.5px] font-medium text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)]/40 hover:text-[var(--cf-danger)] disabled:opacity-50"
            >
              <Trash2 size={13} />
              {t("settings.legacyCopyButton")}
            </button>
          </div>
        )}
      </div>

      <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-1 text-sm font-semibold">{t("settings.resetData")}</h3>
        <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
          {t("settings.resetDataHint", { path: dataPath, userPath: layout?.userDir ?? "…" })}
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
