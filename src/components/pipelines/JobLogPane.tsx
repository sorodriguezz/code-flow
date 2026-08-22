import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, Copy, Search, Sparkles, X } from "lucide-react";
import { analyzePipelineFailure, isRepoBusy, REPO_BUSY_MARKER } from "../../lib/tauri/commands";
import { parseClaudeError } from "../../lib/claudeError";
import { firstErrorIndex, looksLikeError, parseLog, type LogLine } from "../../lib/ansiLog";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useCiStore, selectedJobKey } from "../../state/ciStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { AiRunLog } from "../ai/AiRunLog";
import { Markdown } from "../common/Markdown";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { StatusGlyph } from "./RunList";
import type { PipelineJob } from "../../types/domain";

/** One rendered line's height, in px. Fixed because the window below is computed from it. */
const LINE_H = 20;
/** How many lines outside the viewport are rendered, so a fast scroll doesn't show blank space. */
const OVERSCAN = 40;

function LogRow({ line, highlighted }: { line: LogLine; highlighted: boolean }) {
  const bad = looksLikeError(line);
  return (
    <div
      // `select-text` against the app-wide `body { user-select: none }`, which otherwise makes a
      // log behave like a picture of a log: the copy button takes the *whole* thing, and the thing
      // you usually want is one stack frame. The gutter keeps `select-none` below, so a drag down
      // the log copies the lines without the line numbers welded to the front of each one — the
      // same split `DiffView` makes.
      //
      // The list is windowed, so a selection can only cover what is mounted: the viewport plus the
      // overscan either side. Dragging past that scrolls, and the rows that leave take their part
      // of the selection with them. That is the trade for not building a thousand-line log up
      // front, and the copy button is still there for the whole thing.
      className={`flex select-text gap-3 whitespace-pre pr-3 font-mono text-[11.5px] ${
        bad ? "bg-[color-mix(in_oklab,var(--cf-danger)_9%,transparent)]" : ""
      } ${highlighted ? "bg-[var(--cf-accent-soft)]" : ""}`}
      style={{ height: LINE_H, lineHeight: `${LINE_H}px` }}
    >
      <span
        className={`w-[46px] shrink-0 select-none text-right tabular-nums ${
          bad ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)] opacity-55"
        }`}
      >
        {line.n}
      </span>
      <span style={{ paddingLeft: line.depth * 12 }}>
        {line.spans.length === 0 ? (
          " "
        ) : (
          line.spans.map((span, index) => (
            <span
              key={index}
              style={{
                color: span.color,
                fontWeight: span.bold ? 600 : undefined,
                opacity: span.dim ? 0.7 : undefined,
                fontStyle: span.italic ? "italic" : undefined,
                textDecoration: span.underline ? "underline" : undefined,
              }}
            >
              {span.text}
            </span>
          ))
        )}
      </span>
    </div>
  );
}

/**
 * The bottom half of the detail pane: one job's log, and the button that asks why it broke.
 *
 * Windowed by hand rather than with a library — this project has no virtualisation dependency by
 * explicit decision (`DataGrid.tsx` says why), and a CI log runs to thousands of lines, which is
 * exactly the size where rendering all of them costs a visible pause on every selection.
 */
export function JobLogPane({ job }: { job: PipelineJob | undefined }) {
  const logByJob = useCiStore((s) => s.logByJob);
  const logBusy = useCiStore((s) => s.logBusy);
  const logError = useCiStore((s) => s.logError);
  const analysisByJob = useCiStore((s) => s.analysisByJob);
  const setAnalysis = useCiStore((s) => s.setAnalysis);
  const clearAnalysis = useCiStore((s) => s.clearAnalysis);
  const selection = useCiStore((s) => s.selection);
  const key = useCiStore(selectedJobKey);
  const t = useT();

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const log = key ? logByJob[key] : undefined;
  const busy = key ? logBusy[key] === true : false;
  const error = key ? logError[key] : "";
  const analysis = key ? analysisByJob[key] : undefined;

  const lines = useMemo(() => (log ? parseLog(log.text) : []), [log]);

  // Searching filters rather than highlights-in-place: with a windowed list, "next match" would
  // have to scroll to a line that isn't rendered yet, and a filtered log answers the same question
  // — where does this appear — without that machinery.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter((line) => line.text.toLowerCase().includes(needle));
  }, [lines, query]);

  // Back to the top whenever the job changes: a scroll position from another job's log is
  // meaningless, and landing halfway down a log you have never seen reads as a rendering bug.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setScrollTop(0);
    setQuery("");
  }, [key]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportH(element.clientHeight));
    observer.observe(element);
    setViewportH(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / LINE_H) - OVERSCAN);
  const last = Math.min(visible.length, Math.ceil((scrollTop + viewportH) / LINE_H) + OVERSCAN);
  const rows = visible.slice(first, last);

  const jumpToError = () => {
    const index = firstErrorIndex(visible);
    if (index < 0 || !scroller.current) return;
    scroller.current.scrollTo({ top: Math.max(0, index * LINE_H - 80), behavior: "smooth" });
  };

  const askWhy = async () => {
    if (!selection || !job || !key) return;
    const aiRunId = newRunId("pipeline");
    // Started before the invoke, exactly as every other tracked run in this app does it: the
    // backend cannot hand back an id the panel needs in order to subscribe to events the run is
    // already emitting.
    useAiRunStore.getState().start(aiRunId, {
      kindKey: "pipelines.analysisKind",
      detail: job.name,
      // Stamped before the invoke, not after: this run outlives the screen it was started from,
      // and the workspace it belongs to is whichever one was active when it began.
      workspaceId: useWorkspaceStore.getState().activeWorkspaceId,
    });
    setAnalysis(key, { aiRunId, startedAt: Date.now(), text: undefined, error: undefined });
    try {
      const text = await analyzePipelineFailure(
        selection.projectId,
        selection.runId,
        job.id,
        job.log_ref,
        aiRunId,
      );
      setAnalysis(key, { text });
    } catch (e) {
      // Two of the failures that reach here are not failures. A run the user stopped has no result
      // and no error worth keeping — leaving one would sit a red box under the log for something
      // they did on purpose — and "the repo is busy" arrives as an internal marker string that is
      // meaningless on screen. Both are what `docsStore` and the analyze panel already do.
      if (isCancellation(e)) {
        clearAnalysis(key);
      } else {
        const raw = String(e);
        const message = isRepoBusy(e)
          ? t("agents.busyInRepo", {
              name: raw.slice(raw.indexOf(REPO_BUSY_MARKER) + REPO_BUSY_MARKER.length).trim(),
            })
          : parseClaudeError(raw).message;
        setAnalysis(key, { error: message });
        pushErrorToast(message);
      }
    } finally {
      useAiRunStore.getState().finish(aiRunId);
    }
  };

  const askable = job && (job.status === "failed" || job.status === "warning");
  const running = analysis !== undefined && analysis.text === undefined && analysis.error === undefined;

  return (
    <>
      <div className="flex h-[29px] shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] pl-2.5 pr-2">
        <span className="mr-auto flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium">
          {job ? (
            <>
              <StatusGlyph status={job.status} size={13} />
              <span className="truncate">{job.name}</span>
            </>
          ) : (
            <span className="text-[var(--cf-text-muted)]">{t("pipelines.pickJob")}</span>
          )}
        </span>
        {searchOpen ? (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                setSearchOpen(false);
              }
            }}
            placeholder={t("pipelines.search")}
            className="h-5 w-40 shrink-0 rounded-[5px] border border-[var(--cf-border)] bg-transparent px-2 text-[11px] outline-none focus:border-[var(--cf-accent)]"
          />
        ) : (
          <Tooltip label={t("pipelines.search")}>
            <button type="button" onClick={() => setSearchOpen(true)} className={TOOLBAR}>
              <Search size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("pipelines.jumpToError")}>
          <button type="button" onClick={jumpToError} className={TOOLBAR}>
            <ArrowDownToLine size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t("pipelines.copyLog")}>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(log?.text ?? "")}
            className={TOOLBAR}
          >
            <Copy size={13} />
          </button>
        </Tooltip>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto bg-[var(--cf-bg)] py-2"
      >
        {busy && lines.length === 0 && (
          <p className="px-3 text-[11.5px] text-[var(--cf-text-muted)]">{t("pipelines.loadingLog")}</p>
        )}
        {error && (
          <p className="px-3 text-[11.5px] text-[var(--cf-danger)]">{error}</p>
        )}
        {!busy && !error && log && visible.length === 0 && (
          <p className="px-3 text-[11.5px] text-[var(--cf-text-muted)]">
            {query ? t("pipelines.noMatches") : t("pipelines.emptyLog")}
          </p>
        )}
        <div style={{ height: visible.length * LINE_H, position: "relative" }}>
          <div style={{ transform: `translateY(${first * LINE_H}px)` }}>
            {rows.map((line) => (
              <LogRow key={line.n} line={line} highlighted={query.trim().length > 0} />
            ))}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5">
        <span className="mr-auto text-[10.5px] text-[var(--cf-text-muted)]">
          {log
            ? log.truncated
              ? t("pipelines.logTruncated", { n: lines.length })
              : t("pipelines.logLines", { n: lines.length })
            : ""}
        </span>
        {askable && !analysis && (
          <button
            type="button"
            onClick={() => void askWhy()}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-[color-mix(in_oklab,var(--cf-accent)_34%,transparent)] bg-[var(--cf-accent-soft)] px-2.5 text-[11.5px] font-semibold text-[var(--cf-accent)] transition-[filter] hover:brightness-105"
          >
            <Sparkles size={12} />
            {t("pipelines.whyDidItFail")}
          </button>
        )}
      </div>

      {analysis && key && (
        <AnalysisDrawer
          runId={analysis.aiRunId}
          startedAt={analysis.startedAt}
          running={running}
          text={analysis.text}
          error={analysis.error}
          // Removed, not blanked. `setAnalysis` merges, so writing `undefined` over both fields
          // leaves an entry that still exists — which reads as "still running" forever and hides
          // the button that would start it again.
          onClose={() => clearAnalysis(key)}
        />
      )}
    </>
  );
}

const TOOLBAR =
  "flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]";

/**
 * The answer, under the log it is about.
 *
 * A drawer in this pane rather than a modal or the AI rail, and that is the point: the question is
 * "why did *this* log end like that", and an answer that covers up the evidence is an answer you
 * have to close to check. While it runs it shows the engine's own trace — which is where the
 * "contrasting it with the repository" part of this becomes visible rather than merely claimed.
 */
function AnalysisDrawer({
  runId,
  startedAt,
  running,
  text,
  error,
  onClose,
}: {
  runId: string;
  startedAt: number;
  running: boolean;
  text?: string;
  error?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [traceOpen, setTraceOpen] = useState(true);

  return (
    <div className="flex max-h-[280px] shrink-0 flex-col border-t border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex h-[29px] shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-2.5 pr-2">
        {running && <ThinkingOrb size="sm" />}
        <span className="mr-auto text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("pipelines.analysisTitle")}
        </span>
        <button type="button" onClick={onClose} className={TOOLBAR} aria-label={t("common.close")}>
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {running && (
          <div className="p-2">
            <AiRunLog
              runId={runId}
              running
              startedAt={startedAt}
              expanded={traceOpen}
              onToggle={() => setTraceOpen((open) => !open)}
            />
          </div>
        )}
        {error && <p className="px-3.5 py-3 text-[12.5px] text-[var(--cf-danger)]">{error}</p>}
        {text && (
          <Markdown
            source={text}
            className="cf-markdown-preview px-3.5 py-3 text-[12.5px] leading-[1.62]"
          />
        )}
      </div>
    </div>
  );
}
