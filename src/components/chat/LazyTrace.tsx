import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { AiRunLog } from "../ai/AiRunLog";
import { loadTurnTrace, peekTurnTrace } from "../../lib/turnTrace";
import type { AiRunLine } from "../../state/aiRunStore";
import { useT } from "../../state/languageStore";

/**
 * A reopened turn's "how it got there", fetched the first time it is opened.
 *
 * Until then it is the same quiet row a finished trace draws in `AiRunLog`, without the step count —
 * the count is a property of the trace, and the trace is exactly what has not been read. Once
 * fetched it *is* an `AiRunLog`, so the two read identically from then on. A plain spinner while
 * it loads: this is a database read, not a model thinking.
 *
 * A turn whose stored trace turns out to hold nothing printable draws nothing, as it would have if
 * the trace had been read eagerly.
 */
export function LazyTrace({ traceId }: { traceId: string }) {
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
    return (
      <AiRunLog
        lines={lines}
        running={false}
        label={t("ai.traceSteps", { n: lines.length })}
        expanded={open}
        onToggle={() => setOpen((v) => !v)}
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <button
        type="button"
        onClick={() => {
          // A failed read is retried by asking again, not remembered as "no trace".
          if (failed) setFailed(false);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-[var(--cf-hover)]"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <span className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{t("ai.traceProcess")}</span>
        {loading && <LoaderCircle size={11} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" />}
      </button>
    </div>
  );
}
