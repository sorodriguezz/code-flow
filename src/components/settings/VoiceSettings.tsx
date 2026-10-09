import { useCallback, useEffect, useRef, useState } from "react";
import { Select, type SelectOption } from "../common/Select";
import { Skeleton } from "../common/Skeleton";
import { Button } from "../common/Button";
import { chipClass } from "../common/recipes";
import { formatBytes, ModelDownloadRow, type DownloadableModel } from "./localModelRow";
import { DictationWave } from "../dictation/DictationControls";
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
import { ensureMeetingEvents, useMeetingsStore } from "../../state/meetingsStore";
import { pushErrorToast } from "../../state/toastStore";
import { PaneBlock } from "./settingsNav";
import { SpeakerRow, SpeechVoicesBlock } from "./SpeechSettings";

/**
 * «Voz y sonido › Modelos»: what is downloaded to listen and to speak — whisper.cpp's models, which
 * «Dictar» and «Reuniones» each pick from in their own pane, and the voices the reading aloud uses.
 * This pane only downloads and deletes them, and marks which feature uses which.
 *
 * Nothing ships with the app: the first Whisper model downloaded also brings the engine. The rows are
 * the local models' own (`ModelDownloadRow`), without their «Usar» — there is no single "active"
 * model when two features each choose one.
 */

const SPEC: Record<DictationModel["id"], { label: string; params: string; ram: number; tier: DownloadableModel["tier"] }> = {
  tiny: { label: "Whisper tiny", params: "Q5_1", ram: 1, tier: "light" },
  base: { label: "Whisper base", params: "Q5_1", ram: 1, tier: "light" },
  small: { label: "Whisper small", params: "Q5_1", ram: 1, tier: "balanced" },
  turbo: { label: "Whisper large-v3 turbo", params: "Q5_0", ram: 2, tier: "large" },
};

export function VoiceModelsSettings() {
  const t = useT();
  const { status, progress, installing, load, install, cancelInstall, remove } = useDictationStore();
  const dictationModel = useDictationStore((s) => s.model);
  const meetings = useMeetingsStore((s) => s.settings);
  const ask = useConfirmStore((store) => store.ask);

  useEffect(() => {
    void load();
    ensureMeetingEvents();
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
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("voice.listenModels")}</h3>
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
            // Who uses it: an explicit choice only — «automático» picks among what is installed.
            const users: string[] = [];
            if (entry.installed && entry.id === dictationModel) users.push(t("dictation.title"));
            if (entry.installed && (entry.id === meetings.liveModel || entry.id === meetings.finalModel)) users.push(t("meetings.settings.title"));
            return (
              <ModelDownloadRow
                key={entry.id}
                model={row}
                active={false}
                progress={rowProgress}
                badge={users.map((user) => (
                  <span key={user} className={chipClass("accent")}>
                    {user}
                  </span>
                ))}
                note={
                  <span>
                    {engineHere
                      ? t(engineHere.phase === "unpacking" ? "dictation.engineUnpacking" : "dictation.engineDownloading")
                      : t(`dictation.model.${entry.id}` as TranslationKey)}
                  </span>
                }
                onDownload={() => void install(entry.id)}
                onCancel={() => void cancelInstall()}
                onDelete={() => {
                  void ask({
                    message: t(users.length > 0 ? "voice.deleteUsed" : "dictation.deleteConfirm", { model: spec.label, size: formatBytes(entry.sizeBytes), users: users.join(", ") }),
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

      <SpeechVoicesBlock />
    </div>
  );
}

/** «Voz y sonido › Dispositivos»: the microphone CodeFlow listens to and the speaker it sounds on. */
export function VoiceDevicesSettings() {
  const t = useT();
  return (
    <div>
      <PaneBlock title={t("dictation.microphone")} hint={t("voice.micHint")}>
        <MicrophoneRow />
      </PaneBlock>
      <PaneBlock title={t("speech.speaker")} hint={t("speech.speakerHint")}>
        <SpeakerRow />
      </PaneBlock>
    </div>
  );
}

/** How long «Probar» listens before it lets go of the microphone by itself. */
const TEST_MS = 15_000;

/**
 * Which microphone dictation and meetings listen to, a way to hear it before relying on it, and —
 * only when it needs doing — the system's permission.
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
  const meetingRecording = useMeetingsStore((store) => !!store.status?.recording);
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
        <span className="w-20 shrink-0 text-[12.5px] text-[var(--cf-text)]">{t("speech.input")}</span>
        <div className="w-[320px]">
          <Select value={device} onChange={(next) => void setDevice(next)} options={options} size="sm" ariaLabel={t("dictation.microphone")} />
        </div>
        <MicTest device={device} disabled={dictating || meetingRecording || permission === "denied"} onRefused={reload} />
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
