import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, Check, ChevronRight, CircleAlert, Copy, Loader2, OctagonX, X } from "lucide-react";
import { failedCalls, highlightScript, scriptStatus, type AppScript, type CodeToken, type ScriptStatus } from "../../lib/appScript";
import { writeClipboardText } from "../../lib/clipboard";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * One CodeFlow script (`app_run`) in a run's log: a single row that opens into what it did — every
 * call with its outcome and time, the code the model wrote, and what came back to the model.
 *
 * Closed it costs the feed one line, like any other step; it opens by itself when the script
 * failed, since that is when somebody wants to know where. See `lib/appScript.ts` for the records.
 */
export function ScriptStep({ script, live, reading }: { script: AppScript; live: boolean; reading: boolean }) {
  const t = useT();
  const status = scriptStatus(script);
  const [open, setOpen] = useState(status === "failed");
  const [tab, setTab] = useState<"steps" | "code">("steps");
  // A script that fails while being watched opens then — once; a close after that is the reader's.
  const opened = useRef(status === "failed");
  useEffect(() => {
    if (status === "failed" && !opened.current) {
      opened.current = true;
      setOpen(true);
    }
  }, [status]);

  const calls = script.calls.length;
  const callsLabel = calls === 1 ? t("ai.script.callOne") : t("ai.script.callsN", { n: String(calls) });
  const time = script.ms !== undefined ? formatMs(script.ms) : null;
  const title = script.title || t("ai.script.label");

  return (
    <div
      className={`my-0.5 min-w-0 overflow-hidden rounded-lg bg-[var(--cf-surface)] ${
        status === "failed"
          ? "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--cf-danger)_45%,var(--cf-border))]"
          : "shadow-[inset_0_0_0_1px_var(--cf-border-strong)]"
      }`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`${t("ai.script.label")} · ${title}`}
        className={`flex w-full min-w-0 items-center gap-2 px-2.5 text-left transition-colors hover:bg-[var(--cf-hover)] ${reading ? "py-1.5" : "py-1"}`}
      >
        <Braces size={reading ? 13 : 12} className="shrink-0 text-[var(--cf-accent)]" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className={`shrink-0 font-mono text-[var(--cf-text-faint)] ${reading ? "text-[10.5px]" : "text-[10px]"}`}>{t("ai.script.short")}</span>
          <span className={`truncate text-[var(--cf-text)] ${reading ? "text-[12.5px]" : "text-[11.5px]"}`}>{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          <span className="hidden min-[380px]:inline">
            {callsLabel}
            {time ? ` · ${time}` : ""}
          </span>
          <StatusPill status={status} script={script} live={live} />
          <ChevronRight size={12} className={`text-[var(--cf-text-faint)] transition-transform duration-200 ${open ? "rotate-90" : ""}`} aria-hidden />
        </span>
      </button>

      {open && (
        <div className="cf-fade-in border-t border-[var(--cf-border)]">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
            <div role="tablist" aria-label={t("ai.script.label")} className="inline-flex gap-0.5 rounded-md bg-[var(--cf-sunken)] p-0.5">
              {(["steps", "code"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  disabled={id === "code" && !script.code}
                  className={`rounded px-2 py-[1px] text-[10.5px] transition-colors disabled:opacity-40 ${
                    tab === id
                      ? "bg-[var(--cf-surface-raised)] text-[var(--cf-text)] shadow-[0_1px_2px_rgba(18,20,40,0.08),inset_0_0_0_1px_var(--cf-border)]"
                      : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                  }`}
                >
                  {t(id === "steps" ? "ai.script.tabSteps" : "ai.script.tabCode")}
                </button>
              ))}
            </div>
            <span className="text-[10.5px] text-[var(--cf-text-faint)]">{t(script.acts ? "ai.script.noDestructive" : "ai.script.readOnly")}</span>
          </div>

          {tab === "steps" ? <CallList script={script} live={live} /> : <CodeView code={script.code} />}

          {script.done && !script.ok && script.error && (
            <div className="mx-2.5 mb-2 flex items-start gap-1.5 rounded-md bg-[color-mix(in_oklab,var(--cf-danger)_9%,transparent)] px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
              <CircleAlert size={12} className="mt-[2px] shrink-0" aria-hidden />
              <span className="min-w-0 select-text break-words">{script.error}</span>
            </div>
          )}
          {script.done && script.ok && script.returned !== undefined && (
            <div className="mx-2.5 mb-2 min-w-0 rounded-md bg-[var(--cf-sunken)] px-2 py-1.5">
              <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--cf-text-faint)]">{t("ai.script.returned")}</div>
              <div className="max-h-24 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
                {script.returned}
              </div>
            </div>
          )}
          {script.logs && (
            <div className="mx-2.5 mb-2 min-w-0 rounded-md px-2 py-1.5 shadow-[inset_0_0_0_1px_var(--cf-border)]">
              <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-[var(--cf-text-faint)]">{t("ai.script.console")}</div>
              <div className="max-h-20 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
                {script.logs}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<Exclude<ScriptStatus, "partial" | "failed">, TranslationKey> = {
  running: "ai.script.running",
  ok: "ai.script.done",
  stopped: "ai.script.stopped",
  timeout: "ai.script.timedOut",
};

function StatusPill({ status, script, live }: { status: ScriptStatus; script: AppScript; live: boolean }) {
  const t = useT();
  const base = "inline-flex h-[17px] items-center gap-1 rounded-full px-1.5 font-sans text-[10px] font-medium";
  if (status === "running") {
    // A run that ended without the script's last record (killed with the app) is not still running.
    return live ? (
      <span className={`${base} text-[var(--cf-ai-a)]`}>
        <Loader2 size={10} className="animate-spin" aria-hidden />
        <span className="cf-text-shimmer">{t(STATUS_LABEL.running)}</span>
      </span>
    ) : (
      <span className={`${base} text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)]`}>{t("ai.script.unfinished")}</span>
    );
  }
  if (status === "ok") {
    return (
      <span className={`${base} bg-[color-mix(in_oklab,var(--cf-success)_12%,transparent)] text-[var(--cf-success)]`}>
        <Check size={10} strokeWidth={3} aria-hidden />
        {t(STATUS_LABEL.ok)}
      </span>
    );
  }
  if (status === "partial") {
    const n = failedCalls(script);
    return (
      <span className={`${base} bg-[color-mix(in_oklab,var(--cf-warning)_13%,transparent)] text-[var(--cf-warning)]`}>
        <CircleAlert size={10} aria-hidden />
        {n === 1 ? t("ai.script.failedOne") : t("ai.script.failedN", { n: String(n) })}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={`${base} bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)] text-[var(--cf-danger)]`}>
        <X size={10} strokeWidth={3} aria-hidden />
        {script.failedAt !== undefined ? t("ai.script.failedAt", { n: String(script.failedAt + 1) }) : t("ai.script.failed")}
      </span>
    );
  }
  return (
    <span className={`${base} text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)]`}>
      <OctagonX size={10} aria-hidden />
      {t(STATUS_LABEL[status])}
    </span>
  );
}

function CallList({ script, live }: { script: AppScript; live: boolean }) {
  const t = useT();
  const slowest = Math.max(1, ...script.calls.map((call) => call.ms));
  if (script.calls.length === 0 && script.done) {
    return <p className="px-3 pb-2 text-[11px] text-[var(--cf-text-faint)]">{t("ai.script.noCalls")}</p>;
  }
  return (
    <ol className="flex flex-col gap-px px-1.5 pb-1.5">
      {script.calls.map((call, i) => (
        <li
          key={i}
          className={`grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-1.5 py-[3px] ${
            call.ok ? "" : "bg-[color-mix(in_oklab,var(--cf-danger)_7%,transparent)]"
          }`}
        >
          <span className="flex justify-center" aria-label={call.ok ? t("ai.stepDone") : t("ai.script.failed")}>
            {call.ok ? (
              <Check size={11} strokeWidth={3} className="text-[var(--cf-success)]" />
            ) : (
              <X size={11} strokeWidth={3} className="text-[var(--cf-danger)]" />
            )}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-[var(--cf-text)]" title={call.about ? `${call.command} ${call.about}` : call.command}>
            {call.command}
            {call.about && <span className="text-[var(--cf-text-muted)]"> · {call.about}</span>}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-[var(--cf-text-faint)]" title={`${call.ms} ms`}>
            <span
              aria-hidden
              className="hidden h-1 rounded-full bg-[var(--cf-ai-a)] opacity-50 min-[420px]:block"
              style={{ width: `${Math.max(2, Math.round((call.ms / slowest) * 28))}px` }}
            />
            {formatMs(call.ms)}
          </span>
          {call.error && <span className="col-start-2 col-end-4 select-text break-words text-[10.5px] leading-snug text-[var(--cf-danger)]">{call.error}</span>}
        </li>
      ))}
      {!script.done && live && (
        <li className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 px-1.5 py-[3px]">
          <span className="flex justify-center">
            <span className="cf-runstep-live h-1.5 w-1.5 rounded-full bg-[var(--cf-ai-a)]" />
          </span>
          <span className="cf-text-shimmer text-[11px] text-[var(--cf-text-muted)]">{t("ai.script.working")}</span>
        </li>
      )}
    </ol>
  );
}

const TOKEN_CLASS: Record<CodeToken["kind"], string> = {
  plain: "",
  keyword: "text-[var(--cf-violet)]",
  string: "text-[var(--cf-bson-string)]",
  comment: "italic text-[var(--cf-text-faint)]",
  number: "text-[var(--cf-bson-number)]",
  call: "font-semibold text-[var(--cf-accent)]",
};

function CodeView({ code }: { code: string }) {
  const t = useT();
  const tokens = useMemo(() => highlightScript(code.replace(/^\n+|\s+$/g, "")), [code]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className="group relative mx-2.5 mb-2">
      <pre className="max-h-64 select-text overflow-auto rounded-md bg-[var(--cf-sunken)] px-2.5 py-2 font-mono text-[10.5px] leading-[1.65] text-[var(--cf-text)]">
        <code>
          {tokens.map((token, i) =>
            token.kind === "plain" ? (
              token.text
            ) : (
              <span key={i} className={TOKEN_CLASS[token.kind]}>
                {token.text}
              </span>
            ),
          )}
        </code>
      </pre>
      <button
        type="button"
        onClick={() => void writeClipboardText(code).then(() => setCopied(true))}
        title={t(copied ? "ai.script.copied" : "ai.script.copyCode")}
        aria-label={t(copied ? "ai.script.copied" : "ai.script.copyCode")}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--cf-surface-raised)] text-[var(--cf-text-muted)] opacity-0 shadow-[inset_0_0_0_1px_var(--cf-border)] transition-opacity hover:text-[var(--cf-text)] focus-visible:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check size={12} className="text-[var(--cf-success)]" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

/** "14 ms", "1,2 s" — a call's time, short. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}
