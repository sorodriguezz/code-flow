import { useEffect, useState, type ReactNode } from "react";
import { Download, Mic, MicOff, Volume2, VolumeX } from "lucide-react";
import { formatBytes } from "../settings/localModelRow";
import { dictationStatus, type DictationStatus } from "../../lib/tauri/dictationCommands";
import type { CodiState } from "../../lib/tauri/codiCommands";
import { useCodiStore } from "../../state/codiStore";
import { useVoiceFitStore } from "../../state/voiceFitStore";
import { useT } from "../../state/languageStore";

/**
 * The two big switches under Codi's face — the microphone and the sound — and, while something it
 * needs to listen is not downloaded yet, «Preparar Codi» in the microphone's place: what it will
 * download and how much, then the download itself, then the microphone on.
 */

/** Silero's voice detector (`codi::vad::MODEL`), which no status command reports. */
const DETECTOR_BYTES = 643_854;
/** sherpa-onnx's library and Parakeet, when `dictation_status` has not answered (yet). */
const LIBRARY_FALLBACK_BYTES = 19 * 1024 * 1024;
const LISTENER_FALLBACK_BYTES = 490 * 1024 * 1024;

/** A round switch, 56px, its name under it. On wears the accent fill. */
function RoundSwitch({
  on,
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex w-20 flex-col items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={onClick}
        className={`cf-press flex h-14 w-14 items-center justify-center rounded-full transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none disabled:opacity-45 ${
          on
            ? "bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] shadow-[0_0_0_4px_color-mix(in_oklab,var(--cf-accent)_18%,transparent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))]"
            : "bg-[var(--cf-control)] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:text-[var(--cf-text)]"
        }`}
      >
        {children}
      </button>
      <span className={`text-[11.5px] font-medium ${on ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>{label}</span>
    </div>
  );
}

/** What `codi_prepare` would download, with sizes — read from `dictation_status` and the machine's
 *  pick for Codi (`voice_fit`), with fallbacks while they have not answered. */
function usePrepareItems(missing: CodiState["missing"]): { id: string; label: string; bytes: number }[] {
  const t = useT();
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const pick = useVoiceFitStore((s) => s.fit?.picks.codi);
  const needed = missing.length > 0;
  useEffect(() => {
    if (!needed) return;
    void dictationStatus()
      .then(setStatus)
      .catch(() => {});
    void useVoiceFitStore.getState().load();
  }, [needed]);

  const listener = status?.models.find((model) => model.id === (pick || "parakeet"));
  return missing.map((item) => {
    if (item === "library") return { id: item, label: t("codi.window.itemLibrary"), bytes: status?.sherpaBytes || LIBRARY_FALLBACK_BYTES };
    if (item === "detector") return { id: item, label: t("codi.window.itemDetector"), bytes: DETECTOR_BYTES };
    return {
      id: item,
      label: t("codi.window.itemListener", { name: listener?.label ?? "Parakeet" }),
      bytes: listener?.sizeBytes || LISTENER_FALLBACK_BYTES,
    };
  });
}

/** The name of what is downloading now, as `codi:prepare` names it. */
function prepareItemLabel(item: string | null, items: { id: string; label: string }[]): string {
  if (!item) return "";
  const known = items.find((entry) => entry.id === item);
  if (known) return known.label;
  // A model id: the listener's row, whatever the model turned out to be.
  return items.find((entry) => entry.id === "listener")?.label ?? item;
}

export function CodiSwitches() {
  const t = useT();
  const state = useCodiStore((s) => s.state);
  const switching = useCodiStore((s) => s.switching);
  const prepare = useCodiStore((s) => s.prepare);
  const missing = state?.missing ?? [];
  const items = usePrepareItems(missing);
  const mic = !!state?.mic;
  const sound = state?.sound ?? true;
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  // Missing only matters while the microphone is closed — an open one has what it needs.
  const preparing = !mic && missing.length > 0;

  const soundSwitch = (
    <RoundSwitch
      on={sound}
      label={t("codi.window.sound")}
      title={sound ? t("codi.window.soundTurnOff") : t("codi.window.soundTurnOn")}
      disabled={!state}
      onClick={() => void useCodiStore.getState().setSound(!sound)}
    >
      {sound ? <Volume2 size={22} /> : <VolumeX size={22} />}
    </RoundSwitch>
  );

  if (preparing) {
    const fraction = prepare.total > 0 ? Math.min(1, prepare.done / prepare.total) : 0;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-center gap-6">
          <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <button
              type="button"
              disabled={prepare.running}
              onClick={() => void useCodiStore.getState().prepareAndListen()}
              className="cf-press flex h-14 w-full max-w-[210px] items-center justify-center gap-2 rounded-full bg-[var(--cf-accent-fill)] px-4 text-[13px] font-semibold text-[var(--cf-on-accent)] transition-colors duration-150 hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] motion-reduce:transition-none disabled:opacity-70"
            >
              <Download size={16} />
              {prepare.running ? t("codi.window.preparing") : t("codi.window.prepare")}
            </button>
            <span className="text-[11.5px] font-medium text-[var(--cf-text-muted)]">{t("codi.window.mic")}</span>
          </div>
          {soundSwitch}
        </div>
        <div className="rounded-lg bg-[var(--cf-sunken)] px-3 py-2 text-[11.5px] text-[var(--cf-text-muted)]">
          {prepare.running ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[var(--cf-text)]">{prepareItemLabel(prepare.item, items) || t("codi.window.preparing")}</span>
                {prepare.total > 0 && (
                  <span className="shrink-0 tabular-nums">
                    {formatBytes(prepare.done)} / {formatBytes(prepare.total)}
                  </span>
                )}
              </div>
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--cf-hover)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(fraction * 100)}
              >
                <div
                  className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-200 motion-reduce:transition-none"
                  style={{ width: `${fraction * 100}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <p className="text-[var(--cf-text)]">{t("codi.window.prepareIntro", { size: formatBytes(total) })}</p>
              <ul className="mt-1 space-y-0.5">
                {items.map((item) => (
                  <li key={item.id} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="shrink-0 tabular-nums">{formatBytes(item.bytes)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1">{t("codi.window.prepareLocal")}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-center gap-10">
      <RoundSwitch
        on={mic}
        label={t("codi.window.mic")}
        title={mic ? t("codi.window.micTurnOff") : t("codi.window.micTurnOn")}
        disabled={!state || switching}
        onClick={() => void useCodiStore.getState().setMic(!mic)}
      >
        {mic ? <Mic size={22} /> : <MicOff size={22} />}
      </RoundSwitch>
      {soundSwitch}
    </div>
  );
}
