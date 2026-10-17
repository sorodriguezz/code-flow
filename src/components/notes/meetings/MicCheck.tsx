import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Monitor } from "lucide-react";
import { meetingsSetMicGain } from "../../../lib/tauri/meetingsCommands";
import { useMeetingsStore } from "../../../state/meetingsStore";
import { useT } from "../../../state/languageStore";
import { GAIN_MAX, GAIN_MIN, VERDICT_COLOR, ZONES, dbfs, meterPosition, verdict, type MicVerdict } from "./micLevel";

/** How long a new verdict must last before the word changes — clipping excepted, said at once. */
const SETTLE_MS = 700;

/**
 * The verdict as the word shows it: a change has to hold for `SETTLE_MS` before it is shown, so the
 * word does not flicker between two states while somebody talks. «Muy fuerte» is the exception —
 * clipping is the one thing worth saying the moment it happens.
 */
function useSettled(value: MicVerdict): MicVerdict {
  const [shown, setShown] = useState(value);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (value === shown) return;
    if (value === "tooLoud") {
      setShown(value);
      return;
    }
    timer.current = window.setTimeout(() => setShown(value), SETTLE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [value, shown]);
  return shown;
}

/**
 * An input as the transcription will hear it — the microphone, or the computer's audio (the call's
 * other side) — before a meeting starts (the backend's monitors) and while it records (the
 * recording's own levels). Both read `meter` in the store.
 *
 * Laid out so nothing moves: what is fixed first (the microphone's mute and gain, or the system's
 * mark), then the meter, then the word in a slot of its own width at the end — a word that changes
 * length pushes nothing after it.
 */
export function MicCheck({ compact = false, channel = "mic" }: { compact?: boolean; channel?: "mic" | "system" }) {
  const t = useT();
  const meter = useMeetingsStore((s) => s.meter[channel]);
  const error = useMeetingsStore((s) => s.meterError[channel]);
  const muted = useMeetingsStore((s) => s.micMuted);
  const system = channel === "system";
  const off = !system && muted;
  const judged = useSettled(verdict(meter.rms, meter.peak));
  const now = off ? 0 : meterPosition(dbfs(meter.rms[meter.rms.length - 1] ?? 0));
  const held = off ? 0 : meterPosition(dbfs(Math.max(0, ...meter.peak)));
  const fill = now >= ZONES.loud ? "var(--cf-danger)" : now >= ZONES.limit ? "var(--cf-warning)" : now >= ZONES.low ? "var(--cf-success)" : "var(--cf-text-muted)";
  const word = off
    ? t("meetings.mic.muted")
    : error
      ? t(system ? "meetings.system.unavailable" : error === "MIC_DENIED" ? "meetings.mic.denied" : "meetings.mic.unavailable")
      : system && judged === "silent"
        ? t("meetings.system.silent")
        : t(`meetings.mic.${judged}`);
  const color = off ? "var(--cf-text-muted)" : error ? "var(--cf-danger)" : VERDICT_COLOR[judged];
  const hint = t(system ? "meetings.system.meterHint" : "meetings.mic.meterHint");
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {system ? <Monitor size={12} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden /> : <MicControls compact={compact} />}
      <span
        className={`relative h-1.5 ${compact ? "w-[80px]" : "w-[110px]"} shrink-0 overflow-hidden rounded-full bg-[var(--cf-border)] ${off ? "opacity-40" : ""}`}
        title={hint}
        role="meter"
        aria-label={t(system ? "meetings.system.meter" : "meetings.mic.meter")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(now * 100)}
      >
        {/* The zones, faint: too low · good · at the limit · clipping. */}
        <span className="absolute inset-y-0 left-0 bg-[var(--cf-danger)] opacity-15" style={{ width: `${ZONES.low * 100}%` }} />
        <span className="absolute inset-y-0 bg-[var(--cf-warning)] opacity-20" style={{ left: `${ZONES.limit * 100}%`, width: `${(ZONES.loud - ZONES.limit) * 100}%` }} />
        <span className="absolute inset-y-0 right-0 bg-[var(--cf-danger)] opacity-25" style={{ width: `${(1 - ZONES.loud) * 100}%` }} />
        <span className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-75" style={{ width: `${now * 100}%`, background: fill }} />
        {held > 0 && <span className="absolute inset-y-0 w-[2px] bg-[var(--cf-text)] opacity-60" style={{ left: `calc(${held * 100}% - 1px)` }} />}
      </span>
      <span className="w-[92px] shrink-0 truncate text-[11px] font-medium transition-colors" style={{ color }} title={`${word} — ${hint}`}>
        {word}
      </span>
    </span>
  );
}

/** The microphone's mute (this app only — the device and other apps keep hearing it) and its gain,
 *  in percent: applied at once while dragged, saved when let go. */
function MicControls({ compact }: { compact: boolean }) {
  const t = useT();
  const saved = useMeetingsStore((s) => s.settings.micGain);
  const muted = useMeetingsStore((s) => s.micMuted);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? Math.round(saved * 100);
  useEffect(() => setDraft(null), [saved]);
  const commit = () => {
    if (draft === null) return;
    void useMeetingsStore.getState().saveSetting("micGain", String(draft / 100));
  };
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => useMeetingsStore.getState().setMicMuted(!muted)}
        aria-pressed={muted}
        aria-label={t(muted ? "meetings.mic.unmute" : "meetings.mic.mute")}
        title={t(muted ? "meetings.mic.unmute" : "meetings.mic.muteHint")}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--cf-hover)] ${
          muted ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        {muted ? <MicOff size={12} /> : <Mic size={12} />}
      </button>
      <input
        type="range"
        min={GAIN_MIN}
        max={GAIN_MAX}
        step={5}
        value={shown}
        disabled={muted}
        title={t("meetings.mic.gainHint")}
        aria-label={t("meetings.mic.gain")}
        onChange={(event) => {
          const next = Number(event.target.value);
          setDraft(next);
          void meetingsSetMicGain(next / 100);
        }}
        onDoubleClick={() => {
          setDraft(100);
          void meetingsSetMicGain(1);
          void useMeetingsStore.getState().saveSetting("micGain", "1");
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className={`${compact ? "w-[64px]" : "w-[90px]"} accent-[var(--cf-accent)] disabled:opacity-40`}
      />
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-muted)]">{shown}%</span>
    </span>
  );
}
