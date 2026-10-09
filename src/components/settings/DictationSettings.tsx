import { useEffect } from "react";
import { Keyboard } from "lucide-react";
import { Select } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { useDictationChord } from "../dictation/DictationControls";
import type { DictationModel } from "../../lib/tauri/dictationCommands";
import { useT } from "../../state/languageStore";
import { useDictationStore } from "../../state/dictationStore";
import { useUiStore } from "../../state/uiStore";

/**
 * «Dictado»: which Whisper model dictation writes with, in which language, and its shortcut. The
 * models themselves — and the microphone — are «Voz»'s, shared with «Reuniones»; until one is
 * downloaded there and chosen here, no microphone is drawn anywhere.
 */

const LABEL: Record<DictationModel["id"], string> = {
  tiny: "Whisper tiny",
  base: "Whisper base",
  small: "Whisper small",
  turbo: "Whisper large-v3 turbo",
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
  const { status, model, language, load, setModel, setLanguage } = useDictationStore();
  const chord = useDictationChord();

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) {
    return <Skeleton className="h-14 w-full" />;
  }
  if (!status.supported) {
    return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("dictation.unsupported")}</p>;
  }

  const installed = status.models.filter((entry) => entry.installed);
  const toVoice = (
    <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => useUiStore.getState().openSettingsAt("voice", "models")}>
      {t("voice.open")}
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[12.5px] text-[var(--cf-text)]">{t("dictation.models")}</span>
          <div className="w-[260px]">
            <Select
              value={installed.some((entry) => entry.id === model) ? model : ""}
              onChange={(next) => void setModel(next)}
              size="sm"
              ariaLabel={t("dictation.models")}
              disabled={installed.length === 0}
              options={[
                { value: "", label: t("dictation.off") },
                ...installed.map((entry) => ({ value: entry.id, label: LABEL[entry.id] ?? entry.id })),
              ]}
            />
          </div>
        </div>
        <p className="pl-[92px] text-[11.5px] text-[var(--cf-text-muted)]">
          {installed.length === 0 ? t("dictation.noModels") : t("dictation.modelsInVoice")} {toVoice}
        </p>
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
