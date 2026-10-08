import { useEffect, type ReactNode, type RefObject } from "react";
import { ArrowUp, Mic, Square, X } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { chordLabel } from "../../lib/keys";
import type { DictationField } from "../../lib/dictation/insert";
import { useT } from "../../state/languageStore";
import { bindingFor, useShortcutsStore } from "../../state/shortcutsStore";
import { canSend, dictationReady, useDictationStore } from "../../state/dictationStore";

/**
 * The pieces of «Dictar» a field draws: the microphone beside its send button, and — while a
 * recording is under way — the bar that takes the toolbar's place: discard, the waveform, stop
 * (write the text) and, where the field can send, stop-and-send.
 *
 * Every button keeps the field's focus (`mousedown` is cancelled): the transcript goes where the
 * caret was, and the field stays the one being written in.
 */

const keepFocus = (event: React.MouseEvent) => event.preventDefault();

/** The chord of the global shortcut, for tooltips — empty when unbound. */
export function useDictationChord(): string {
  const overrides = useShortcutsStore((s) => s.overrides);
  const chord = bindingFor("dictation.toggle", overrides);
  return chord ? chordLabel(chord) : "";
}

/** The microphone. Draws nothing until dictation is installed and a model chosen. */
export function DictationMic({
  field,
  inline = true,
  className = "",
  iconSize = 15,
}: {
  field: RefObject<DictationField | null>;
  /** Whether this surface draws `DictationBar` itself while recording. */
  inline?: boolean;
  className?: string;
  iconSize?: number;
}) {
  const t = useT();
  const ready = useDictationStore((s) => dictationReady(s));
  const busy = useDictationStore((s) => s.phase !== "idle");
  const load = useDictationStore((s) => s.load);
  const start = useDictationStore((s) => s.start);
  const chord = useDictationChord();
  useEffect(() => {
    void load();
  }, [load]);
  if (!ready) return null;
  return (
    <Tooltip label={t("dictation.dictate")} trailing={chord ? <span className="opacity-70">{chord}</span> : undefined}>
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={() => field.current && void start(field.current, inline)}
        disabled={busy}
        aria-label={t("dictation.dictate")}
        className={`flex shrink-0 items-center justify-center rounded-full text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-40 ${className || "h-[26px] w-[26px]"}`}
      >
        <Mic size={iconSize} />
      </button>
    </Tooltip>
  );
}

/** How tall a level draws: speech sits around 0.02–0.2 RMS, so the root spreads it over the bar. */
function barHeight(level: number, max: number): number {
  return Math.max(3, Math.min(max, 3 + Math.sqrt(level) * max * 1.6));
}

/** The level history as dots that rise into bars where there was sound — newest on the right. */
export function DictationWave({ levels, max = 18 }: { levels: number[]; max?: number }) {
  const count = 120;
  const shown = levels.slice(-count);
  const padded = [...Array<number>(Math.max(0, count - shown.length)).fill(0), ...shown];
  return (
    <div className="flex h-full min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" aria-hidden>
      {padded.map((level, index) => {
        const height = barHeight(level, max);
        return (
          <span
            key={index}
            className={`w-[3px] shrink-0 rounded-full ${height > 4 ? "bg-[var(--cf-text-muted)]" : "bg-[var(--cf-text-faint)]/60"}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

function RoundButton({
  label,
  onClick,
  disabled,
  tone = "plain",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "plain" | "press" | "accent";
  children: ReactNode;
}) {
  const tones = {
    plain: "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]",
    press: "bg-[var(--cf-press)] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-text)_14%,var(--cf-press))]",
    accent: "bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))]",
  };
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${tones[tone]}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** The recording, in the place of a field's toolbar row. */
export function DictationBar() {
  const t = useT();
  const phase = useDictationStore((s) => s.phase);
  const levels = useDictationStore((s) => s.levels);
  const target = useDictationStore((s) => s.target);
  const finish = useDictationStore((s) => s.finish);
  const cancel = useDictationStore((s) => s.cancel);
  const recording = phase === "recording";
  return (
    <div className="flex h-[26px] min-w-0 flex-1 items-center gap-2" role="group" aria-label={t("dictation.recording")}>
      <RoundButton label={t("dictation.discard")} onClick={cancel}>
        <X size={14} />
      </RoundButton>
      {phase === "transcribing" ? (
        <span className="min-w-0 flex-1 animate-pulse truncate text-[12px] text-[var(--cf-text-muted)]">{t("dictation.transcribing")}</span>
      ) : (
        <DictationWave levels={levels} />
      )}
      <RoundButton label={t("dictation.stop")} onClick={() => void finish(false)} disabled={!recording} tone="press">
        <Square size={10} className="fill-current" />
      </RoundButton>
      {canSend(target) && (
        <RoundButton label={t("dictation.send")} onClick={() => void finish(true)} disabled={!recording} tone="accent">
          <ArrowUp size={15} />
        </RoundButton>
      )}
    </div>
  );
}

/** Whether `field` is the one recording, drawing its own bar. */
export function useDictatingHere(field: RefObject<DictationField | null>): boolean {
  return useDictationStore((s) => s.phase !== "idle" && s.inline && s.target !== null && s.target === field.current);
}
