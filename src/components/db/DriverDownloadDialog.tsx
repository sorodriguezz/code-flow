import { useEffect, useMemo, useRef } from "react";
import { CheckCircle2, Coffee, Download, ExternalLink, FileArchive, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { DriverGlyph } from "./DbLogo";
import { buttonClass } from "../common/Button";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { openExternalUrl } from "../../lib/tauri/commands";
import { effectiveDriver, formatBytes, JAVA_RELEASE } from "../../lib/db/drivers";
import { driverReadiness, useDriverStore } from "../../state/driverStore";
import { useT } from "../../state/languageStore";
import type { DbDriverProgress } from "../../types/database";

/**
 * "Incomplete configuration — driver files are not downloaded", asked when a connect needs a driver
 * whose files are not on disk yet: what DataGrip asks on Test Connection, and the reason the app no
 * longer ships fifty megabytes of Java for the few who open an Oracle connection.
 *
 * It names what the download will fetch, sized — the Java runtime too, the first time, since every
 * JDBC driver runs on it — and the vendor's licence, which downloading is accepting. The download
 * runs in the dialog with a bar per file; once everything is there it closes by itself and whatever
 * asked (`useDriverStore.ask`) retries. Cancel leaves a download already started running: the
 * files are just as useful to the next attempt.
 *
 * A driver nobody may redistribute gets the other variant: where to get the files, and a button to
 * the driver's settings where they are added.
 *
 * Mounted once, by the database workspace, outside its modal slot — it opens over the connection
 * dialog, which has to still be there for the retry.
 */
export function DriverDownloadDialog() {
  const t = useT();
  const prompt = useDriverStore((s) => s.prompt);
  const overview = useDriverStore((s) => s.overview);
  const overviewAt = useDriverStore((s) => s.overviewAt);
  const settings = useDriverStore((s) => s.settings);
  const progress = useDriverStore((s) => s.progress);
  const downloading = useDriverStore((s) => s.downloading);
  const errors = useDriverStore((s) => s.errors);
  const answer = useDriverStore((s) => s.answer);
  const panelRef = useRef<HTMLDivElement>(null);

  // Above the early return — see `PromptModal` for what a hook after it does to the whole window.
  useFocusTrap(panelRef, prompt !== null);

  const def = useMemo(() => (prompt ? effectiveDriver(prompt.driverId, settings) : null), [prompt, settings]);
  const busy = prompt !== null && downloading.includes(prompt.driverId);
  const error = prompt ? errors[prompt.driverId] : undefined;
  const ready = def ? driverReadiness(def, overview, settings) : null;

  // Everything arrived — from this dialog, or from the Drivers list meanwhile: the question has been
  // answered, and the connect that asked it is waiting to run again. Only on an overview read after
  // the question was asked: an older one can still say "ready" about files the backend just reported
  // missing, and answering from it would retry straight into the same question.
  useEffect(() => {
    if (prompt?.kind !== "missing" || busy || overviewAt < prompt.askedAt) return;
    if (ready?.files && ready.runtime) answer(true);
  }, [prompt, busy, ready?.files, ready?.runtime, overviewAt, answer]);

  useEffect(() => {
    if (!prompt) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        answer(false);
      }
    };
    // Capture, so the Escape closes this and not the dialog underneath it.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [prompt, answer]);

  if (!prompt) return null;

  const name = def?.name ?? prompt.driverId;
  const missingFiles = (ready?.status?.files ?? []).filter((file) => !file.present && !file.user);
  const needsRuntime = ready ? !ready.runtime : true;
  const rows = progress.filter((entry) => entry.driverId === prompt.driverId);

  const download = async () => {
    await useDriverStore.getState().download(prompt.driverId);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4" onClick={() => answer(false)}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("db.drivers.incompleteTitle")}
        tabIndex={-1}
        className="cf-fade-in max-h-[calc(100vh-2rem)] w-[500px] max-w-[92vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]"
      >
        <div className="mb-3 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]">
            <TriangleAlert size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--cf-text)]">{t("db.drivers.incompleteTitle")}</p>
            <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
              <DriverGlyph driver={def} size={14} />
              <span className="truncate">{name}</span>
            </p>
          </div>
        </div>

        {prompt.kind === "manual" ? (
          <p className="mb-4 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-[var(--cf-text)]">
            {prompt.message || t("db.drivers.manualHint", { name })}
          </p>
        ) : (
          <>
            <p className="mb-3 text-[12.5px] leading-relaxed text-[var(--cf-text)]">
              {t("db.drivers.notDownloaded")}
            </p>

            <ul className="mb-3 space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
              {needsRuntime && (
                <DownloadRow
                  icon={<Coffee size={13} />}
                  name={t("db.drivers.runtimeName", { java: JAVA_RELEASE })}
                  detail={t("db.drivers.runtimeDetail")}
                  progress={rows.find((entry) => entry.item.startsWith("Java"))}
                />
              )}
              {missingFiles.map((file) => (
                <DownloadRow
                  key={file.path}
                  icon={<FileArchive size={13} />}
                  name={file.name}
                  detail={file.size ? formatBytes(file.size) : ""}
                  progress={rows.find((entry) => entry.item === file.name)}
                />
              ))}
              {!needsRuntime && missingFiles.length === 0 && (
                <li className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
                  <Loader2 size={12} className="animate-spin" />
                  {t("db.drivers.checking")}
                </li>
              )}
            </ul>

            {def?.license && (
              <p className="mb-3 text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("db.drivers.licenseNote", { name })}{" "}
                <button
                  type="button"
                  onClick={() => void openExternalUrl(def.license!)}
                  className="inline-flex items-center gap-0.5 text-[var(--cf-accent)] hover:underline"
                >
                  {t("db.drivers.license")}
                  <ExternalLink size={10} />
                </button>
              </p>
            )}
          </>
        )}

        {error && (
          <p className="mb-3 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-danger)]">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button onClick={() => answer(false)} className={buttonClass({ variant: "ghost" })}>
            {t("common.cancel")}
          </button>
          {prompt.kind === "manual" ? (
            <button
              onClick={() => {
                const id = prompt.driverId;
                answer(false);
                useDriverStore.getState().showDriver(id);
              }}
              className={buttonClass({ variant: "primary" })}
            >
              {t("db.drivers.openSettings")}
            </button>
          ) : (
            <button
              onClick={() => void download()}
              disabled={busy}
              className={buttonClass({ variant: "primary" })}
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : error ? (
                <RotateCw size={12} />
              ) : (
                <Download size={12} />
              )}
              {error ? t("db.drivers.retryDownload") : t("db.drivers.downloadFiles")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One thing the download fetches, with its bar once it has started. */
function DownloadRow({
  icon,
  name,
  detail,
  progress,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  progress?: DbDriverProgress;
}) {
  const t = useT();
  const fraction = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  const phase = progress?.phase;
  return (
    <li className="text-[12px]">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[var(--cf-text-muted)]">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]">{name}</span>
        <span className="shrink-0 tabular-nums text-[11px] text-[var(--cf-text-muted)]">
          {phase === "done" ? (
            <CheckCircle2 size={12} className="text-[var(--cf-success)]" />
          ) : phase === "verifying" ? (
            t("db.drivers.verifying")
          ) : phase === "extracting" ? (
            t("db.drivers.extracting")
          ) : phase === "downloading" && progress ? (
            `${formatBytes(progress.done)}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}`
          ) : (
            detail
          )}
        </span>
      </div>
      {(phase === "downloading" || phase === "verifying" || phase === "extracting") && (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--cf-hover)]">
          <div
            className={`h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-200 ${
              phase !== "downloading" ? "animate-pulse" : ""
            }`}
            style={{ width: `${phase === "downloading" ? Math.round(fraction * 100) : 100}%` }}
          />
        </div>
      )}
      {phase === "failed" && progress?.error && (
        <p className="mt-0.5 text-[11px] text-[var(--cf-danger)]">{progress.error}</p>
      )}
    </li>
  );
}
