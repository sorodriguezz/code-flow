import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Play, Plus, Square, Trash2 } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import { DictationWave } from "../dictation/DictationControls";
import { Bar, formatBytes } from "./localModelRow";
import {
  CLONE_MAX_SECONDS,
  CLONE_MIN_SECONDS,
  onCloneLevel,
  onClonePrepare,
  voiceCloneAcceptTerms,
  voiceCloneDelete,
  voiceClonePrepare,
  voiceCloneRecordCancel,
  voiceCloneRecordFinish,
  voiceCloneRecordStart,
  voiceCloneRemove,
  voiceCloneSave,
  voiceCloneStatus,
  type CloneEngine,
  type CloneStatus,
} from "../../lib/tauri/voiceCloneCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useConfirmStore } from "../../state/confirmStore";
import { useDictationStore, reportMicError } from "../../state/dictationStore";
import { useSpeechStore } from "../../state/speechStore";
import { useLanguageStore } from "../../state/languageStore";
import { speechSayVoice } from "../../lib/tauri/speechCommands";
import { pushErrorToast } from "../../state/toastStore";

/**
 * «Modelos › Voces clonadas»: a voice made from fifteen seconds of somebody speaking — Chatterbox
 * Multilingual by default (MIT), XTTS v2 as an option behind its non-commercial licence, the user's
 * choice (2026-10-21). Each engine is a Python environment of the app's own, gigabytes, installed
 * when asked; the pane says before anything comes down how heavy it is and that without a graphics
 * card it speaks slowly.
 *
 * A voice is cloned only with the consent of the person recorded: the box is not decoration, the
 * backend refuses without it.
 */

const SAMPLE = "Hola, esta es mi voz en CodeFlow. Codi puede hablar así cuando yo lo elija.";

export function VoiceCloneBlock() {
  const t = useT();
  const ask = useConfirmStore((s) => s.ask);
  const [status, setStatus] = useState<CloneStatus | null>(null);
  const [lines, setLines] = useState<Partial<Record<CloneEngine, string>>>({});
  const [installing, setInstalling] = useState<CloneEngine | null>(null);
  const [making, setMaking] = useState(false);

  const reload = useCallback(() => void voiceCloneStatus().then(setStatus).catch(() => setStatus(null)), []);
  useEffect(() => {
    reload();
    const off = onClonePrepare((event) => {
      setLines((current) => ({ ...current, [event.engine]: event.line ?? "" }));
      if (event.state !== "running") {
        setInstalling(null);
        reload();
        void useSpeechStore.getState().refresh();
      }
    });
    return () => void off.then((unlisten) => unlisten());
  }, [reload]);

  if (!status) return null;
  const engine = (name: CloneEngine) => status.engines.find((row) => row.engine === name);

  const install = async (name: CloneEngine) => {
    if (name === "xtts" && !status.xttsAccepted) return;
    setInstalling(name);
    setLines((current) => ({ ...current, [name]: t("voiceClone.starting") }));
    try {
      await voiceClonePrepare(name);
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setInstalling(null);
      reload();
    }
  };

  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("voiceClone.title")}</h3>
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
        {(["chatterbox", "xtts"] as const).map((name) => {
          const row = engine(name);
          if (!row) return null;
          const busy = installing === name;
          return (
            <div key={name} className="border-b border-[var(--cf-border)] px-3 py-2.5 last:border-b-0">
              <div className="flex items-start gap-2">
                <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${row.installed ? "bg-[var(--cf-success)]" : "bg-[var(--cf-text-muted)]/40"}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--cf-text)]">
                    {name === "chatterbox" ? "Chatterbox Multilingual" : "XTTS v2"}
                    {name === "chatterbox" && <span className={chipClass("accent")}>{t("voiceClone.default")}</span>}
                    <span className={chipClass(name === "xtts" ? "warn" : "neutral")}>{row.licence}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
                    {t(name === "chatterbox" ? "voiceClone.chatterboxNote" : "voiceClone.xttsNote")} ·{" "}
                    {row.installed
                      ? t("localai.sizeOnDisk", { size: formatBytes(row.bytesOnDisk) })
                      : t("voiceClone.approx", { size: formatBytes(row.estimateBytes) })}
                    {!status.accelerated && <> · <span className="text-[var(--cf-warning)]">{t("voiceClone.slowHere")}</span></>}
                  </p>
                  {name === "xtts" && !row.installed && (
                    <label className="mt-1.5 flex items-start gap-2 text-[11.5px] text-[var(--cf-text)]">
                      <span className="mt-[1px]">
                        <Checkbox checked={status.xttsAccepted} onChange={(on) => void voiceCloneAcceptTerms(on).then(reload)} />
                      </span>
                      <span>
                        {t("voiceClone.xttsTerms")}{" "}
                        {row.termsUrl && (
                          <button type="button" className="text-[var(--cf-accent)] hover:underline" onClick={() => void openExternalUrl(row.termsUrl ?? "")}>
                            CPML
                          </button>
                        )}
                      </span>
                    </label>
                  )}
                  {busy && (
                    <div className="mt-1.5 flex flex-col gap-1">
                      <Bar done={0} total={0} />
                      <p className="truncate font-mono text-[10.5px] text-[var(--cf-text-muted)]">{lines[name]}</p>
                    </div>
                  )}
                </div>
                <div className="shrink-0">
                  {row.installed ? (
                    <Tooltip label={t("localai.delete")}>
                      <button
                        type="button"
                        aria-label={t("localai.delete")}
                        className={iconButtonClass({ size: "sm" })}
                        onClick={() =>
                          void ask({
                            message: t("voiceClone.removeConfirm", { size: formatBytes(row.bytesOnDisk) }),
                            confirmLabel: t("localai.delete"),
                            danger: true,
                          }).then((ok) => ok && void voiceCloneRemove(name).then(reload))
                        }
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy || installing !== null || (name === "xtts" && !status.xttsAccepted)} onClick={() => void install(name)}>
                      {t(busy ? "voiceClone.installing" : "localai.download")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {status.voices.map((voice) => (
          <div key={voice.id} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2 last:border-b-0">
            <Mic size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--cf-text)]">
              {voice.name}
              <span className="ml-1.5 text-[11px] text-[var(--cf-text-muted)]">
                {voice.engine === "chatterbox" ? "Chatterbox" : "XTTS"} · {voice.seconds.toFixed(0)} s
              </span>
            </span>
            {!voice.ready && <span className={chipClass("warn")}>{t("voiceClone.needsEngine")}</span>}
            <Tooltip label={t("speech.test")}>
              <button
                type="button"
                disabled={!voice.ready}
                aria-label={t("speech.test")}
                className={iconButtonClass({ size: "sm" })}
                onClick={() => void speechSayVoice(SAMPLE, voice.id, useLanguageStore.getState().language).catch((e: unknown) => pushErrorToast(String(e)))}
              >
                <Play size={12} />
              </button>
            </Tooltip>
            <Tooltip label={t("localai.delete")}>
              <button
                type="button"
                aria-label={t("localai.delete")}
                className={iconButtonClass({ size: "sm" })}
                onClick={() =>
                  void ask({ message: t("voiceClone.deleteVoice", { name: voice.name }), confirmLabel: t("localai.delete"), danger: true }).then(
                    (ok) => ok && void voiceCloneDelete(voice.id).then(() => {
                      reload();
                      void useSpeechStore.getState().refresh();
                    }),
                  )
                }
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </div>
        ))}

        {making ? (
          <CloneRecorder
            engines={status.engines.filter((row) => row.installed).map((row) => row.engine)}
            onDone={() => {
              setMaking(false);
              reload();
              void useSpeechStore.getState().refresh();
            }}
          />
        ) : (
          <div className="px-3 py-2">
            <Button size="sm" variant="ghost" disabled={!status.engines.some((row) => row.installed)} onClick={() => setMaking(true)}>
              <Plus size={13} />
              {t("voiceClone.make")}
            </Button>
            {!status.engines.some((row) => row.installed) && <span className="ml-2 text-[11px] text-[var(--cf-text-muted)]">{t("voiceClone.installFirst")}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Records the reference, then names it and saves it — with the speaker's consent. */
function CloneRecorder({ engines, onDone }: { engines: CloneEngine[]; onDone: () => void }) {
  const t = useT();
  const device = useDictationStore((s) => s.device);
  const [engine, setEngine] = useState<CloneEngine>(engines[0] ?? "chatterbox");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [levels, setLevels] = useState<number[] | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const off = onCloneLevel((level) => setLevels((current) => (current ? [...current.slice(-48), level] : current)));
    return () => {
      void off.then((unlisten) => unlisten());
      if (timer.current) window.clearInterval(timer.current);
      void voiceCloneRecordCancel();
    };
  }, []);

  const recording = levels !== null;
  const stop = async () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    try {
      setSeconds(await voiceCloneRecordFinish());
    } catch (error) {
      pushErrorToast(String(error));
    }
    setLevels(null);
  };
  const start = async () => {
    setSeconds(null);
    setElapsed(0);
    try {
      await voiceCloneRecordStart(device);
      setLevels([]);
      const began = Date.now();
      timer.current = window.setInterval(() => {
        const s = (Date.now() - began) / 1000;
        setElapsed(s);
        if (s >= CLONE_MAX_SECONDS) void stop();
      }, 200);
    } catch (error) {
      reportMicError(error);
    }
  };
  const save = async () => {
    try {
      await voiceCloneSave(name, engine, consent);
      onDone();
    } catch (error) {
      const text = String(error);
      pushErrorToast(text.includes("CLONE_TOO_SHORT") ? t("voiceClone.tooShort", { min: CLONE_MIN_SECONDS }) : text);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("voiceClone.howTo", { min: CLONE_MIN_SECONDS, max: CLONE_MAX_SECONDS })}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={recording ? "secondary" : "primary"} onClick={() => void (recording ? stop() : start())}>
          {recording ? <Square size={11} fill="currentColor" /> : <Mic size={12} />}
          {t(recording ? "voiceClone.stop" : seconds ? "voiceClone.again" : "voiceClone.record")}
        </Button>
        {recording && (
          <>
            <div className="flex h-5 w-[140px] items-center">
              <DictationWave levels={levels ?? []} max={16} />
            </div>
            <span className="text-[11.5px] tabular-nums text-[var(--cf-text-muted)]">{elapsed.toFixed(0)} s</span>
          </>
        )}
        {!recording && seconds !== null && (
          <span className={chipClass(seconds >= CLONE_MIN_SECONDS ? "ok" : "warn")}>{t("voiceClone.recorded", { s: seconds.toFixed(0) })}</span>
        )}
      </div>
      {seconds !== null && !recording && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("voiceClone.namePlaceholder")}
              aria-label={t("voiceClone.name")}
              className={fieldClass({ size: "sm", className: "w-[220px]" })}
            />
            {engines.length > 1 && (
              <Segmented
                size="sm"
                layoutId="cf-clone-engine"
                value={engine}
                onChange={(next) => setEngine(next as CloneEngine)}
                options={engines.map((e) => ({ value: e, label: e === "chatterbox" ? "Chatterbox" : "XTTS" }))}
              />
            )}
          </div>
          <label className="flex items-start gap-2 text-[11.5px] text-[var(--cf-text)]">
            <span className="mt-[1px]">
              <Checkbox checked={consent} onChange={setConsent} />
            </span>
            <span>{t("voiceClone.consent")}</span>
          </label>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!consent || seconds < CLONE_MIN_SECONDS} onClick={() => void save()}>
              {t("voiceClone.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              {t("common.cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
