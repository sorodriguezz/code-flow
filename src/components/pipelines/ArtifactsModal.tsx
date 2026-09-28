import { useEffect } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ArrowDownToLine, Check, FolderOpen, Package, Square } from "lucide-react";
import { revealInFileManager } from "../../lib/tauri/commands";
import { artifactKey, runKey, useCiStore, type ArtifactDownload } from "../../state/ciStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { ApiModal } from "../api/ApiModal";
import { iconButtonClass } from "../common/Button";
import { Skeleton } from "../common/Skeleton";
import { Tooltip } from "../common/Tooltip";
import { formatSize } from "./pipelineStatus";
import type { PipelineArtifact, PipelineRun } from "../../types/domain";

/**
 * A run's artifacts, and the way to save one.
 *
 * Saved as the zip the host delivers, never unpacked: what the user asked for is the artifact, and
 * an extraction that fails half way leaves a folder of half the files that looks like all of them.
 * The download streams to disk behind a `.part` name and is only renamed once it is complete — see
 * `ci::http::download_to_file` — so the file the user chose either exists whole or not at all.
 *
 * Fetched when opened and never polled: a list of files is a request most runs never need.
 */
export function ArtifactsModal({
  projectId,
  run,
  onClose,
}: {
  projectId: string;
  run: PipelineRun;
  onClose: () => void;
}) {
  const t = useT();
  const key = runKey(projectId, run);
  const artifacts = useCiStore((s) => s.artifactsByRun[key]);
  const busy = useCiStore((s) => s.artifactsBusy[key] === true);
  const error = useCiStore((s) => s.artifactsError[key] ?? "");
  const downloads = useCiStore((s) => s.downloads);
  const loadArtifacts = useCiStore((s) => s.loadArtifacts);
  const downloadArtifact = useCiStore((s) => s.downloadArtifact);
  const cancelDownload = useCiStore((s) => s.cancelDownload);

  useEffect(() => {
    void loadArtifacts(projectId, run);
    // Keyed on the run's identity, not on the object: the poll hands a new object every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, run.id, run.provider, loadArtifacts]);

  const download = async (artifact: PipelineArtifact) => {
    const path = await saveDialog({
      defaultPath: artifact.file_name,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    }).catch(() => null);
    if (!path) return;
    try {
      await downloadArtifact(projectId, run, artifact, path);
      const finished = useCiStore.getState().downloads[artifactKey(projectId, run, artifact.id)];
      if (finished?.state === "done") pushSuccessToast(t("pipelines.artifactSavedToast", { name: artifact.name }));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <ApiModal icon={Package} title={t("pipelines.artifactsTitle", { name: run.name })} width="max-w-lg" onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
        {error && !artifacts ? (
          <p className="px-2 py-2 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : !artifacts && busy ? (
          <div className="flex flex-col gap-1.5 p-1">
            <Skeleton className="h-9 rounded-md" />
            <Skeleton className="h-9 rounded-md" />
          </div>
        ) : artifacts && artifacts.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-[var(--cf-text-muted)]">{t("pipelines.artifactsEmpty")}</p>
        ) : (
          (artifacts ?? []).map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              download={downloads[artifactKey(projectId, run, artifact.id)]}
              onDownload={() => void download(artifact)}
              onStop={() => cancelDownload(artifactKey(projectId, run, artifact.id))}
            />
          ))
        )}
      </div>
    </ApiModal>
  );
}

function ArtifactRow({
  artifact,
  download,
  onDownload,
  onStop,
}: {
  artifact: PipelineArtifact;
  download: ArtifactDownload | undefined;
  onDownload: () => void;
  onStop: () => void;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => (s.language === "es" ? "es-ES" : "en-US"));
  const running = download?.state === "running";
  const expires = artifact.expires_at ? new Date(artifact.expires_at) : null;
  const fraction =
    running && download.total && download.total > 0 ? Math.min(1, download.done / download.total) : null;

  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-[var(--cf-hover)]">
      <div className="flex items-center gap-2">
        <Package size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`min-w-0 truncate text-[12.5px] font-medium ${artifact.expired ? "text-[var(--cf-text-muted)] line-through" : ""}`}>
          {artifact.name}
        </span>
        {artifact.job_name && artifact.job_name !== artifact.name && (
          <span className="shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">{artifact.job_name}</span>
        )}
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
          {running && download.done > 0 ? `${formatSize(download.done)} / ` : ""}
          {formatSize(artifact.size_bytes ?? download?.total ?? null)}
        </span>
        {artifact.expired ? (
          <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("pipelines.artifactExpired")}</span>
        ) : expires && !Number.isNaN(expires.getTime()) ? (
          <Tooltip label={expires.toLocaleString(locale)}>
            <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
              {t("pipelines.artifactExpires", {
                date: expires.toLocaleDateString(locale, { day: "2-digit", month: "short" }),
              })}
            </span>
          </Tooltip>
        ) : null}
        {running ? (
          <Tooltip label={t("pipelines.artifactStop")}>
            <button type="button" aria-label={t("pipelines.artifactStop")} onClick={onStop} className={iconButtonClass({ size: "xs" })}>
              <Square size={10} />
            </button>
          </Tooltip>
        ) : download?.state === "done" ? (
          <Tooltip label={t("pipelines.artifactShow")} description={download.path}>
            <button
              type="button"
              aria-label={t("pipelines.artifactShow")}
              onClick={() => void revealInFileManager(download.path).catch((e: unknown) => pushErrorToast(String(e)))}
              className={`group/saved ${iconButtonClass({ size: "xs" })}`}
            >
              {/* Saved, at a glance; where to, on hover — the check becomes the folder it opens. */}
              <Check size={12} className="text-[var(--cf-success)] group-hover/saved:hidden" />
              <FolderOpen size={12} className="hidden group-hover/saved:block" />
            </button>
          </Tooltip>
        ) : null}
        {!running && !artifact.expired && (
          <Tooltip label={t("pipelines.artifactDownload")}>
            <button type="button" aria-label={t("pipelines.artifactDownload")} onClick={onDownload} className={iconButtonClass({ size: "xs" })}>
              <ArrowDownToLine size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {running && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
          className="h-[3px] overflow-hidden rounded-full bg-[var(--cf-border)]"
        >
          <div
            className={`h-full rounded-full bg-[var(--cf-accent)] ${fraction === null ? "w-1/3 animate-pulse" : ""}`}
            style={fraction === null ? undefined : { width: `${fraction * 100}%` }}
          />
        </div>
      )}
      {download?.state === "failed" && download.error && (
        <p className="text-[11px] text-[var(--cf-danger)]">{download.error}</p>
      )}
      {download?.state === "cancelled" && (
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("pipelines.artifactStopped")}</p>
      )}
    </div>
  );
}
