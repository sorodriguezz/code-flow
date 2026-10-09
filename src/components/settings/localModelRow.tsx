import type { ReactNode } from "react";
import { Check, Download, Trash2, TriangleAlert, X } from "lucide-react";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import type { LocalAiTier } from "../../lib/tauri/localaiCommands";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";

/**
 * One downloadable model, as both local-model panes draw it: the editor's autocomplete
 * (`AiCompletionSettings`) and the hybrid task's executor (`LocalModelSettings`).
 *
 * Shared because the two catalogues are downloaded, resumed, verified and deleted by the same
 * Rust pipeline — a second copy of this row would be a second place for "Resume" and "Download" to
 * disagree about what a `.part` file means.
 *
 * No `ThinkingOrb` here: a download is a transfer, not a model reasoning.
 */

export function formatBytes(bytes: number): string {
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

export const TIER_KEY: Record<LocalAiTier, "localai.tierLight" | "localai.tierBalanced" | "localai.tierLarge"> = {
  light: "localai.tierLight",
  balanced: "localai.tierBalanced",
  large: "localai.tierLarge",
};

/** A row action that deletes: the button recipe has no danger icon tone, so it is written out. */
const DANGER_ICON_BUTTON =
  "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40";

/** The bar. Deliberately a plain div rather than anything animated — it is driven by an event four
 *  times a second, and a transition on top of that reads as lag rather than as smoothness. */
export function Bar({ done, total }: { done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--cf-border)]">
      <div className="h-full rounded-full bg-[var(--cf-accent-fill)]" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** What a row needs to know about its model, whichever catalogue it came from. */
export interface DownloadableModel {
  id: string;
  label: string;
  tier: LocalAiTier;
  params: string;
  licence: string;
  size_bytes: number;
  min_ram_gb: number;
  installed: boolean;
  partial_bytes: number | null;
}

export function ModelDownloadRow({
  model,
  active,
  progress,
  badge,
  note,
  onDownload,
  onCancel,
  onUse,
  onDelete,
}: {
  model: DownloadableModel;
  active: boolean;
  progress: LocalAiDownloadEvent | undefined;
  /** An extra chip after the name — the executor pane marks what suits this machine. */
  badge?: ReactNode;
  /** Replaces the tier at the head of the description. The executor pane says how the model sits
   *  on this machine instead: a tier is about machines in general, and that pane's choice is not. */
  note?: ReactNode;
  onDownload: () => void;
  onCancel: () => void;
  /** Absent where a row is only downloaded and deleted — the shared Voz pane, whose models each
   *  feature picks from its own pane. */
  onUse?: () => void;
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
            <span className="min-w-0 break-words text-[13px] leading-snug text-[var(--cf-text)]">{model.label}</span>
            {active && <span className={chipClass("accent")}>{t("localai.active")}</span>}
            {badge}
          </div>
          {/* The model's own description, the size it costs, the memory it wants and its licence.
              All four are things somebody decides on before spending twenty minutes downloading. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--cf-text-muted)]">
            {note ?? <span>{t(TIER_KEY[model.tier])}</span>}
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
            <button onClick={onCancel} className={buttonClass({ variant: "ghost", size: "sm" })}>
              <X size={13} /> {t("localai.cancel")}
            </button>
          ) : model.installed ? (
            <>
              {!active && onUse && (
                <button onClick={onUse} className={buttonClass({ variant: "secondary", size: "sm" })}>
                  <Check size={13} /> {t("localai.use")}
                </button>
              )}
              <button onClick={onDelete} title={t("localai.delete")} className={DANGER_ICON_BUTTON}>
                <Trash2 size={13} />
              </button>
            </>
          ) : (
            <button onClick={onDownload} className={buttonClass({ variant: "secondary", size: "sm" })}>
              <Download size={13} />
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
          <div className="flex items-center justify-between text-[11px] tabular-nums text-[var(--cf-text-muted)]">
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
