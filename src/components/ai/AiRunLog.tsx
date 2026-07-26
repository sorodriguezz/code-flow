import { useEffect, useRef } from "react";
import { ChevronDown, ChevronRight, Square } from "lucide-react";
import { useAiRunStore, type AiRunLine } from "../../state/aiRunStore";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useT } from "../../state/languageStore";

/** What the CLI is printing right now, plus the button that stops it.
 *
 * The whole point of this component is that an AI run stopped being a black box: before, a run
 * was a spinner and a prayer until the process exited. `runId` is the id the caller minted and
 * passed to the backend, which is what ties these lines (and the stop button) to this run. */
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
  /** Drives the stop button and the "working" affordance — a finished run keeps its log. */
  running: boolean;
  /** Collapsed header text. Defaults to the newest line, which is the right thing while a run is
   * in flight; a finished trace wants something stable like "3 pasos". */
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

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines?.length, expanded]);

  if (!lines || (lines.length === 0 && !running)) return null;

  // One entry can carry a couple of lines (an assistant turn's prose plus the tool it called);
  // collapsed, only the newest of them is the status.
  const lastLine = lines[lines.length - 1]?.text.split("\n").pop();

  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {expanded ? (
            <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          {running && <ThinkingOrb size="sm" />}
          {/* Collapsed, the newest line is the status: it's the closest thing a CLI gives to
              "what am I doing right now". A finished trace passes its own stable label instead. */}
          <span className="truncate font-mono text-[10px] text-[var(--cf-text-muted)]">
            {label ?? (running && !lastLine ? t("ai.waitingForOutput") : (lastLine ?? t("ai.runOutput")))}
          </span>
        </button>
        {running && runId && (
          <button
            onClick={() => void cancel(runId)}
            disabled={cancelling}
            title={t("ai.stopRun")}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-0.5 text-[10px] text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)] disabled:opacity-50"
          >
            <Square size={9} className="fill-current" />
            {cancelling ? t("ai.stopping") : t("ai.stop")}
          </button>
        )}
      </div>
      {expanded && lines.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-40 overflow-auto border-t border-[var(--cf-border)] px-2 py-1 font-mono text-[10px] leading-[1.5]"
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
      )}
    </div>
  );
}
