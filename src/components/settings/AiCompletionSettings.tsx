import { useEffect } from "react";
import { CircleStop, FolderOpen, HardDrive, Loader2, TriangleAlert } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Skeleton } from "../common/Skeleton";
import { formatBytes, ModelDownloadRow } from "./localModelRow";
import { useT } from "../../state/languageStore";
import { useLocalAiStore } from "../../state/localAiStore";
import { useConfirmStore } from "../../state/confirmStore";
import { revealInFileManager } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";

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
          <span className="block text-[13px] text-[var(--cf-text)]">{t("localai.enable")}</span>
          <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("localai.enableHint")}
          </span>
        </span>
      </label>

      {/* A broken install, not a choice the user made. Said before anything else, because every
          other control on this pane is pointless until it is fixed. */}
      {!state.engine_available && (
        <p className="flex items-start gap-1.5 rounded-md border border-[var(--cf-warning)]/40 bg-[var(--cf-warning)]/5 px-2.5 py-2 text-[12px] leading-snug text-[var(--cf-warning)]">
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
        <p className="rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2.5 py-2 text-[12px] leading-snug text-[var(--cf-text-muted)]">
          {state.models.some((model) => model.installed)
            ? t("localai.selectedNotInstalled", {
                model: state.models.find((model) => model.id === state.model_id)?.label ?? state.model_id,
              })
            : t("localai.needsModel")}
        </p>
      )}

      {!state.model_known && (
        <p className="flex items-start gap-1.5 text-[12px] leading-snug text-[var(--cf-warning)]">
          <TriangleAlert size={13} className="mt-px shrink-0" />
          <span>{t("localai.unknownModel", { id: state.model_id })}</span>
        </p>
      )}

      <div>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
          {t("localai.models")}
        </h3>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {state.models.map((model) => (
            <ModelDownloadRow
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
              className={buttonClass({ variant: "ghost", size: "sm" })}
            >
              <FolderOpen size={13} />
              {t("localai.showInFolder")}
            </button>
          )}
        </span>

        {/* Only while something is actually running. An always-visible "stop" for a process that is
            not there is a control that teaches the user it does nothing. */}
        {engineRunning && (
          <button onClick={() => void stopEngine()} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {state.engine.kind === "starting" ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <CircleStop size={13} />
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
