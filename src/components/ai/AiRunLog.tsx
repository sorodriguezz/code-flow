import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Cpu, Square } from "lucide-react";
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
 *   steps have gone by, and Stop — the last of which a caller can turn off with `showStop` when
 *   something closer to the user's hands already offers it.
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
  startedAt,
  label,
  showStop = true,
  expanded,
  onToggle,
}: {
  /** The live run to follow. Omit when passing `lines` — a stored trace has no live run to stop. */
  runId?: string;
  /** A finished run's recorded trace, replayed instead of read from the live store. */
  lines?: AiRunLine[];
  /** Drives the stop button, the timer and the progress bar — a finished run keeps its log. */
  running: boolean;
  /** When the run actually began. Runs outlive the view that started them, so without this the
   * timer measured how long this card had been mounted — a run left in the background and
   * reopened five minutes later came back reading 0:00 and counting up from there. */
  startedAt?: number | null;
  /** Overrides the headline. A finished trace wants something stable like "3 steps". */
  label?: string;
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
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const liveLines = useAiRunStore((s) => (runId ? s.linesByRun[runId] : undefined));
  const lines = explicitLines ?? liveLines;
  const cancelling = useAiRunStore((s) => (runId ? (s.cancelling[runId] ?? false) : false));
  const cancel = useAiRunStore((s) => s.cancel);
  const scrollRef = useRef<HTMLDivElement>(null);
  const elapsed = useElapsed(running, startedAt ?? null);
  const quietFor = useQuiet(running, lines?.length ?? 0, elapsed);

  // Follow the tail, the way a terminal does.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines?.length, expanded]);

  if (!lines || (lines.length === 0 && !running)) return null;

  // One entry can carry a couple of lines (an assistant turn's prose plus the tool it called);
  // the newest of them is what the run is doing right now.
  const lastLine = lines[lines.length - 1]?.text.split("\n").pop();
  // Not while stopping: a run being killed is expected to say nothing, and announcing that as a
  // stall would be the app worrying about something it is doing itself.
  const quiet = running && !cancelling && quietFor >= QUIET_AFTER_SECONDS;

  const chevron = expanded ? (
    <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
  ) : (
    <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
  );

  const body = expanded && lines.length > 0 && (
    <div
      ref={scrollRef}
      // Selectable: this is the run's own output, and the reason anyone expands it is to take a
      // stack trace or a path out of it and go look.
      className="max-h-48 select-text overflow-auto border-t border-[var(--cf-border)] px-2.5 py-1.5 font-mono text-[10px] leading-[1.5]"
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

        <button
          onClick={onToggle}
          title={quiet ? t("ai.quietHint") : undefined}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5">
            <span
              className={`shrink-0 text-[12px] font-medium ${
                quiet ? "text-[var(--cf-warning)]" : "text-[var(--cf-text)]"
              }`}
            >
              {label ??
                (cancelling
                  ? t("ai.stopping")
                  : quiet
                    ? t("ai.quietFor", { time: formatElapsed(quietFor) })
                    : t("ai.working"))}
            </span>
            {/* "Working…" on its own never said *what* is working, and the answer isn't derivable
                from the panel: the provider and model come from per-task routing, so the run in
                front of you can be on a different engine than the one Settings shows first. It
                shrinks before the headline does — the state matters more than the name — and a run
                whose engine hasn't been announced yet simply doesn't render it. */}
            <RunEngineChip runId={runId} />
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

        {runId && showStop && (
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
    <span
      title={model ? `${name} · ${model}` : t("ai.engineDefaultModel", { engine: name })}
      className="flex min-w-0 shrink items-center gap-1 rounded-full bg-black/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-[var(--cf-text-muted)] dark:bg-white/[0.08]"
    >
      <Cpu size={9} className="shrink-0" />
      <span className="truncate">{short ? `${name} · ${short}` : name}</span>
    </span>
  );
}

/** Seconds since the run started, ticking while it does. Counted from `startedAt` when the caller
 * knows it — mount time is only a fallback for a run whose start nobody recorded. */
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

/**
 * Seconds since the run last printed a line.
 *
 * Measured two ways, deliberately. A run that has printed **nothing** has been quiet for its whole
 * life, so that one is simply the elapsed time and is exact — and it is also the case this exists
 * for. Once a line has arrived the clock restarts from when this card *saw* it, which under-reports
 * for a card that adopted a run already in flight: it cannot know when the last line landed, and
 * under-reporting silence is the only direction that never invents it.
 *
 * `elapsed` is passed in rather than timed again — it already ticks once a second, which is the
 * beat this needs, and a second interval would only duplicate it.
 */
function useQuiet(running: boolean, steps: number, elapsed: number): number {
  const since = useRef(Date.now());
  useEffect(() => {
    since.current = Date.now();
  }, [steps]);
  if (!running) return 0;
  if (steps === 0) return elapsed;
  return Math.max(0, Math.floor((Date.now() - since.current) / 1000));
}

function useElapsed(running: boolean, startedAt: number | null): number {
  const [seconds, setSeconds] = useState(() => (startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0));
  useEffect(() => {
    if (!running) return;
    const started = startedAt ?? Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return seconds;
}

/** `m:ss` under an hour, `h:mm:ss` over it — a review that runs that long has earned the extra field. */
function formatElapsed(seconds: number): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}
