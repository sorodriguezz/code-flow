import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Terminal,
  X,
} from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { badgeColor, statusColor } from "./methodStyle";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ConsoleLine, RunnerReport, RunnerResultItem, TestResult } from "../../types/api";

/**
 * The report a finished (or still-running) collection run reads as.
 *
 * The shape is deliberately the one a Postman user already knows — a metric strip, then filter
 * tabs over one flat, iteration-grouped list of executed requests with their assertions beneath
 * them, and a detail pane for whichever row is selected. That familiarity is the feature: the
 * previous view was a single undifferentiated list of rows, which answers "did it pass" and
 * nothing else, and "which of the 52 assertions failed, and what did the server actually send
 * back" is the question anyone opens a run report to answer.
 *
 * Every number here is derived from `report` rather than accumulated during the run, so a report
 * re-read from an export renders identically to one that just finished.
 */
export function RunnerResults({
  report,
  running,
  capped,
  cappedMessage,
}: {
  report: RunnerReport | null;
  running: boolean;
  capped: boolean;
  cappedMessage: string;
}) {
  const t = useT();
  const [filter, setFilter] = useState<ResultFilter>("all");
  const [selected, setSelected] = useState<number | null>(null);

  // A fresh run invalidates the selection: index 4 of the previous report is a different request.
  useEffect(() => {
    if (report === null) setSelected(null);
  }, [report]);

  const stats = useMemo(() => summarise(report), [report]);

  if (report === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">
          {running ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" />
              {t("api.runner.running")}
            </span>
          ) : (
            t("api.runner.noResults")
          )}
        </p>
      </div>
    );
  }

  // Narrowing the filter past the open row would leave the detail pane describing a request the
  // list no longer shows — a pane with no row to point back at.
  const changeFilter = (next: ResultFilter) => {
    setFilter(next);
    const open = selected === null ? undefined : report.items[selected];
    if (open !== undefined && !matchesFilter(open, next)) setSelected(null);
  };

  const rows = report.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => matchesFilter(item, filter));

  const detail = selected !== null ? (report.items[selected] ?? null) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- run header ---- */}
      <div className="shrink-0 border-b border-[var(--cf-border)] px-4 pb-2.5 pt-2">
        <p className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {running && <Loader2 size={11} className="animate-spin text-[var(--cf-accent)]" />}
          {running
            ? t("api.runner.running")
            : t("api.runner.ranAt", { time: new Date(report.startedAt).toLocaleTimeString() })}
        </p>

        <div className="mt-2 flex flex-wrap gap-x-7 gap-y-2">
          <Metric label={t("api.runner.source")} value={t("api.runner.sourceRunner")} />
          <Metric
            label={t("api.runner.environment")}
            value={report.environmentName ?? t("api.runner.noEnvironment")}
          />
          <Metric label={t("api.runner.iterations")} value={String(report.iterations)} />
          <Metric label={t("api.runner.duration")} value={formatRunDuration(stats.durationMs)} />
          <Metric label={t("api.runner.allTests")} value={String(report.totalAssertions)} />
          <Metric
            label={t("api.runner.errors")}
            value={String(stats.errors)}
            tone={stats.errors > 0 ? "var(--cf-danger)" : undefined}
          />
          <Metric label={t("api.runner.avgResponse")} value={`${stats.avgMs} ms`} />
        </div>
      </div>

      {capped && (
        <p className="mx-3 mt-2 flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-warning)] bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)] px-2 py-1.5 text-[11px] text-[var(--cf-text)]">
          <AlertTriangle size={12} className="shrink-0 text-[var(--cf-warning)]" />
          {cappedMessage}
        </p>
      )}

      {/* ---- filter tabs ---- */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--cf-border)] px-3">
        {FILTERS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => changeFilter(id)}
            className={`shrink-0 border-b-2 px-2 py-1.5 text-[11px] ${
              filter === id
                ? "border-[var(--cf-accent)] font-medium text-[var(--cf-accent)]"
                : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {t(label)}
            {id !== "all" && id !== "console" && (
              <span className="ml-1 opacity-70">({stats[id]})</span>
            )}
          </button>
        ))}
      </div>

      {/* ---- list + detail ---- */}
      {filter === "console" ? (
        <ConsoleView since={report.startedAt} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-auto">
            {rows.length === 0 ? (
              <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">
                {t("api.runner.filterEmpty")}
              </p>
            ) : (
              groupByIteration(rows).map(([iteration, group]) => (
                <div key={iteration}>
                  <p className="sticky top-0 z-[1] border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--cf-text-muted)]">
                    {t("api.runner.iteration", { n: iteration + 1 })}
                  </p>
                  {group.map(({ item, index }) => (
                    <ResultRow
                      key={`${item.iteration}-${item.requestId}-${index}`}
                      item={item}
                      filter={filter}
                      active={selected === index}
                      onSelect={() => setSelected(selected === index ? null : index)}
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          {detail !== null && (
            <DetailPane item={detail} onClose={() => setSelected(null)} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * `skipped` is absent on purpose. Postman has it because `pm.test.skip()` exists there; this
 * sandbox has no such call, so the tab would be a permanent zero — a column of dead UI that
 * costs a real one its width.
 */
type ResultFilter = "all" | "passed" | "failed" | "errors" | "console";

const FILTERS: { id: ResultFilter; label: TranslationKey }[] = [
  { id: "all", label: "api.runner.allTests" },
  { id: "passed", label: "api.runner.passed" },
  { id: "failed", label: "api.runner.failed" },
  { id: "errors", label: "api.runner.errors" },
  { id: "console", label: "api.runner.consoleLog" },
];

function matchesFilter(item: RunnerResultItem, filter: ResultFilter): boolean {
  if (filter === "errors") return item.error !== null;
  if (filter === "passed") return item.tests.some((test) => test.passed);
  if (filter === "failed") return item.tests.some((test) => !test.passed);
  return true;
}

/** The assertions a row shows under the current filter — all of them, or just the matching side. */
function visibleTests(item: RunnerResultItem, filter: ResultFilter): TestResult[] {
  if (filter === "passed") return item.tests.filter((test) => test.passed);
  if (filter === "failed") return item.tests.filter((test) => !test.passed);
  return item.tests;
}

/** Consecutive rows of the same iteration, in run order — iterations never interleave. */
function groupByIteration(
  rows: { item: RunnerResultItem; index: number }[],
): [number, { item: RunnerResultItem; index: number }[]][] {
  const out: [number, { item: RunnerResultItem; index: number }[]][] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === row.item.iteration) last[1].push(row);
    else out.push([row.item.iteration, [row]]);
  }
  return out;
}

function summarise(report: RunnerReport | null) {
  if (report === null) return { durationMs: 0, errors: 0, avgMs: 0, passed: 0, failed: 0 };
  const answered = report.items.filter((item) => item.status !== null);
  const total = answered.reduce((sum, item) => sum + item.durationMs, 0);
  return {
    durationMs: Math.max(0, report.finishedAt - report.startedAt),
    errors: report.items.filter((item) => item.error !== null).length,
    avgMs: answered.length === 0 ? 0 : Math.round(total / answered.length),
    passed: report.totalAssertions - report.failedAssertions,
    failed: report.failedAssertions,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ResultRow({
  item,
  filter,
  active,
  onSelect,
}: {
  item: RunnerResultItem;
  filter: ResultFilter;
  active: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const tests = visibleTests(item, filter);

  return (
    <div className={`border-b border-[var(--cf-border)] ${active ? "bg-[var(--cf-accent-soft)]" : ""}`}>
      <button
        onClick={onSelect}
        className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <span
          className="mt-[1px] w-[46px] shrink-0 font-mono text-[10px] font-semibold uppercase"
          style={{ color: badgeColor("http", item.method) }}
        >
          {item.method}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {item.folderPath.length > 0 && (
              <span className="min-w-0 max-w-[45%] truncate text-[11px] text-[var(--cf-text-muted)]">
                {item.folderPath.join(" / ")}
                <span className="px-1 opacity-60">/</span>
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
              {item.name}
            </span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
            {item.url}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2 pt-[1px]">
          {item.status !== null && (
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold"
              style={{
                color: statusColor(item.status),
                background: `color-mix(in oklab, ${statusColor(item.status)} 14%, transparent)`,
              }}
            >
              {item.status}
            </span>
          )}
          {item.tests.length > 0 && (
            <span className="font-mono text-[10px] text-[var(--cf-text-muted)]">
              • {item.tests.length}
            </span>
          )}
          <ChevronRight
            size={13}
            className={`text-[var(--cf-text-muted)] ${active ? "rotate-90" : ""}`}
          />
        </span>
      </button>

      {item.error !== null && (
        <p className="flex items-start gap-1.5 px-3 pb-2 pl-[56px] text-[11px] leading-snug text-[var(--cf-danger)]">
          <AlertTriangle size={12} className="mt-[1px] shrink-0" />
          {item.error}
        </p>
      )}

      {tests.map((test, index) => (
        <div key={index} className="flex items-start gap-2 px-3 pb-1 pl-[56px] last:pb-2">
          <span
            className={`mt-[1px] shrink-0 rounded px-1.5 py-[1px] font-mono text-[9px] font-bold tracking-wide ${
              test.passed
                ? "bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] text-[var(--cf-success)]"
                : "bg-[color-mix(in_oklab,var(--cf-danger)_16%,transparent)] text-[var(--cf-danger)]"
            }`}
          >
            {test.passed ? t("api.runner.testPass") : t("api.runner.testFail")}
          </span>
          <span className="min-w-0 flex-1 text-[11px] leading-snug text-[var(--cf-text)]">
            {test.name}
            {!test.passed && test.error !== null && (
              <span className="text-[var(--cf-text-muted)]"> — {test.error}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      <p
        className="truncate text-[12px] font-medium text-[var(--cf-text)]"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail pane
// ---------------------------------------------------------------------------

type DetailTab = "response" | "headers" | "request";

function DetailPane({ item, onClose }: { item: RunnerResultItem; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<DetailTab>("response");
  const capture = item.capture;

  const notice =
    capture === null || capture.bodyNotice === null
      ? null
      : capture.bodyNotice === "binary"
        ? t("api.runner.bodyBinary")
        : capture.bodyNotice === "dropped"
          ? t("api.runner.bodyDropped")
          : t("api.runner.bodyTruncated");

  return (
    <div className="flex w-[42%] min-w-[300px] shrink-0 flex-col border-l border-[var(--cf-border)]">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
        <span
          className="shrink-0 font-mono text-[10px] font-semibold uppercase"
          style={{ color: badgeColor("http", item.method) }}
        >
          {item.method}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium" title={item.name}>
          {item.name}
        </span>
        <button
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
          className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2">
        {(
          [
            ["response", t("api.runner.detailResponse")],
            ["headers", t("api.response.headers")],
            ["request", t("api.runner.detailRequest")],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`border-b-2 px-2 py-1.5 text-[11px] ${
              tab === id
                ? "border-[var(--cf-accent)] font-medium text-[var(--cf-accent)]"
                : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-2 pr-1 font-mono text-[10px] text-[var(--cf-text-muted)]">
          {item.status !== null && (
            <span style={{ color: statusColor(item.status) }}>
              {item.status}
              {capture?.statusText ? ` ${capture.statusText}` : ""}
            </span>
          )}
          <span>{item.durationMs} ms</span>
          <span>{formatBytes(item.sizeBytes)}</span>
        </span>
      </div>

      {capture === null ? (
        <p className="p-3 text-[11px] text-[var(--cf-text-muted)]">{t("api.runner.noCapture")}</p>
      ) : tab === "headers" ? (
        <HeaderTable rows={capture.responseHeaders} />
      ) : tab === "request" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="shrink-0 break-all border-b border-[var(--cf-border)] px-3 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
            {item.url}
          </p>
          {/* Capped rather than stretched: a request with two headers and a body would otherwise
              spend half the pane on empty table and push the body off the bottom. */}
          <div className="flex max-h-[45%] min-h-0 flex-col">
            <HeaderTable rows={capture.requestHeaders} />
          </div>
          {capture.requestBody !== "" && (
            <div className="min-h-0 flex-1 border-t border-[var(--cf-border)]">
              <BodyView text={capture.requestBody} path={REQUEST_BODY_MODEL} />
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {notice !== null && (
            <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1 text-[11px] text-[var(--cf-warning)]">
              {notice}
            </p>
          )}
          {capture.responseBody === "" ? (
            <p className="p-3 text-[11px] text-[var(--cf-text-muted)]">{t("api.runner.noBody")}</p>
          ) : (
            <BodyView
              text={formatJson(capture.responseBody)}
              path={RESPONSE_BODY_MODEL}
              language={languageOf(headerValue(capture.responseHeaders, "content-type"))}
            />
          )}
        </div>
      )}
    </div>
  );
}

function HeaderTable({ rows }: { rows: [string, string][] }) {
  const t = useT();
  if (rows.length === 0) {
    return <p className="p-3 text-[11px] text-[var(--cf-text-muted)]">{t("api.runner.noHeaders")}</p>;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {rows.map(([key, value], index) => (
        <div
          key={`${key}-${index}`}
          className="flex gap-2 border-b border-[var(--cf-border)] px-3 py-1 last:border-b-0"
        >
          <span className="w-[38%] shrink-0 break-all font-mono text-[11px] text-[var(--cf-text-muted)]">
            {key}
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--cf-text)]">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The two model URIs this pane owns — **constants, one per panel, not one per row**.
 *
 * `@monaco-editor/react` mints a model on every new `path` (`getOrCreateModel` → `setModel`) and
 * never disposes the one it just left; only the model an editor is holding at unmount goes away.
 * These paths used to carry the iteration and the request id, so a 50-request run over 20
 * iterations left a thousand live text models behind after the user clicked through the report —
 * models nothing could ever show again, since the same row re-selected produces the same URI and
 * gets the cached one.
 *
 * Two constants are safe here for reasons that are worth stating, because they are what would
 * break if this pane grew a third editor:
 *
 *  - The editors are `readOnly`, so the library's `value` effect takes its `setValue` branch
 *    rather than `executeEdits` — the buffer is replaced wholesale, with no undo stop to carry
 *    the previous row's text into the next one.
 *  - `language` is a prop too, and its own effect calls `setModelLanguage`, so a JSON row followed
 *    by an HTML row still highlights correctly on the shared model.
 *  - The request and response panels live in mutually exclusive branches of the tab switch
 *    (`tab === "request"` vs. the response arm), so they are never mounted at once and cannot race
 *    each other for a URI.
 *
 * The cost is per-row scroll position, which a read-only report does not carry between rows
 * anyway. Nothing else keys off these strings: grep for `runner-` finds only this file.
 */
const REQUEST_BODY_MODEL = "runner-req";
const RESPONSE_BODY_MODEL = "runner-res";

function BodyView({
  text,
  path,
  language = "json",
}: {
  text: string;
  path: string;
  language?: string;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  return (
    <Editor
      height="100%"
      path={path}
      language={language}
      value={text}
      theme={monacoTheme}
      // The library keeps a module-level, never-pruned `Map` of view states keyed by path, written
      // on every path change and on unmount. A read-only pane has no cursor or selection worth
      // restoring, so opting out costs nothing and stops feeding a map that only grows.
      saveViewState={false}
      options={{
        ...OVERFLOW_SAFE_OPTIONS,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 11,
        automaticLayout: true,
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        contextmenu: false,
        scrollbar: { alwaysConsumeMouseWheel: false },
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const CONSOLE_TONE: Record<ConsoleLine["level"], string> = {
  log: "var(--cf-text)",
  info: "var(--cf-accent)",
  warn: "var(--cf-warning)",
  error: "var(--cf-danger)",
};

/**
 * The shared script console, clipped to the run.
 *
 * `apiRuntimeStore` keeps one console for the whole session — a request sent from a tab logs into
 * the same buffer the runner does — so showing it whole would put lines from before the run under
 * a heading that says they came from it. Timestamps are what separate them.
 */
function ConsoleView({ since }: { since: number }) {
  const t = useT();
  const lines = useApiRuntimeStore((s) => s.consoleLines);
  const own = lines.filter((line) => line.at >= since);

  if (own.length === 0) {
    return (
      <p className="flex min-h-0 flex-1 items-start gap-1.5 p-4 text-[12px] text-[var(--cf-text-muted)]">
        <Terminal size={13} className="mt-[1px] shrink-0" />
        {t("api.runner.noConsole")}
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      {own.map((line, index) => (
        <div key={index} className="flex gap-2 px-1 py-[2px]">
          <span className="shrink-0 font-mono text-[10px] text-[var(--cf-text-muted)]">
            {new Date(line.at).toLocaleTimeString()}
          </span>
          <span
            className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px]"
            style={{ color: CONSOLE_TONE[line.level] }}
          >
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `9s 228ms` rather than `9228 ms` — a run's duration is read as a wall-clock span. */
function formatRunDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ${ms % 1000}ms`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function headerValue(headers: [string, string][], name: string): string {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1] ?? "";
}

function languageOf(contentType: string): string {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.includes("json")) return "json";
  if (mime.includes("html") || mime.includes("xhtml")) return "html";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return "javascript";
  if (mime.includes("css")) return "css";
  return "plaintext";
}

/** A body that isn't JSON comes back exactly as it arrived — the server's bytes are the truth. */
function formatJson(text: string): string {
  if (text.trim() === "") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
