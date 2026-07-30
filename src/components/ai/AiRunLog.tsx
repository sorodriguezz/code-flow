import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Square } from "lucide-react";
import { useAiRunStore, type AiRunLine } from "../../state/aiRunStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useT } from "../../state/languageStore";

/**
 * A run, while it runs — and the log it left behind afterwards.
 *
 * This is the whole "what is Claude doing right now" surface, and it is deliberately **one** card.
 * It used to be two: a box saying "Working…" and, under it, a second box whose collapsed header
 * said "Starting…" — two panels, stacked, contradicting each other about the same run, and neither
 * one saying how long it had been going. So the card now carries the hierarchy that split was
 * trying to express:
 *
 * - **The headline** is the state: working, or stopping. It doesn't change every second.
 * - **The line under it** is the activity: the newest thing the CLI printed, which *does* change
 *   every second. Before the first line arrives it says so rather than looking stalled.
 * - **The right edge** is the evidence that it is alive and the way out: elapsed time, how many
 *   steps have gone by, and Stop.
 * - **The bar along the bottom** is indeterminate on purpose. A run has no percentage — anything
 *   that looked like one would be a lie — but "still moving" is real information, and it is what
 *   the eye checks when a review takes two minutes.
 *
 * Expanding shows the raw output. A finished trace (`lines` passed, `running` false) keeps the
 * plain one-line header it always had: it is a record, not a status.
 *
 * `runId` is the id the caller minted and passed to the backend — what ties these lines, the timer
 * and the stop button to this particular run.
 */
export function AiRunLog({
  runId,
  lines: explicitLines,
  running,
  label,
  expanded,
  onToggle,
}: {
  /** The live run to follow. Omit when passing `lines` — a stored trace has no live run to stop. */
  runId?: string;
  /** A finished run's recorded trace, replayed instead of read from the live store. */
  lines?: AiRunLine[];
  /** Drives the stop button, the timer and the progress bar — a finished run keeps its log. */
  running: boolean;
  /** Overrides the headline. A finished trace wants something stable like "3 steps". */
  label?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const liveLines = useAiRunStore((s) => (runId ? s.linesByRun[runId] : undefined));
  const lines = explicitLines ?? liveLines;
  const cancelling = useAiRunStore((s) => (runId ? (s.cancelling[runId] ?? false) : false));
  const cancel = useAiRunStore((s) => s.cancel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(running);

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines?.length, expanded]);

  if (!lines || (lines.length === 0 && !running)) return null;

  // One entry can carry a couple of lines (an assistant turn's prose plus the tool it called);
  // the newest of them is what the run is doing right now.
  const lastLine = lines[lines.length - 1]?.text.split("\n").pop();

  const chevron = expanded ? (
    <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
  ) : (
    <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
  );

  const body = expanded && lines.length > 0 && (
    <div
      ref={scrollRef}
      className="max-h-48 overflow-auto border-t border-[var(--cf-border)] px-2.5 py-1.5 font-mono text-[10px] leading-[1.5]"
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={`whitespace-pre-wrap break-all ${
            line.stream === "stderr" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );

  // A finished trace is a record: one quiet row that opens. Nothing to time, nothing to stop.
  if (!running) {
    return (
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-1.5 px-2 py-1 text-left"
        >
          {chevron}
          <span className="truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
            {label ?? lastLine ?? t("ai.runOutput")}
          </span>
        </button>
        {body}
      </div>
    );
  }

  return (
    <div className="cf-fade-in overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <ThinkingOrb size="sm" />

        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-[var(--cf-text)]">
              {label ?? (cancelling ? t("ai.stopping") : t("ai.working"))}
            </span>
            {chevron}
          </span>
          {/* Under the state it belongs to: how long it has been going, how many steps it has
              taken, and the newest thing the CLI printed. One dim monospace line, because all
              three are the detail behind the headline — and the counters are kept in front of the
              text so the part that truncates is the part that can afford to. */}
          <span className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[10px] text-[var(--cf-text-muted)]">
            <span className="shrink-0 tabular-nums">
              {formatElapsed(elapsed)}
              {lines.length > 0 && ` · ${t("ai.stepsN", { n: String(lines.length) })}`}
            </span>
            {/* A visible seam between the counters and the CLI's words — without it they read as
                one sentence, and "12 pasos Read src/…" is not one. */}
            <span className="shrink-0 opacity-50">|</span>
            <span className="min-w-0 flex-1 truncate">
              {lastLine ?? t("ai.waitingForOutput")}
            </span>
          </span>
        </button>

        {runId && (
          <button
            onClick={() => void cancel(runId)}
            disabled={cancelling}
            title={t("ai.stopRun")}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)] disabled:opacity-50"
          >
            <Square size={9} className="fill-current" />
            {cancelling ? t("ai.stopping") : t("ai.stop")}
          </button>
        )}
      </div>

      {/* Indeterminate by design — see the note at the top. */}
      <div className="cf-run-track">
        <div className="cf-run-beam" />
      </div>

      {body}
    </div>
  );
}

/** Seconds since the run started, ticking while it does. Reset each time one begins. */
function useElapsed(running: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return seconds;
}

/** `m:ss` under an hour, `h:mm:ss` over it — a review that runs that long has earned the extra field. */
function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
