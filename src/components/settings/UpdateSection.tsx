import { useEffect, useState } from "react";
import { Check, Download, Loader2, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { useT } from "../../state/languageStore";

type Status = "idle" | "checking" | "uptodate" | "available" | "downloading" | "ready" | "error";

/** Self-service updater: checks the published GitHub release for a newer signed build and installs
 * it in place, so the user never has to uninstall/reinstall by hand. Only works in the packaged
 * app (in `tauri dev` there's no installed binary to replace — `check()` errors, handled below). */
export function UpdateSection() {
  const t = useT();
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const checkForUpdates = async () => {
    setStatus("checking");
    setError("");
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  const installUpdate = async () => {
    if (!update) return;
    setStatus("downloading");
    setProgress(0);
    try {
      let total = 0;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  const btnPrimary =
    "flex items-center gap-2 rounded-md bg-[var(--cf-accent)] px-3 py-2 text-[13px] font-medium text-white disabled:opacity-50";
  const btnOutline =
    "flex items-center gap-2 rounded-md border border-[var(--cf-border)] px-3 py-2 text-[13px] font-medium text-[var(--cf-text)] hover:bg-black/[0.03] disabled:opacity-50 dark:hover:bg-white/[0.04]";

  return (
    <div className="mt-6 border-t border-[var(--cf-border)] pt-4">
      <h3 className="mb-1 text-sm font-semibold">{t("settings.updatesTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.updatesHint")}</p>

      {version && (
        <p className="mb-3 text-[12px] text-[var(--cf-text-muted)]">
          {t("settings.currentVersion")}: <span className="font-mono text-[var(--cf-text)]">v{version}</span>
        </p>
      )}

      {/* Idle / up-to-date / error → "Check for updates" */}
      {(status === "idle" || status === "checking" || status === "uptodate" || status === "error") && (
        <button onClick={checkForUpdates} disabled={status === "checking"} className={btnOutline}>
          {status === "checking" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {status === "checking" ? t("settings.checkingUpdates") : t("settings.checkForUpdates")}
        </button>
      )}

      {status === "uptodate" && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] text-[var(--cf-success)]">
          <Check size={13} />
          {t("settings.upToDate")}
        </p>
      )}

      {status === "available" && update && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-[var(--cf-text)]">
            {t("settings.updateAvailable", { version: `v${update.version}` })}
          </p>
          <button onClick={installUpdate} className={`${btnPrimary} self-start`}>
            <Download size={14} />
            {t("settings.installUpdate", { version: `v${update.version}` })}
          </button>
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
          <button onClick={() => void relaunch()} className={`${btnPrimary} self-start`}>
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
