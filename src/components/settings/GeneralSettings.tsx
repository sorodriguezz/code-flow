import { useEffect, useState } from "react";
import { FolderOpen, GraduationCap, Loader2, LogOut, Trash2 } from "lucide-react";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { APP_TOURS, type TourId } from "../../lib/tour/steps";
import { tourLength, useTourStore } from "../../state/tourStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { Language } from "../../lib/i18n/translations";
import { deleteLegacyData, quitApp, resetAppData, revealInFileManager } from "../../lib/tauri/commands";
import { confirmAction } from "../../state/confirmStore";
import { useDataDirsStore } from "../../state/dataDirsStore";
import { useToastStore } from "../../state/toastStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useWindowStore } from "../../state/windowStore";
// Shared with the backup panel, which formats the same kind of number for the same reason.
import { formatBytes } from "../../lib/tauri/backupCommands";
import { UpdateSection } from "./UpdateSection";
import { PaneBlock, RailSection } from "./settingsNav";

// Language names stay in their own language (endonyms) — "English"/"Español" don't change
// depending on the currently selected UI language, same as any language picker.
const OPTIONS: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

/** The satellite-window limits on offer — see the note where they are drawn. */
const WINDOW_LIMITS = [0, 1, 2, 3, 4, 5, 6, 8];

/** A destructive action drawn as an outline: the danger text on a thin danger rule, filled only
 *  under the pointer. Quieter than a red slab for buttons that still ask for confirmation. */
const DANGER_OUTLINE = "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--cf-danger)_35%,transparent)]";

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
  const satelliteLimit = usePreferencesStore((s) => s.satelliteLimit);
  const setSatelliteLimit = usePreferencesStore((s) => s.setSatelliteLimit);
  const openWindows = useWindowStore((s) => s.satellites.length);
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
    <RailSection section="general" title={t("settings.general")} hint={t("settings.generalHint")} fallback="language">
      {(tab) => (
        <>
          {tab === "language" && (
            <>
              <PaneBlock title={t("settings.tabLanguage")} hint={t("settings.languageHint")}>
                {/* Two peers that change how the same app is written: the segmented control. */}
                <Segmented
                  options={OPTIONS}
                  value={language}
                  onChange={(value) => setLanguage(value)}
                  layoutId="cf-set-language"
                  ariaLabel={t("settings.tabLanguage")}
                />
                <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.translationNote")}</p>
              </PaneBlock>

              {/* Bare: this block's heading names it, and its own explanation — and the site and Ko-fi
                  buttons under it — stay. */}
              <PaneBlock title={t("settings.updatesTitle")}>
                <UpdateSection bare />
              </PaneBlock>
            </>
          )}

          {/* One block each, so the rail names them and the pane's hint explains them. */}
          {tab === "windows" && (
            <>
              {/* Buttons rather than a number field: the useful range is 0–8 and every value in it is one
                  press away, which is faster to set and impossible to mistype. Zero is a real choice —
                  "never open a second window" — so it is offered rather than clamped away. One
                  segmented track rather than eight loose buttons: it is one choice among peers. */}
              <Segmented
                options={WINDOW_LIMITS.map((n) => ({
                  value: String(n),
                  label: <span className="min-w-3 tabular-nums">{n}</span>,
                }))}
                value={String(satelliteLimit)}
                onChange={(value) => void setSatelliteLimit(Number(value))}
                layoutId="cf-set-window-limit"
                ariaLabel={t("windows.limitLabel")}
              />
              {/* What is open right now, so raising or lowering the limit is a decision with the current
                  state in front of it rather than an abstract number. */}
              <p className="mt-2 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                {t("windows.openNow", { count: String(openWindows) })}
              </p>
            </>
          )}

          {tab === "tours" && (
            <>
              {/* Every tour there is, from one screen. The launchers in the chrome are contextual by
                  design — the cap in the tab bar only offers the app you already have open — which is
                  right when you are working and wrong when you are looking for one. This is the list. */}
              <button
                type="button"
                onClick={() => launch()}
                className={buttonClass({ variant: "secondary", size: "lg", className: "w-full justify-start" })}
              >
                <GraduationCap size={14} className="shrink-0 text-[var(--cf-accent)]" />
                {t("tour.restart")}
                <span className="ml-auto shrink-0 text-[11px] font-normal tabular-nums text-[var(--cf-text-muted)]">
                  {t("tour.stepCount", { n: tourLength("main") })}
                </span>
              </button>

              <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                {t("tour.settingsApps")}
              </p>
              {/* Two columns: one row per app in a single column is a long thin list for a handful of
                  short names, and the settings pane is wide enough that one column wastes most of it. */}
              <div className="grid grid-cols-2 gap-2">
                {APP_TOURS.map(({ tour, labelKey, icon: Icon }) => (
                  <button
                    key={tour}
                    type="button"
                    onClick={() => launch(tour)}
                    // The secondary button, let grow past its 32px so a long name wraps (`h-auto`;
                    // the label span takes back the wrapping the recipe's `nowrap` takes away).
                    className={buttonClass({
                      variant: "secondary",
                      size: "lg",
                      className: "h-auto min-h-8 justify-start py-1.5 text-left font-normal",
                    })}
                  >
                    <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
                    <span className="min-w-0 whitespace-normal break-words leading-snug">{t(labelKey)}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                      {t("tour.stepCount", { n: tourLength(tour) })}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-[var(--cf-text-muted)]">{t("tour.settingsAppsHint")}</p>
            </>
          )}

          {tab === "data" && (
            <>
              <PaneBlock title={t("settings.appLifecycle")} hint={t("settings.appLifecycleHint")}>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (await confirmAction(t("settings.quitConfirm"))) void quitApp();
                    }}
                    className={buttonClass({ variant: "danger-ghost", size: "md", className: DANGER_OUTLINE })}
                  >
                    <LogOut size={14} />
                    {t("settings.quitApp")}
                  </button>
                </div>
              </PaneBlock>

              {/* Where the files are.
                  Three rows rather than one, because since v1.19 there are three directories and they are
                  not siblings — and because the row that matters most to a person is the third one, which
                  says that the reset button below cannot reach their repositories. */}
              <PaneBlock title={t("settings.dataLocations")} hint={t("settings.dataLocationsHint")}>
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
                      className="flex min-h-10 items-center gap-2 border-b border-[var(--cf-border)] py-1.5 pl-3 pr-2 last:border-b-0"
                    >
                      <span className="w-[150px] shrink-0 text-[13px] text-[var(--cf-text-muted)]">{t(key)}</span>
                      <span className="min-w-0 flex-1 select-text truncate font-mono text-[12px]" title={path ?? ""}>
                        {path ?? "…"}
                      </span>
                      <Tooltip label={t("settings.dataReveal")}>
                        <button
                          type="button"
                          disabled={!path}
                          onClick={() => path && void revealInFileManager(path)}
                          aria-label={t("settings.dataReveal")}
                          className={iconButtonClass({ size: "sm" })}
                        >
                          <FolderOpen size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  ))}
                </div>

                {/* Only after a migration actually left one behind. A row that says "0 bytes to reclaim"
                    on every clean install would be a permanent question with no answer. */}
                {layout && layout.legacyCopies.length > 0 && (
                  <div className="mt-3 rounded-lg border border-[var(--cf-border)] p-3">
                    <p className="text-[13px] font-medium text-[var(--cf-text)]">{t("settings.legacyCopy")}</p>
                    <p className="mt-1 text-[12px] leading-snug text-[var(--cf-text-muted)]">
                      {t("settings.legacyCopyHint", {
                        path: layout.legacyDir,
                        size: formatBytes(layout.legacyCopyBytes),
                      })}
                    </p>
                    <button
                      type="button"
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
                      className={buttonClass({ variant: "danger-ghost", size: "sm", className: `mt-2.5 ${DANGER_OUTLINE}` })}
                    >
                      {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      {t("settings.legacyCopyButton")}
                    </button>
                  </div>
                )}
              </PaneBlock>

              <PaneBlock
                title={t("settings.resetData")}
                hint={t("settings.resetDataHint", { path: dataPath, userPath: layout?.userDir ?? "…" })}
              >
                <button
                  type="button"
                  onClick={async () => {
                    if (await confirmAction(t("settings.resetDataConfirm", { path: dataPath }))) void resetAppData();
                  }}
                  className={buttonClass({ variant: "danger-ghost", size: "md", className: DANGER_OUTLINE })}
                >
                  <Trash2 size={14} />
                  {t("settings.resetDataButton")}
                </button>
              </PaneBlock>
            </>
          )}
        </>
      )}
    </RailSection>
  );
}
