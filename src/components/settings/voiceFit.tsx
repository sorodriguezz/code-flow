import { Gauge } from "lucide-react";
import { buttonClass } from "../common/Button";
import { chipClass, type ChipTone } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ListenFit, SpeakFit, VoiceFit, VoicePace } from "../../lib/tauri/voiceFitCommands";
import { useT } from "../../state/languageStore";
import { useVoiceFitStore } from "../../state/voiceFitStore";

/**
 * The pieces «Modelos» draws beside every download to say whether it suits this machine: the
 * machine itself with what each feature is recommended (`MachineCard`), and per row its speed here
 * — estimated or measured — its accuracy and what it is recommended for (`ListenDetails`,
 * `SpeakDetails`), plus «Medir» once it is downloaded (`MeasureButton`).
 *
 * The user asked for weights and speeds on every model and a recommendation for their own PC
 * (2026-10-21): a Windows laptop with no graphics card should see, before downloading twenty
 * minutes of model, that turbo takes seconds an order there and Parakeet a tenth of one.
 */

const PACE_TONE: Record<VoicePace, ChipTone> = { fast: "ok", ok: "accent", slow: "warn", "too-slow": "bad" };
const PACE_KEY: Record<VoicePace, TranslationKey> = {
  fast: "voiceFit.pace.fast",
  ok: "voiceFit.pace.ok",
  slow: "voiceFit.pace.slow",
  "too-slow": "voiceFit.pace.tooSlow",
};
const ACCURACY_KEY: Record<ListenFit["accuracy"], TranslationKey> = {
  max: "voiceFit.accuracy.max",
  high: "voiceFit.accuracy.high",
  medium: "voiceFit.accuracy.medium",
  basic: "voiceFit.accuracy.basic",
};
const FEATURE_KEY: Record<ListenFit["recommendedFor"][number], TranslationKey> = {
  codi: "voiceFit.for.codi",
  dictation: "voiceFit.for.dictation",
  meetingsLive: "voiceFit.for.meetingsLive",
  meetingsFinal: "voiceFit.for.meetingsFinal",
  translate: "voiceFit.for.translate",
};

/** `90 ms`, `1,6 s`. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** The RAM a model holds, as the rows' «Necesita N GB» reads it — at least one. */
export const ramGb = (ramMb: number | undefined, fallback: number): number => (ramMb ? Math.max(1, Math.ceil(ramMb / 1000)) : fallback);

function Speed({ ms, measured, pace, label }: { ms: number; measured: boolean; pace: VoicePace; label: TranslationKey }) {
  const t = useT();
  return (
    <Tooltip label={t(measured ? "voiceFit.measuredHint" : "voiceFit.estimatedHint")}>
      <span className={chipClass(PACE_TONE[pace])}>
        <Gauge size={11} />
        {t(label, { time: `${measured ? "" : "≈ "}${formatMs(ms)}` })}
        <span className="font-normal opacity-80">· {t(PACE_KEY[pace])}</span>
      </span>
    </Tooltip>
  );
}

/** A listener's line: speed per short order, accuracy, languages, and what it is recommended for. */
export function ListenDetails({ fit, languages, translates }: { fit: ListenFit | undefined; languages: string[]; translates: boolean }) {
  const t = useT();
  if (!fit) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Speed ms={fit.ms} measured={fit.measured} pace={fit.pace} label="voiceFit.perOrder" />
      <span className={chipClass("neutral")}>{t(ACCURACY_KEY[fit.accuracy])}</span>
      <span className={chipClass("neutral")}>
        {languages.length === 0
          ? t("voiceFit.languagesWhisper")
          : languages.length > 6
            ? t("voiceFit.languagesMany", { n: languages.length })
            : languages.join(" · ")}
      </span>
      {translates && <span className={chipClass("info")}>{t("voiceFit.translates")}</span>}
      {fit.recommendedFor.length > 0 && (
        <span className={chipClass("accent")}>{t("voiceFit.recommendedFor", { what: fit.recommendedFor.map((f) => t(FEATURE_KEY[f])).join(", ") })}</span>
      )}
    </div>
  );
}

/** A voice's line: how soon its first sentence starts here, and whether it is the recommended one. */
export function SpeakDetails({ fit }: { fit: SpeakFit | undefined }) {
  const t = useT();
  if (!fit) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <Speed ms={fit.firstMs} measured={fit.measured} pace={fit.pace} label="voiceFit.firstSentence" />
      {fit.measured && fit.rtf != null && fit.rtf > 0 && (
        <span className={chipClass("neutral")}>{t("voiceFit.rtf", { x: (1 / fit.rtf).toFixed(1).replace(".", ",") })}</span>
      )}
      {fit.recommended && <span className={chipClass("accent")}>{t("voiceFit.recommendedHere")}</span>}
    </div>
  );
}

/** «Medir» on a downloaded row: runs it here and turns its estimate into a measurement. */
export function MeasureButton({ id }: { id: string }) {
  const t = useT();
  const busy = useVoiceFitStore((s) => s.measuring.includes(id));
  return (
    <button type="button" disabled={busy} onClick={() => void useVoiceFitStore.getState().measure(id)} className={buttonClass({ variant: "ghost", size: "sm" })}>
      <Gauge size={13} />
      {t(busy ? "voiceFit.measuring" : "voiceFit.measure")}
    </button>
  );
}

/**
 * This machine, how it is read (whisper on the GPU on Apple Silicon, everything on the CPU on a PC)
 * and what each feature is recommended here — the summary above the downloads.
 */
export function MachineCard({ fit, label }: { fit: VoiceFit; label: (id: string) => string }) {
  const t = useT();
  const { machine, picks } = fit;
  const classKey: TranslationKey =
    machine.class === "apple" ? "voiceFit.class.apple" : machine.class === "pc" ? "voiceFit.class.pc" : "voiceFit.class.modest";
  const voice = picks.voiceEngine === "kokoro" ? "Kokoro" : "Piper";
  const rows: [TranslationKey, string][] = [
    ["voiceFit.for.codi", label(picks.codi)],
    ["voiceFit.for.dictation", label(picks.dictation)],
    ["voiceFit.for.meetings", `${label(picks.meetingsLive)} · ${label(picks.meetingsFinal)}`],
    ["voiceFit.for.translate", label(picks.translate)],
    ["voiceFit.for.voice", voice],
  ];
  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-[var(--cf-text)]">
        <span className="font-medium">{t("voiceFit.yourMachine")}</span>
        <span className="text-[var(--cf-text-muted)]">
          {[machine.cpu || null, t("voiceFit.cores", { n: machine.cores }), `${Math.round(machine.ramGb)} GB`, machine.gpu].filter(Boolean).join(" · ")}
        </span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(classKey)}</p>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
        {rows.map(([key, value]) => (
          <div key={key} className="contents">
            <span className="text-[var(--cf-text-muted)]">{t(key)}</span>
            <span className="text-[var(--cf-text)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
