import { useEffect, useRef, useState } from "react";
import { ChevronDown, Coins, Gauge, Loader2, Shrink, Undo2 } from "lucide-react";
import {
  CONTEXT_FULL_AT,
  CONTEXT_WARN_AT,
  contextFraction,
  formatTokens,
} from "../../lib/contextWindow";
import { useLocale } from "./chatChrome";
import { useT } from "../../state/languageStore";

/** What the meter is drawn from. Assembled by `ChatView`, which is the only place that has both
 *  the conversation row and its transcript. */
export interface ContextReading {
  /** Tokens in front of the model — measured when `measured`, estimated otherwise. */
  tokens: number;
  /** Whether {@link tokens} came from the engine's own report rather than from counting characters.
   *  Drawn differently, and the difference is the point — see `lib/contextWindow`. */
  measured: boolean;
  /** The model's window, or `null` when this app does not know it. `null` means no bar and no
   *  percentage, ever. */
  window: number | null;
  /** Whether the next turn continues the engine's session or opens a fresh one and replays. */
  resumes: boolean;
  /** How many turns are already covered by a summary, or `0` on an uncompacted thread. */
  compactedTurns: number;
  /** Whether a turn on this conversation would compact it by itself before running. Narrower than
   *  "the setting is on" — see where it is computed, in `ChatView`. */
  autoCompacts: boolean;
  /** The summary itself, so the panel can show it. The user is entitled to read the thing the
   *  engine will be told their conversation said. */
  summary: string;
  compacting: boolean;
  onCompact: () => void;
  onUncompact: () => void;
}

/** The ring. A twelve-pixel donut rather than a bar, because it has to sit in a row of 28px square
 *  controls without being the widest thing in it. */
function Ring({ fraction, tone }: { fraction: number; tone: string }) {
  const r = 5;
  const circumference = 2 * Math.PI * r;
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" className="shrink-0">
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" className="stroke-current opacity-20" />
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        // From twelve o'clock, clockwise, which is the only direction a gauge reads in.
        transform="rotate(-90 7 7)"
        strokeDasharray={`${circumference * fraction} ${circumference}`}
        style={{ stroke: tone }}
      />
    </svg>
  );
}

/**
 * How full the model's context is, and the one button that does something about it.
 *
 * # Why a chat client needs this at all
 *
 * Every conversation here grows until it stops working, and the failure is silent in both of the
 * ways it can happen. A resuming engine fills its window inside the CLI, where this app cannot see;
 * a replaying one is truncated by `REPLAY_CHAR_BUDGET`, which drops the oldest turns *without
 * telling anyone*. Either way the first symptom is a model that has quietly forgotten the beginning
 * of the conversation and answers as though it never happened — which reads as the model getting
 * worse, not as a limit being hit.
 *
 * So the number is put where the decision is made, next to the send button, and the remedy is one
 * click away from it.
 *
 * # Measured and estimated are drawn differently on purpose
 *
 * Where the engine reported its own final prompt, that is the figure, and it is exact — it includes
 * the system prompt and tool schemas, which nothing on this side can count. Everywhere else the
 * meter counts characters and says so, with a `~` the measured number does not carry. Swapping one
 * for the other silently would be the sort of lie that is only found out when a long question is
 * refused.
 *
 * # And the percentage is allowed to be absent
 *
 * The window comes from `ai::context_window_for`, which answers `null` for every model the app is
 * not sure about — including every locally-served one, since `ollama` will run a nominally-128k
 * model at 4096 and nothing in the name says so. Those get the token count and no ring. A gauge at
 * the wrong scale is worse than no gauge, and this is the exact setup where a wrong one would be
 * most confident.
 */
export function ContextMeter({ reading }: { reading: ContextReading }) {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const fraction = contextFraction(reading.tokens, reading.window);
  const tone =
    fraction === null || fraction < CONTEXT_WARN_AT
      ? "var(--cf-accent)"
      : fraction < CONTEXT_FULL_AT
        ? "var(--cf-warning)"
        : "var(--cf-danger)";
  const count = formatTokens(reading.tokens, locale);
  const shown = reading.measured ? count : `~${count}`;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={t("chat.contextTitle")}
        aria-expanded={open}
        className={`flex h-[26px] items-center gap-1 rounded-md px-2 text-[11px] tabular-nums transition-colors hover:bg-[var(--cf-hover)] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        {reading.compacting ? (
          <Loader2 size={12} className="shrink-0 animate-spin" />
        ) : fraction === null ? (
          // No window, no ring. The icon still says "this is about size" without drawing a
          // proportion nobody can stand behind.
          <Gauge size={12} className="shrink-0" />
        ) : (
          <Ring fraction={fraction} tone={tone} />
        )}
        {shown}
      </button>

      {open && (
        <div className="absolute bottom-9 left-0 z-30 w-[320px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 text-[12px] shadow-[var(--cf-shadow)]">
          <p className="mb-2 text-[11px] font-semibold text-[var(--cf-text)]">
            {t("chat.contextTitle")}
          </p>

          <p className="flex items-baseline gap-1.5">
            <span className="text-[18px] font-semibold tabular-nums text-[var(--cf-text)]">
              {shown}
            </span>
            <span className="text-[11px] text-[var(--cf-text-muted)]">
              {reading.window
                ? t("chat.contextOfWindow", {
                    total: formatTokens(reading.window, locale),
                    percent: Math.round((fraction ?? 0) * 100),
                  })
                : t("chat.contextTokensLabel")}
            </span>
          </p>

          {fraction !== null && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--cf-press)]">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${Math.max(2, fraction * 100)}%`, background: tone }}
              />
            </div>
          )}

          <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {reading.measured ? t("chat.contextMeasured") : t("chat.contextEstimated")}
            {!reading.window && ` ${t("chat.contextUnknownWindow")}`}
          </p>

          {/* What the *next* question actually carries, which is the thing the number is about and
              is different for the two halves of this app's providers. */}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {reading.resumes ? t("chat.contextResumes") : t("chat.contextReplays")}
          </p>

          {/* Whether anything happens without being asked. Said either way: a user who does not
              know it is on reads an unexplained extra turn as the app misbehaving, and one who
              assumes it is on when it cannot be (a resuming engine whose window is unknown) is
              relying on a protection that is not there. */}
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t(reading.autoCompacts ? "chat.contextAutoOn" : "chat.contextAutoOff")}
          </p>

          <div className="my-2.5 h-px bg-[var(--cf-border)]" />

          {reading.compactedTurns > 0 && (
            <div className="mb-2">
              <p className="text-[11px] text-[var(--cf-text)]">
                {t("chat.contextCompacted", { n: reading.compactedTurns })}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowSummary((v) => !v)}
                  className="flex items-center gap-0.5 text-[10.5px] text-[var(--cf-accent)] hover:underline"
                >
                  <ChevronDown
                    size={10}
                    className={`transition-transform ${showSummary ? "rotate-180" : ""}`}
                  />
                  {t(showSummary ? "chat.contextHideSummary" : "chat.contextShowSummary")}
                </button>
                <button
                  type="button"
                  onClick={() => reading.onUncompact()}
                  className="flex items-center gap-1 text-[10.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                >
                  <Undo2 size={10} />
                  {t("chat.contextUncompact")}
                </button>
              </div>
              {showSummary && (
                // `whitespace-pre-wrap` and a scroll box: this is prose the model wrote, it can run
                // to several paragraphs, and it must be readable in full rather than elided — the
                // whole reason it is here is so the user can check what was kept.
                <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--cf-hover)] p-2 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
                  {reading.summary}
                </p>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => reading.onCompact()}
            disabled={reading.compacting}
            className="flex w-full items-center gap-2 rounded-lg border border-[var(--cf-border)] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:border-[var(--cf-accent)] disabled:opacity-50"
          >
            {reading.compacting ? (
              <Loader2 size={12} className="shrink-0 animate-spin" />
            ) : (
              <Shrink size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            )}
            <span className="flex-1">
              {t(reading.compacting ? "chat.contextCompacting" : "chat.contextCompact")}
            </span>
            {/* The same coin the regenerate and branch buttons carry, and for the same reason:
                this one looks like a local tidy-up and is in fact a full turn against the engine. */}
            {!reading.compacting && <Coins size={10} className="shrink-0 text-[var(--cf-text-muted)]" />}
          </button>
          <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("chat.contextCompactHint")}
          </p>
        </div>
      )}
    </div>
  );
}
