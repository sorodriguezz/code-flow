import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { AiRunLog, formatThoughtTime } from "../ai/AiRunLog";
import { loadTurnTrace, peekTurnTrace } from "../../lib/turnTrace";
import type { AiRunLine } from "../../state/aiRunStore";
import { useT } from "../../state/languageStore";

/**
 * A reopened turn's "how it got there", fetched the first time it is opened.
 *
 * Until then it is the same quiet line a finished trace draws in `AiRunLog` ("Thought for 15 s"),
 * without the step count — the count is a property of the trace, and the trace is exactly what has
 * not been read. Once fetched it *is* an `AiRunLog`, so the two read identically from then on. A
 * plain spinner while it loads: this is a database read, not a model thinking.
 *
 * A turn whose stored trace turns out to hold nothing printable draws nothing, as it would have if
 * the trace had been read eagerly.
 */
export function LazyTrace({
  traceId,
  durationMs,
  density = "panel",
}: {
  traceId: string;
  /** The turn's duration, so the closed line reads "Thought for 15 s" like a trace read eagerly. */
  durationMs?: number;
  density?: "reading" | "panel";
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<AiRunLine[] | null | undefined>(() => peekTurnTrace(traceId));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setLines(peekTurnTrace(traceId));
    setFailed(false);
  }, [traceId]);

  useEffect(() => {
    if (!open || lines !== undefined || failed) return;
    let alive = true;
    setLoading(true);
    loadTurnTrace(traceId)
      .then((loaded) => {
        if (alive) setLines(loaded);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, lines, failed, traceId]);

  if (lines === null) return null;
  if (lines && lines.length > 0) {
    // Opened by the click that loaded it — the reader asked to see it once already.
    return <AiRunLog lines={lines} running={false} durationMs={durationMs} density={density} defaultOpen={open} />;
  }
  const reading = density === "reading";
  return (
    <button
      type="button"
      onClick={() => {
        // A failed read is retried by asking again, not remembered as "no trace".
        if (failed) setFailed(false);
        setOpen((v) => !v);
      }}
      aria-expanded={open}
      className={`flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] ${
        reading ? "text-[13px]" : "text-[12px]"
      }`}
    >
      <span className="truncate">
        {durationMs !== undefined && durationMs > 0
          ? t("ai.thoughtFor", { time: formatThoughtTime(durationMs) })
          : t("ai.traceProcess")}
      </span>
      {loading ? (
        <LoaderCircle size={12} className="shrink-0 animate-spin" />
      ) : (
        <ChevronRight size={13} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      )}
    </button>
  );
}
