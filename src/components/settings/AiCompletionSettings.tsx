import { useEffect } from "react";
import { Check, CircleStop, Download, FolderOpen, HardDrive, Loader2, Trash2, TriangleAlert, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import { useT } from "../../state/languageStore";
import { useLocalAiStore } from "../../state/localAiStore";
import { useConfirmStore } from "../../state/confirmStore";
import { revealInFileManager } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import type { LocalAiModelRow, LocalAiTier } from "../../lib/tauri/localaiCommands";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";

/**
 * Inline completion from a model on this machine.
 *
 * The shape of the pane follows the shape of the decision: one switch, then a list of models with
 * exactly one action each. What it must never do is imply the feature works before a model has
 * been downloaded — the switch alone does nothing, and that is stated rather than discovered.
 *
 * No `ThinkingOrb` anywhere here. A download is a transfer and a model load is a process starting;
 * neither is a model reasoning, and the orb means the latter.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const TIER_KEY: Record<LocalAiTier, "localai.tierLight" | "localai.tierBalanced" | "localai.tierLarge"> = {
  light: "localai.tierLight",
  balanced: "localai.tierBalanced",
  large: "localai.tierLarge",
};

/** The bar. Deliberately a plain div rather than anything animated — it is driven by an event four
 *  times a second, and a transition on top of that reads as lag rather than as smoothness. */
function Bar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--cf-border)]">
      <div
        className="h-full rounded-full bg-[var(--cf-accent)]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function Row({
  model,
  active,
  progress,
  onDownload,
  onCancel,
  onUse,
  onDelete,
}: {
  model: LocalAiModelRow;
  active: boolean;
  progress: LocalAiDownloadEvent | undefined;
  onDownload: () => void;
  onCancel: () => void;
  onUse: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const busy = progress?.phase === "downloading" || progress?.phase === "verifying";

  return (
    <div className="border-b border-[var(--cf-border)] px-3 py-2.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            model.installed ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 break-words text-[12.5px] leading-snug text-[var(--cf-text)]">{model.label}</span>
            {active && (
              <span className="shrink-0 rounded bg-[var(--cf-accent)]/15 px-1.5 py-px text-[10px] font-medium text-[var(--cf-accent)]">
                {t("localai.active")}
              </span>
            )}
          </div>
          {/* The model's own description, the size it costs, the memory it wants and its licence.
              All four are things somebody decides on before spending twenty minutes downloading. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--cf-text-muted)]">
            <span>{t(TIER_KEY[model.tier])}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{model.params}</span>
            <span aria-hidden>·</span>
            <span>{formatBytes(model.size_bytes)}</span>
            <span aria-hidden>·</span>
            <span>{t("localai.needsRam", { gb: String(model.min_ram_gb) })}</span>
            <span aria-hidden>·</span>
            <span>{model.licence}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {busy ? (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-surface-raised)] hover:text-[var(--cf-text)]"
            >
              <X size={12} /> {t("localai.cancel")}
            </button>
          ) : model.installed ? (
            <>
              {!active && (
                <button
                  onClick={onUse}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--cf-accent)] hover:bg-[var(--cf-surface-raised)]"
                >
                  <Check size={12} /> {t("localai.use")}
                </button>
              )}
              <button
                onClick={onDelete}
                title={t("localai.delete")}
                className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-surface-raised)] hover:text-[var(--cf-warning)]"
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : (
            <button
              onClick={onDownload}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[var(--cf-accent)] hover:bg-[var(--cf-surface-raised)]"
            >
              <Download size={12} />
              {/* "Resume" rather than "Download" when there is a part file, because offering a
                  fresh download of something that is 80% there reads as losing the 80%. */}
              {model.partial_bytes ? t("localai.resume") : t("localai.download")}
            </button>
          )}
        </div>
      </div>

      {busy && progress && (
        <div className="mt-2 flex flex-col gap-1">
          <Bar done={progress.done} total={progress.total} />
          <div className="flex items-center justify-between text-[10.5px] text-[var(--cf-text-muted)]">
            <span>
              {progress.phase === "verifying"
                ? t("localai.verifying")
                : `${formatBytes(progress.done)} / ${formatBytes(progress.total || model.size_bytes)}`}
            </span>
            {progress.phase === "downloading" && progress.total > 0 && (
              <span>{Math.round((progress.done / progress.total) * 100)}%</span>
            )}
          </div>
        </div>
      )}

      {progress?.phase === "failed" && progress.error && (
        <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-snug text-[var(--cf-warning)]">
          <TriangleAlert size={12} className="mt-px shrink-0" />
          <span>{progress.error}</span>
        </p>
      )}
    </div>
  );
}

export function AiCompletionSettings() {
  const t = useT();
  const { state, progress, loading, load, setEnabled, setModel, download, cancelDownload, remove, stopEngine } =
    useLocalAiStore();
  const ask = useConfirmStore((store) => store.ask);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !state) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }

  const engineRunning = state.engine.kind === "ready" || state.engine.kind === "starting";
  const anyDownloading = Object.values(progress).some(
    (entry) => entry.phase === "downloading" || entry.phase === "verifying",
  );

  return (
    <div className="flex flex-col gap-4">
      <label className="flex cursor-pointer items-start gap-2">
        <Checkbox
          checked={state.enabled}
          onChange={(next) => void setEnabled(next)}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="block text-[12.5px] text-[var(--cf-text)]">{t("localai.enable")}</span>
          <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("localai.enableHint")}
          </span>
        </span>
      </label>

      {/* A broken install, not a choice the user made. Said before anything else, because every
          other control on this pane is pointless until it is fixed. */}
      {!state.engine_available && (
        <p className="flex items-start gap-1.5 rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/5 px-2.5 py-2 text-[11.5px] leading-snug text-[var(--cf-warning)]">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{t("localai.engineMissing")}</span>
        </p>
      )}

      {/* The switch is on but nothing can happen yet. This is the state the feature would
          otherwise fail silently in, so it is spelled out rather than left to be discovered by
          typing and getting nothing.

          Two different sentences, because they have two different fixes. "Nothing is downloaded"
          asks for a download; "the one you picked isn't the one you have" asks for a click on
          Usar, and telling that user to download something would be telling them to spend
          gigabytes on a problem they have already solved. The distinction exists because
          `model_id` defaults to the catalogue's recommendation rather than to whatever happens to
          be on disk — see the `active` prop below. */}
      {state.enabled && state.engine_available && !state.model_installed && !anyDownloading && (
        <p className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-2.5 py-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {state.models.some((model) => model.installed)
            ? t("localai.selectedNotInstalled", {
                model: state.models.find((model) => model.id === state.model_id)?.label ?? state.model_id,
              })
            : t("localai.needsModel")}
        </p>
      )}

      {!state.model_known && (
        <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-[var(--cf-warning)]">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{t("localai.unknownModel", { id: state.model_id })}</span>
        </p>
      )}

      <div>
        <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("localai.models")}
        </h3>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {state.models.map((model) => (
            <Row
              key={model.id}
              model={model}
              // Selected *and* on disk. `model_id` falls back to the catalogue default when the
              // user has never chosen, so matching on it alone put "in use" against a model that
              // had not been downloaded — a badge claiming a completion source that cannot
              // produce a completion.
              active={model.id === state.model_id && model.installed}
              progress={progress[model.id]}
              onDownload={() => void download(model.id)}
              onCancel={() => void cancelDownload(model.id)}
              onUse={() => void setModel(model.id)}
              onDelete={() => {
                void ask({
                  message: t("localai.deleteConfirm", {
                    model: model.label,
                    size: formatBytes(model.size_bytes),
                  }),
                  confirmLabel: t("localai.delete"),
                  danger: true,
                }).then((ok) => {
                  if (ok) void remove(model.id);
                });
              }}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--cf-text-muted)]">
        <span className="flex items-center gap-1.5">
          <HardDrive size={12} />
          {t("localai.diskUsed", { size: formatBytes(state.disk_used) })}
          {/* Only once there is something to show. The folder is created by the first download, so
              before that this would open a file manager on a path that does not exist — and
              creating it eagerly just to have somewhere to point at leaves an empty directory the
              user never asked for. */}
          {state.disk_used > 0 && (
            <button
              onClick={() => {
                void revealInFileManager(state.models_dir).catch((error) =>
                  pushErrorToast(String(error)),
                );
              }}
              title={state.models_dir}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--cf-surface-raised)] hover:text-[var(--cf-text)]"
            >
              <FolderOpen size={12} />
              {t("localai.showInFolder")}
            </button>
          )}
        </span>

        {/* Only while something is actually running. An always-visible "stop" for a process that is
            not there is a control that teaches the user it does nothing. */}
        {engineRunning && (
          <button
            onClick={() => void stopEngine()}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[var(--cf-surface-raised)] hover:text-[var(--cf-text)]"
          >
            {state.engine.kind === "starting" ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <CircleStop size={12} />
            )}
            {state.engine.kind === "starting" ? t("localai.warmingUp") : t("localai.stopEngine")}
          </button>
        )}
      </div>

      {state.engine.kind === "failed" && (
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-warning)]">
          <TriangleAlert size={12} className="mt-px shrink-0" />
          <span>{state.engine.message}</span>
        </p>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">{t("localai.note")}</p>
    </div>
  );
}
