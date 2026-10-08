import { useEffect } from "react";
import { Keyboard } from "lucide-react";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { formatBytes, ModelDownloadRow, type DownloadableModel } from "./localModelRow";
import { useDictationChord } from "../dictation/DictationControls";
import type { DictationModel } from "../../lib/tauri/dictationCommands";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { useDictationStore } from "../../state/dictationStore";

/**
 * «Dictado»: the one place dictation is installed from. Nothing ships with the app — the first
 * model installed also brings the engine — and until a model is installed and chosen no
 * microphone is drawn anywhere. The rows are the local models' own (`ModelDownloadRow`): the same
 * download, resume, use and delete, read the same way.
 */

const SPEC: Record<DictationModel["id"], { label: string; params: string; ram: number; tier: DownloadableModel["tier"] }> = {
  base: { label: "Whisper base", params: "Q5_1", ram: 1, tier: "light" },
  small: { label: "Whisper small", params: "Q5_1", ram: 1, tier: "balanced" },
  turbo: { label: "Whisper large-v3 turbo", params: "Q5_0", ram: 2, tier: "large" },
};

const LANGUAGES: { value: string; label: string }[] = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
];

export function DictationSettings() {
  const t = useT();
  const { status, model, language, progress, installing, load, install, cancelInstall, remove, setModel, setLanguage } = useDictationStore();
  const ask = useConfirmStore((store) => store.ask);
  const chord = useDictationChord();

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) {
    return (
      <div className="flex flex-col gap-1">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  }
  if (!status.supported) {
    return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("dictation.unsupported")}</p>;
  }

  const engine = progress.engine;
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("dictation.models")}</h3>
        <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {status.models.map((entry) => {
            const spec = SPEC[entry.id];
            const row: DownloadableModel = {
              id: entry.id,
              label: spec.label,
              tier: spec.tier,
              params: spec.params,
              licence: "MIT",
              size_bytes: entry.sizeBytes,
              min_ram_gb: spec.ram,
              installed: entry.installed,
              partial_bytes: null,
            };
            // The engine comes down first, on the row of the model that asked for it.
            const engineHere = installing === entry.id && engine && engine.phase !== "failed" ? engine : undefined;
            const own = progress[entry.id];
            const shown = engineHere ?? own;
            const rowProgress: LocalAiDownloadEvent | undefined = shown && {
              model_id: entry.id,
              phase: shown.phase === "unpacking" ? "verifying" : shown.phase,
              done: shown.done,
              total: shown.total,
              error: shown.error ?? (installing === entry.id ? engine?.error : undefined),
            };
            return (
              <ModelDownloadRow
                key={entry.id}
                model={row}
                active={entry.installed && entry.id === model}
                progress={rowProgress}
                note={
                  <span>
                    {engineHere
                      ? t(engineHere.phase === "unpacking" ? "dictation.engineUnpacking" : "dictation.engineDownloading")
                      : t(`dictation.model.${entry.id}` as TranslationKey)}
                  </span>
                }
                onDownload={() => void install(entry.id)}
                onCancel={() => void cancelInstall()}
                onUse={() => void setModel(entry.id)}
                onDelete={() => {
                  void ask({
                    message: t("dictation.deleteConfirm", { model: spec.label, size: formatBytes(entry.sizeBytes) }),
                    confirmLabel: t("localai.delete"),
                    danger: true,
                  }).then((ok) => {
                    if (ok) void remove(entry.id);
                  });
                }}
              />
            );
          })}
        </div>
        {!status.engineInstalled && (
          <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("dictation.engineFirst", { size: formatBytes(status.engineBytes) })}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 text-[12.5px] text-[var(--cf-text)]">{t("dictation.language")}</span>
        <div className="w-[200px]">
          <Select
            value={language}
            onChange={(next) => void setLanguage(next)}
            options={[{ value: "", label: t("dictation.langApp") }, { value: "auto", label: t("dictation.langAuto") }, ...LANGUAGES]}
            size="sm"
          />
        </div>
      </div>

      {chord && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
          <Keyboard size={12} className="shrink-0" />
          {t("dictation.shortcut", { chord })}
        </p>
      )}
    </div>
  );
}
