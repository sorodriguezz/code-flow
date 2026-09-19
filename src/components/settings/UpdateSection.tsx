import { Check, Coffee, Download, Globe, Loader2, RefreshCw, RotateCw, Sparkles, TriangleAlert } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUpdateStore } from "../../state/updateStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/** Where the support button goes. Opened in the system browser rather than the app's own webview,
 *  and that is not a detail: a payment page inside CodeFlow is a page with no address bar, and
 *  nobody should be asked to reach for a card in a window that cannot prove where it is. */
const KOFI_URL = "https://ko-fi.com/sorodriguezz";

/** The product page — what CodeFlow is, for somebody who has not got it yet. It lives next to the
 *  support button because they answer the same two questions a person has on this screen: what is
 *  this, and how do I say thanks. */
const SITE_URL = "https://getcodeflow.vercel.app";

/** Both links leave the app the same way, and that is the whole rule: a site rendered inside
 *  CodeFlow would be a browser with no address bar, no back button and no way for the user to tell
 *  what they are looking at. `catch` because a machine with no handler for http(s) is not a reason
 *  to throw inside a settings pane. */
const openExternally = (url: string) => () => void openUrl(url).catch(() => {});

/** Self-service updater: downloads the published GitHub release for a newer signed build and
 * installs it in place, so the user never has to uninstall/reinstall by hand. Only works in the
 * packaged app (in `tauri dev` there's no installed binary to replace — `check()` errors).
 *
 * All of it — status, the pending release, download progress — lives in the update store, which
 * the hourly background check writes to as well. So this panel already knows about an update
 * found minutes ago instead of making the user press "Check for updates" to be told what the
 * title bar has been showing all along. */
export function UpdateSection() {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const version = useUpdateStore((s) => s.currentVersion);
  const status = useUpdateStore((s) => s.status);
  const update = useUpdateStore((s) => s.update);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const noBuildForPlatform = useUpdateStore((s) => s.noBuildForPlatform);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const checkNow = useUpdateStore((s) => s.checkNow);
  const install = useUpdateStore((s) => s.install);
  const restart = useUpdateStore((s) => s.restart);
  const openNotes = useUpdateStore((s) => s.openNotes);

  const btnPrimary =
    "flex items-center gap-2 rounded-md bg-[var(--cf-accent)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50";
  const btnOutline =
    "flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-[13px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]";

  return (
    <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
      <h3 className="mb-1 text-sm font-semibold">{t("settings.updatesTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
        {t("settings.updatesHint")} {t("update.autoHint")}
      </p>

      {version && (
        <p className="mb-3 text-[12px] text-[var(--cf-text-muted)]">
          {t("settings.currentVersion")}: <span className="font-mono text-[var(--cf-text)]">v{version}</span>
          {lastCheckedAt !== null && (
            <>
              {" · "}
              {t("update.lastChecked", {
                time: new Date(lastCheckedAt).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}
            </>
          )}
        </p>
      )}

      {/* The two buttons share a row but not a condition. "Check for updates" is gone while a
          download runs, and a support link that blinked out of existence alongside it would read as
          a bug rather than as tact — so it renders unconditionally and simply sits alone for the
          minute an update takes. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Idle / up-to-date / error → "Check for updates" */}
        {(status === "idle" || status === "checking" || status === "uptodate" || status === "error") && (
          <button onClick={() => void checkNow(true)} disabled={status === "checking"} className={btnOutline}>
            {status === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {status === "checking" ? t("settings.checkingUpdates") : t("settings.checkForUpdates")}
          </button>
        )}

        <button onClick={openExternally(SITE_URL)} className={btnOutline} title={t("settings.visitSiteHint")}>
          <Globe size={14} />
          {t("settings.visitSite")}
        </button>

        {/* Outline, never the accent: the app is free and stays free, so this asks once and quietly
            from a screen the user already had a reason to open. Only the icon carries Ko-fi's own
            red — the accent colour is the user's to choose, and a brand mark that changes hue with
            the theme stops reading as the brand it links to. */}
        <button onClick={openExternally(KOFI_URL)} className={btnOutline} title={t("settings.supportKofiHint")}>
          <Coffee size={14} className="text-[#ff5e5b]" />
          {t("settings.supportKofi")}
        </button>
      </div>

      {/* Two ways to have nothing to install, and they are not the same sentence: "you are on the
          latest" would be a claim nobody checked when the release simply has no build for this
          platform. Neither is an error, so neither is red. */}
      {status === "uptodate" &&
        (noBuildForPlatform ? (
          <p className="mt-2 text-[12px] text-[var(--cf-text-muted)]">{t("settings.updateNoBuild")}</p>
        ) : (
          <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--cf-success)]">
            <Check size={13} />
            {t("settings.upToDate")}
          </p>
        ))}

      {status === "available" && update && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-[var(--cf-text)]">
            {t("settings.updateAvailable", { version: `v${update.version}` })}
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => void install()} className={btnPrimary}>
              <Download size={14} />
              {t("settings.installUpdate", { version: `v${update.version}` })}
            </button>
            {/* Reading first is a legitimate answer to "should I update?", so it sits next to
                the install button rather than behind it. */}
            <button onClick={openNotes} className={btnOutline}>
              <Sparkles size={14} />
              {t("update.seeWhatsNew")}
            </button>
          </div>
        </div>
      )}

      {status === "downloading" && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[13px] text-[var(--cf-text)]">
            <Loader2 size={14} className="animate-spin" />
            {t("settings.downloadingUpdate", { progress: progress })}
          </p>
          <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-[var(--cf-border)]">
            <div className="h-full rounded-full bg-[var(--cf-accent)] transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {status === "ready" && (
        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-1.5 text-[13px] text-[var(--cf-success)]">
            <Check size={14} />
            {t("settings.updateReady")}
          </p>
          <button onClick={() => void restart()} className={`${btnPrimary} self-start`}>
            <RotateCw size={14} />
            {t("settings.restartNow")}
          </button>
        </div>
      )}

      {status === "error" && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-[var(--cf-danger)]">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            {t("settings.updateError")}
            {error && <span className="mt-0.5 block break-all font-mono text-[11px] opacity-80">{error}</span>}
          </span>
        </p>
      )}
    </div>
  );
}
