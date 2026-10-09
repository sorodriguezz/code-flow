import { useCallback, useEffect, useRef, useState } from "react";
import { Keyboard } from "lucide-react";
import { Select, type SelectOption } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { Button } from "../common/Button";
import { formatBytes, ModelDownloadRow, type DownloadableModel } from "./localModelRow";
import { DictationWave, useDictationChord } from "../dictation/DictationControls";
import {
  dictationInputs,
  dictationMicPermission,
  dictationMicRequest,
  dictationMicSettings,
  type DictationModel,
  type MicInput,
  type MicPermission,
} from "../../lib/tauri/dictationCommands";
import { startRecording, type Recording } from "../../lib/dictation/recorder";
import type { LocalAiDownloadEvent } from "../../lib/tauri/events";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { reportMicError, useDictationStore } from "../../state/dictationStore";
import { pushErrorToast } from "../../state/toastStore";

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

      <MicrophoneRow />

      {chord && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
          <Keyboard size={12} className="shrink-0" />
          {t("dictation.shortcut", { chord })}
        </p>
      )}
    </div>
  );
}

/** How long «Probar» listens before it lets go of the microphone by itself. */
const TEST_MS = 15_000;

/**
 * Which microphone dictation listens to, a way to hear it before relying on it, and — only when it
 * needs doing — the system's permission.
 *
 * The inputs come from the backend by name (`dictation_inputs`), with nothing to grant first: that
 * is what reading the microphone natively bought. Re-read when the window regains focus, so a
 * headset plugged in, or access granted in the system's settings, shows without reopening the pane.
 */
function MicrophoneRow() {
  const t = useT();
  const device = useDictationStore((store) => store.device);
  const setDevice = useDictationStore((store) => store.setDevice);
  const dictating = useDictationStore((store) => store.phase !== "idle");
  const [inputs, setInputs] = useState<MicInput[] | null>(null);
  const [permission, setPermission] = useState<MicPermission | null>(null);

  const reload = useCallback(() => {
    void dictationInputs()
      .then(setInputs)
      .catch(() => setInputs([]));
    void dictationMicPermission()
      .then(setPermission)
      .catch(() => setPermission("unknown"));
  }, []);

  useEffect(() => {
    reload();
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [reload]);

  const fallback = inputs?.find((input) => input.isDefault);
  const options: SelectOption[] = [
    { value: "", label: fallback ? t("dictation.micDefaultNamed", { name: fallback.name }) : t("dictation.micDefault") },
    ...(inputs ?? []).map((input) => ({ value: input.id, label: input.name })),
  ];
  // Chosen once and unplugged now: still the choice, and recordings use the default meanwhile.
  if (device && inputs && !inputs.some((input) => input.id === device)) {
    options.push({ value: device, label: t("dictation.micAbsent") });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <span className="w-20 shrink-0 text-[12.5px] text-[var(--cf-text)]">{t("dictation.microphone")}</span>
        <div className="w-[320px]">
          <Select value={device} onChange={(next) => void setDevice(next)} options={options} size="sm" ariaLabel={t("dictation.microphone")} />
        </div>
        <MicTest device={device} disabled={dictating || permission === "denied"} onRefused={reload} />
      </div>
      {(permission === "denied" || permission === "undetermined") && (
        <div className="flex items-center gap-2 pl-[92px] text-[11.5px] text-[var(--cf-text-muted)]">
          <span>{t(permission === "denied" ? "dictation.micDenied" : "dictation.micUndetermined")}</span>
          <Button
            size="sm"
            variant="ghost"
            className="text-[var(--cf-accent)]"
            onClick={() => {
              if (permission === "denied") {
                void dictationMicSettings().catch((error) => pushErrorToast(String(error)));
              } else {
                void dictationMicRequest()
                  .then(setPermission)
                  .catch(() => reload());
              }
            }}
          >
            {t(permission === "denied" ? "dictation.openPrivacy" : "dictation.micAllow")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** «Probar»: listens to `device` and draws what it hears — the waveform a dictation would draw. */
function MicTest({ device, disabled, onRefused }: { device: string; disabled: boolean; onRefused: () => void }) {
  const t = useT();
  const [levels, setLevels] = useState<number[] | null>(null);
  const recording = useRef<Recording | null>(null);
  /** Bumped by every start and stop, so a start that resolves after it was stopped lets go at once. */
  const attempt = useRef(0);

  const stop = useCallback(() => {
    attempt.current += 1;
    recording.current?.cancel();
    recording.current = null;
    setLevels(null);
  }, []);

  // Let go on leaving the pane, on choosing another input, and after a while on its own.
  useEffect(() => stop, [device, stop]);
  const testing = levels !== null;
  useEffect(() => {
    if (!testing) return;
    const timer = window.setTimeout(stop, TEST_MS);
    return () => window.clearTimeout(timer);
  }, [testing, stop]);

  const start = async () => {
    const mine = ++attempt.current;
    setLevels([]);
    try {
      const started = await startRecording(
        device,
        (level) => {
          if (attempt.current === mine) setLevels((current) => [...(current ?? []).slice(-40), level]);
        },
        stop,
      );
      if (attempt.current !== mine) started.cancel();
      else recording.current = started;
    } catch (error) {
      if (attempt.current === mine) setLevels(null);
      reportMicError(error);
      onRefused();
    }
  };

  return (
    <>
      <Button size="sm" variant="secondary" disabled={disabled && !testing} onClick={() => (testing ? stop() : void start())}>
        {t(testing ? "dictation.micTestStop" : "dictation.micTest")}
      </Button>
      {testing && (
        <div className="flex h-5 w-[120px] items-center">
          <DictationWave levels={levels} max={16} />
        </div>
      )}
    </>
  );
}
