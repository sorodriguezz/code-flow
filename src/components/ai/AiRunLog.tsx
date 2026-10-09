import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Cpu, Pencil, RotateCcw, Square } from "lucide-react";
import { useAiRunStore, type AiRunLine } from "../../state/aiRunStore";
import { buttonClass } from "../common/Button";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { RunPhase } from "../../lib/thinking/activity";
import { parseRunSteps, phaseOfSteps, touchedFiles, type RunStep } from "../../lib/runSteps";

/**
 * A run, while it runs — and what it left behind afterwards.
 *
 * This is the whole "what is the model doing right now" surface, and it is **one** card wherever a
 * run is shown: the chats, the assistant panel, agent tasks, chains, reviews, stories, the pipeline
 * and container log analyses. Running, it has three parts:
 *
 * - **The gutter** holds the thinking mark (the design picked in Settings). It is told the phase,
 *   so a mark that can (the dot globe, the orb, the waves) lights up by what is happening.
 * - **The headline** is that phase in one word — Pensando, Leyendo, Editando… — read off the newest
 *   line the CLI printed (`lib/runSteps`), never cycled for effect. Beside it the engine, and on
 *   the right the elapsed time and the step count: the evidence that it is alive.
 * - **The feed** under it is the reasoning (when the engine streams it) and every step as a row,
 *   following its tail under a fade at both edges, the newest row pulsing while it runs.
 *
 * Finished (`running` false, a recorded `lines`), it folds into one quiet line — "Pensó 15 s ·
 * 5 pasos" — that opens to the same rows, wrapped and selectable: the reason anyone opens it is to
 * take a path or a stack trace out of it.
 *
 * `runId` is the id the caller minted and passed to the backend — what ties these lines, the timer
 * and the stop button to this particular run.
 */
export function AiRunLog({
  runId,
  lines: explicitLines,
  running,
  startedAt,
  label,
  durationMs,
  thinking,
  answering = false,
  density = "panel",
  showStop = true,
  onRetry,
  children,
  defaultOpen = false,
}: {
  /** The live run to follow. Omit when passing `lines` — a stored trace has no live run to stop. */
  runId?: string;
  /** A finished run's recorded trace, replayed instead of read from the live store. */
  lines?: AiRunLine[];
  /** Drives the stop button, the timer and the mark — a finished run keeps its log. */
  running: boolean;
  /** When the run actually began. Runs outlive the view that started them, so without this the
   * timer measured how long this card had been mounted — a run left in the background and
   * reopened five minutes later came back reading 0:00 and counting up from there. */
  startedAt?: number | null;
  /** Overrides the running headline with what the caller knows the run *is* ("Generating stories"),
   *  or a finished trace's line when there is no duration to say. */
  label?: string;
  /** A finished run's duration: the folded line then reads "Thought for 15 s". */
  durationMs?: number;
  /** The model's reasoning, streamed live or stored with the turn — shown at the top of the feed. */
  thinking?: string;
  /** The answer itself is streaming now: the headline says so, whatever the last step was. */
  answering?: boolean;
  /** `reading` is the chat workspace's column (larger mark and type); `panel` everything else. */
  density?: "reading" | "panel";
  /**
   * Whether this card draws its own Stop.
   *
   * The run is always stoppable; the question is who says so. In the AI panel and the agent tasks
   * this card is the only thing on screen that knows a run exists, so it has to carry the control.
   * In a chat it does not: the composer's send button has already become Stop, two centimetres
   * below and in the place the user's hand is. Two buttons for one action in one view read as two
   * different actions, so the chat passes `false` and keeps the one that is where you are typing.
   */
  showStop?: boolean;
  /** Stop this run and ask the same thing again — offered when the run has gone quiet, beside Stop,
   *  by the surfaces that know what "the same thing" is (the chats). */
  onRetry?: () => void;
  /** Running only: drawn in the card's column under the feed — the chats put the answer being
   *  written here, so it sits beside the mark that is writing it. */
  children?: ReactNode;
  /** Finished only: start unfolded (a lazily read trace, opened by the click that fetched it). */
  defaultOpen?: boolean;
}) {
  const liveLines = useAiRunStore((s) => (runId ? s.linesByRun[runId] : undefined));
  const lines = explicitLines ?? liveLines;
  const steps = useMemo(() => parseRunSteps(lines), [lines]);

  if (!running) {
    if (steps.length === 0 && !thinking?.trim()) return null;
    return (
      <FinishedRun
        steps={steps}
        thinking={thinking}
        durationMs={durationMs}
        label={label}
        density={density}
        defaultOpen={defaultOpen}
      />
    );
  }
  return (
    <LiveRun
      runId={runId}
      steps={steps}
      startedAt={startedAt ?? null}
      label={label}
      thinking={thinking}
      answering={answering}
      density={density}
      showStop={showStop}
      onRetry={onRetry}
    >
      {children}
    </LiveRun>
  );
}

const PHASE_LABEL: Record<RunPhase, TranslationKey> = {
  start: "ai.phaseStart",
  think: "ai.phaseThink",
  plan: "ai.phasePlan",
  read: "ai.phaseRead",
  search: "ai.phaseSearch",
  tool: "ai.phaseTool",
  edit: "ai.phaseEdit",
  run: "ai.phaseRun",
  delegate: "ai.phaseDelegate",
  write: "ai.phaseWrite",
  work: "ai.phaseWork",
  speak: "ai.phaseSpeak",
};

type StepStatus = "run" | "ok" | "wait" | "stop";

function LiveRun({
  runId,
  steps,
  startedAt,
  label,
  thinking,
  answering,
  density,
  showStop,
  onRetry,
  children,
}: {
  runId?: string;
  steps: RunStep[];
  startedAt: number | null;
  label?: string;
  thinking?: string;
  answering: boolean;
  density: "reading" | "panel";
  showStop: boolean;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const reading = density === "reading";
  const cancelling = useAiRunStore((s) => (runId ? (s.cancelling[runId] ?? false) : false));
  const cancel = useAiRunStore((s) => s.cancel);
  const subagents = useAiRunStore((s) => (runId ? s.subagentsByRun[runId] : undefined));
  const idleLimit = useAiRunStore((s) => (runId ? (s.engineByRun[runId]?.idleLimitSecs ?? null) : null));
  const elapsed = useElapsed(startedAt);
  const quietFor = useQuiet(steps.length + (thinking?.length ?? 0), elapsed);
  /** Open unless the reader folded it. */
  const [folded, setFolded] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  // Which arrived last, reasoning or a step — Claude interleaves them, and the headline should say
  // "Pensando" while the reasoning grows and go back to the step when the next tool is called.
  const [lead, setLead] = useState<"think" | "steps">("steps");
  useEffect(() => {
    if (thinking) setLead("think");
  }, [thinking]);
  useEffect(() => {
    if (steps.length > 0) setLead("steps");
  }, [steps.length]);

  // Not while stopping: a run being killed is expected to say nothing, and announcing that as a
  // stall would be the app worrying about something it is doing itself.
  const quiet = !cancelling && quietFor >= QUIET_AFTER_SECONDS;
  // Silence with a sub-agent out is the run working — its own output waits for theirs — so it is
  // said as that, in the ordinary colour, rather than as a stall.
  const open = subagents ? Object.values(subagents) : [];
  const delegating = open.length > 0;
  const latest = open[open.length - 1];
  // What the watchdog still allows, mirroring `gone_quiet`: three times the limit while a sub-agent
  // is out. Said, so a quiet run reads as something that ends by itself — not a clock that runs on.
  const allowed = idleLimit === null ? null : idleLimit * (delegating ? SUBAGENT_IDLE_FACTOR : 1);
  const autoStopIn = allowed === null ? null : Math.max(0, allowed - quietFor);

  const phase: RunPhase = answering
    ? "write"
    : delegating
      ? "delegate"
      : lead === "think" && thinking
        ? "think"
        : phaseOfSteps(steps);
  const stalled = quiet && !delegating;

  const headline = cancelling
    ? { id: "stopping", text: t("ai.stopping"), tone: "muted" as const }
    : stalled
      ? { id: "quiet", text: t("ai.quietFor", { time: formatElapsed(quietFor) }), tone: "warn" as const }
      : quiet && delegating
        ? { id: "subagents", text: t("ai.subagentsWorking", { n: open.length }), tone: "live" as const }
        : label
          ? { id: "label", text: label, tone: "live" as const }
          : { id: phase, text: t(PHASE_LABEL[phase]), tone: "live" as const };

  const lastIndex = steps.length - 1;
  const lastStatus: StepStatus = cancelling ? "stop" : stalled ? "wait" : "run";
  const hasFeed = steps.length > 0 || !!thinking?.trim() || (delegating && !!latest);
  const showFeed = hasFeed && !folded;
  const quietBar = quiet && runId && (onRetry || !showStop || (autoStopIn !== null && autoStopIn > 0));

  // Follow the tail, the way a terminal does — reasoning and steps arrive faster than they can be
  // read, and a box pinned to the top shows the same four lines for a minute.
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length, thinking, showFeed, latest?.progress]);

  return (
    <div className={`cf-fade-in grid grid-cols-[auto_minmax(0,1fr)] ${reading ? "gap-x-3" : "gap-x-2.5"}`}>
      <div className={`flex items-center justify-center ${reading ? "h-8 w-8" : "h-7 w-[22px]"}`}>
        <ThinkingOrb
          size={reading ? "card" : "md"}
          activity={{ phase, quiet: stalled, stopping: cancelling }}
        />
      </div>
      <div className="min-w-0 space-y-2">
        <div className={`flex items-center gap-2 ${reading ? "min-h-8" : "min-h-7"}`}>
          <button
            type="button"
            onClick={() => setFolded((v) => !v)}
            disabled={!hasFeed}
            title={quiet ? (delegating ? t("ai.subagentsHint") : t("ai.quietHint")) : undefined}
            aria-expanded={hasFeed ? showFeed : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <SwapLabel id={headline.id} text={headline.text} tone={headline.tone} size={reading ? "text-[14px]" : "text-[13px]"} />
            <RunEngineChip runId={runId} />
            {hasFeed && (
              <ChevronRight
                size={13}
                className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-200 ${showFeed ? "rotate-90" : ""}`}
              />
            )}
          </button>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--cf-text-faint)]">
            {formatElapsed(elapsed)}
            {reading && steps.length > 0 && ` · ${stepCount(t, steps.length)}`}
          </span>
          {runId && showStop && (
            <button
              onClick={() => void cancel(runId)}
              disabled={cancelling}
              title={t("ai.stopRun")}
              className={buttonClass({ variant: "secondary", size: "sm" })}
            >
              <Square size={10} className="fill-current" />
              {cancelling ? t("ai.stopping") : t("ai.stop")}
            </button>
          )}
        </div>

        {(showFeed || quietBar) && (
          <div className="overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-sunken)]">
            {showFeed && (
              <div
                ref={feedRef}
                className={`cf-run-feed select-text overflow-y-auto ${reading ? "max-h-36 px-3.5 py-3" : "max-h-28 px-3 py-2.5"}`}
              >
                {thinking?.trim() && (
                  // Italic: the reasoning is the model talking to itself, and the slant is what
                  // keeps it from reading as part of the reply that follows.
                  <p
                    className={`mb-1.5 whitespace-pre-wrap italic leading-[1.65] text-[var(--cf-text-muted)] ${
                      reading ? "text-[13px]" : "text-[11.5px]"
                    }`}
                  >
                    {thinking.trim()}
                  </p>
                )}
                <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
                  {steps.map((step, i) => (
                    <StepRow
                      key={i}
                      step={step}
                      status={i === lastIndex ? lastStatus : "ok"}
                      compact={!reading}
                    />
                  ))}
                  {delegating && latest && (
                    <StepRow
                      step={{
                        kind: "note",
                        tool: "",
                        arg: `${latest.description}${latest.progress ? ` · ${latest.progress}` : ""}`,
                        text: "",
                        sub: true,
                        error: false,
                      }}
                      status="run"
                      compact={!reading}
                    />
                  )}
                </ul>
              </div>
            )}
            {/* What can be done about a quiet run, where the question arises: when it ends by
                itself, and the ways to end it now. Stop joins Retry here where the header has
                none (the chats, whose composer has its own) — beside Retry it is a choice between
                the two, not a second copy of one action. */}
            {quietBar && (
              <div
                className={`flex flex-wrap items-center gap-2 px-3 py-2 ${showFeed ? "border-t border-[var(--cf-border)]" : ""}`}
              >
                <span className="min-w-0 flex-1 text-[11px] text-[var(--cf-text-muted)]">
                  {autoStopIn !== null && autoStopIn > 0 ? t("ai.autoStopIn", { time: formatElapsed(autoStopIn) }) : null}
                </span>
                {onRetry && (
                  <button
                    onClick={onRetry}
                    disabled={cancelling}
                    title={t("ai.retryRunHint")}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    <RotateCcw size={11} />
                    {t("ai.retryRun")}
                  </button>
                )}
                {!showStop && (
                  <button
                    onClick={() => void cancel(runId)}
                    disabled={cancelling}
                    title={t("ai.stopRun")}
                    className={buttonClass({ variant: "secondary", size: "sm" })}
                  >
                    <Square size={10} className="fill-current" />
                    {t("ai.stop")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

/** A finished run: one line that opens to the reasoning and every step, wrapped and selectable. */
function FinishedRun({
  steps,
  thinking,
  durationMs,
  label,
  density,
  defaultOpen,
}: {
  steps: RunStep[];
  thinking?: string;
  durationMs?: number;
  label?: string;
  density: "reading" | "panel";
  defaultOpen: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const reading = density === "reading";
  const count = steps.length > 0 ? stepCount(t, steps.length) : null;
  const headline =
    durationMs !== undefined && durationMs > 0
      ? [t("ai.thoughtFor", { time: formatThoughtTime(durationMs) }), count].filter(Boolean).join(" · ")
      : (label ?? (steps.length > 0 ? t("ai.traceSteps", { n: steps.length }) : t("ai.runOutput")));
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] ${
          reading ? "text-[13px]" : "text-[12px]"
        }`}
      >
        <span className="truncate">{headline}</span>
        <ChevronRight size={13} className={`shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div
          className={`cf-fade-in mt-1.5 max-h-72 select-text overflow-y-auto rounded-xl border border-[var(--cf-border)] bg-[var(--cf-sunken)] ${
            reading ? "px-3.5 py-3" : "px-3 py-2.5"
          }`}
        >
          {thinking?.trim() && (
            <p
              className={`mb-1.5 whitespace-pre-wrap italic leading-[1.65] text-[var(--cf-text-muted)] ${
                reading ? "text-[13px]" : "text-[11.5px]"
              }`}
            >
              {thinking.trim()}
            </p>
          )}
          <ul className="grid min-w-0 grid-cols-[minmax(0,1fr)]">
            {steps.map((step, i) => (
              <StepRow key={i} step={step} status="ok" compact wrap />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const STATUS_KEY: Record<StepStatus, TranslationKey> = {
  run: "ai.stepRunning",
  ok: "ai.stepDone",
  wait: "ai.stepWaiting",
  stop: "ai.stepStopped",
};

/**
 * One row of the feed. A tool call is the tool and what it was called on, in mono, with a dot that
 * says how it went; the model's own words and the CLI's statuses are plain text under a faint dot.
 * `compact` drops the status word (narrow panels), `wrap` lets long lines wrap (finished traces).
 */
function StepRow({ step, status, compact, wrap }: { step: RunStep; status: StepStatus; compact?: boolean; wrap?: boolean }) {
  const t = useT();
  const dot =
    step.error
      ? "bg-[var(--cf-warning)]"
      : status === "run"
        ? "cf-runstep-live bg-[var(--cf-ai-a)]"
        : status === "wait"
          ? "bg-[var(--cf-warning)]"
          : status === "stop" || step.kind !== "tool"
            ? "bg-[var(--cf-border-strong)]"
            : "bg-[var(--cf-success)]";
  const clip = wrap ? "whitespace-pre-wrap break-words" : "truncate";
  return (
    <li className={`cf-runstep-in flex min-w-0 gap-2 py-[3px] leading-[1.45] ${wrap ? "items-start" : "items-center"}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot} ${wrap ? "mt-[6px]" : ""}`} />
      {step.sub && <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-faint)]">↳</span>}
      {step.kind === "tool" ? (
        <>
          <span className="shrink-0 font-mono text-[11.5px] font-medium text-[var(--cf-text)]">{step.tool}</span>
          <span title={step.arg} className={`min-w-0 flex-1 font-mono text-[11.5px] text-[var(--cf-text-muted)] ${clip}`}>
            {step.arg}
          </span>
        </>
      ) : (
        <span
          className={`min-w-0 flex-1 text-[12px] ${clip} ${
            step.error ? "font-mono text-[11px] text-[var(--cf-warning)]" : step.kind === "note" ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          {step.arg}
        </span>
      )}
      {!compact && step.kind === "tool" && (
        <span
          className={`shrink-0 text-[10px] uppercase tracking-[0.06em] ${
            status === "run" ? "cf-text-shimmer" : status === "wait" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-faint)]"
          }`}
        >
          {t(STATUS_KEY[status])}
        </span>
      )}
    </li>
  );
}

/**
 * The headline, swapping words the way the orb component does: the old one rises and blurs out as
 * the new one rises in. Keyed on `id` rather than the text, so a headline whose words tick (the
 * quiet timer) updates in place instead of animating every second.
 */
function SwapLabel({ id, text, tone, size }: { id: string; text: string; tone: "live" | "warn" | "muted"; size: string }) {
  const [shown, setShown] = useState({ id, text, tone, n: 0 });
  const [leaving, setLeaving] = useState<typeof shown | null>(null);
  if (shown.id !== id) {
    // Derived during render — React's pattern for state that follows a prop's previous value.
    setLeaving(shown);
    setShown({ id, text, tone, n: shown.n + 1 });
  } else if (shown.text !== text || shown.tone !== tone) {
    setShown({ ...shown, text, tone });
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), 280);
    return () => clearTimeout(timer);
  }, [leaving]);
  const toneClass = (value: typeof tone) =>
    value === "live" ? "cf-text-shimmer" : value === "warn" ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]";
  return (
    <span className={`relative inline-grid min-w-0 shrink-0 font-semibold ${size}`}>
      {leaving && (
        <span key={`out-${leaving.n}`} aria-hidden className={`cf-run-label-out whitespace-nowrap [grid-area:1/1] ${toneClass(leaving.tone)}`}>
          {leaving.text}
        </span>
      )}
      <span key={`in-${shown.n}`} className={`whitespace-nowrap [grid-area:1/1] ${shown.n > 0 ? "cf-run-label-in" : ""} ${toneClass(shown.tone)}`}>
        {shown.text}
      </span>
    </span>
  );
}

/**
 * The files a finished turn read or changed, as numbered chips under its answer — its sources.
 * Clicking one copies its path: the chats have no single editor to open it in.
 */
export function RunFileChips({ lines, density = "panel" }: { lines?: AiRunLine[]; density?: "reading" | "panel" }) {
  const t = useT();
  const files = useMemo(() => touchedFiles(parseRunSteps(lines)), [lines]);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (files.length === 0) return null;
  const reading = density === "reading";
  return (
    <div className="cf-fade-in flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--cf-text-faint)]">
        {t("ai.touchedFiles")}
      </span>
      {files.map((file, i) => (
        <button
          key={file.path}
          type="button"
          title={file.path}
          onClick={() => {
            void navigator.clipboard?.writeText(file.path).then(() => setCopied(file.path), () => undefined);
          }}
          className={`inline-flex max-w-[16rem] items-center gap-1.5 rounded-full py-0 pl-1 pr-2 font-mono text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] transition-colors hover:bg-[var(--cf-hover)] ${
            reading ? "h-6 text-[11.5px]" : "h-[22px] text-[10.5px]"
          }`}
        >
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--cf-surface-raised)] text-[9.5px] text-[var(--cf-text-muted)]">
            {copied === file.path ? <Check size={9} className="text-[var(--cf-success)]" /> : i + 1}
          </span>
          <span className="truncate">{file.path.split(/[\\/]/).pop()}</span>
          {file.edited && (
            <Pencil size={10} className="shrink-0 text-[var(--cf-warning)]" aria-label={t("ai.touchedFileEdited")} />
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The engine and model behind a running turn, as a quiet chip: `Claude · opus-4.5`.
 *
 * Reads the run's own announcement rather than the settings: which provider and model a task gets
 * is decided by per-task routing, so the answer belongs to the run, not to the screen showing it.
 * Renders nothing until the backend has said (a run has no engine for its first instant) and
 * nothing at all for a stored trace with no live run.
 *
 * The model id is shown as the CLI takes it, only stripped of a provider prefix (`anthropic/…`,
 * `openai/…`) that repeats what the engine name already said. An empty model means nothing was
 * forced and the CLI is picking its own default — the chip then names the engine alone, because
 * printing a model this app didn't choose would be a guess presented as fact.
 */
export function RunEngineChip({ runId }: { runId?: string }) {
  const t = useT();
  const engine = useAiRunStore((s) => (runId ? (s.engineByRun[runId] ?? null) : null));
  if (!engine) return null;
  const { engine: name, model } = engine;
  const short = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return (
    // The composer's engine chip at run size: the same pill and hairline, so "what answers" reads
    // the same before the run and during it.
    <span
      title={model ? `${name} · ${model}` : t("ai.engineDefaultModel", { engine: name })}
      className="inline-flex h-5 min-w-0 shrink items-center gap-1 overflow-hidden rounded-full px-2 text-[11px] font-medium text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)]"
    >
      <Cpu size={11} className="shrink-0" />
      <span className="truncate">{short ? `${name} · ${short}` : name}</span>
    </span>
  );
}

/**
 * How long a run may print nothing before the card says so.
 *
 * Four minutes, and the number is chosen against the *quietest* engine rather than the chattiest.
 * Every CLI here emits an event stream while it works — steps, tool calls, reasoning — so silence
 * is not how any of them behave normally, not even the ones that withhold the reply itself until
 * the end. What it does look like is a run blocked before it ever reached the model: an MCP server
 * that never completed its handshake, an auth flow waiting for a browser nobody can open in a
 * headless run. Those hang indefinitely, because nothing in `ai.rs` times a child out — `Stop` is
 * the only way out and this is the only thing that will tell you to reach for it.
 *
 * Generous on purpose. The cost of being late is a few more minutes of an already-wasted wait; the
 * cost of being early is crying stall on a model that was thinking.
 */
const QUIET_AFTER_SECONDS = 240;

/** `ai_runs::SUBAGENT_IDLE_FACTOR`: how many times the silence the watchdog allows while a sub-agent
 *  is out. Mirrored so the countdown says what the backend will actually do. */
const SUBAGENT_IDLE_FACTOR = 3;

/**
 * Seconds since the run last showed a sign of life — a line, or more reasoning.
 *
 * Measured two ways, deliberately. A run that has shown **nothing** has been quiet for its whole
 * life, so that one is simply the elapsed time and is exact — and it is also the case this exists
 * for. Once something has arrived the clock restarts from when this card *saw* it, which
 * under-reports for a card that adopted a run already in flight: it cannot know when the last line
 * landed, and under-reporting silence is the only direction that never invents it.
 *
 * `elapsed` is passed in rather than timed again — it already ticks once a second, which is the
 * beat this needs, and a second interval would only duplicate it.
 */
function useQuiet(signs: number, elapsed: number): number {
  const since = useRef(Date.now());
  useEffect(() => {
    since.current = Date.now();
  }, [signs]);
  if (signs === 0) return elapsed;
  return Math.max(0, Math.floor((Date.now() - since.current) / 1000));
}

/** Seconds since the run started, ticking while it does. Counted from `startedAt` when the caller
 * knows it — mount time is only a fallback for a run whose start nobody recorded. */
function useElapsed(startedAt: number | null): number {
  const [mountedAt] = useState(() => Date.now());
  const started = startedAt ?? mountedAt;
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - started) / 1000)));
  useEffect(() => {
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [started]);
  return seconds;
}

/** `m:ss` under an hour, `h:mm:ss` over it — a review that runs that long has earned the extra field. */
function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** "1 paso", "5 pasos" — the one step is said in the singular. */
function stepCount(t: ReturnType<typeof useT>, n: number): string {
  return n === 1 ? t("ai.stepOne") : t("ai.stepsN", { n: String(n) });
}

/** "15 s", "2 min 05 s" — a duration said as one, for the folded line of a finished run. */
export function formatThoughtTime(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${String(seconds).padStart(2, "0")} s` : `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
