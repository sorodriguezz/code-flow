import { create } from "zustand";
import { cancelAiRun } from "../lib/tauri/commands";
import {
  onAiDone,
  onAiEngine,
  onAiOutputBatch,
  type AiEngineEvent,
  type AiOutputBatchEvent,
} from "../lib/tauri/events";
import { formatAgentLogLine } from "../lib/agentLog";
// Types only, so neither of these is a module this one depends on at runtime — `notificationStore`
// in particular reaches back into half the app, and importing it for real here would close a cycle.
import type { TranslationKey } from "../lib/i18n/translations";
import type { NotificationTarget } from "./notificationStore";

/** Only the tail is kept: a long agent run emits thousands of lines and nobody scrolls back
 * through them live — the full transcript is whatever the CLI itself writes to its own logs. */
const MAX_LINES = 400;

/** How many runs keep a live buffer.
 *
 * `MAX_LINES` bounds one run; nothing used to bound the *number* of runs. Every id is unique
 * (`newRunId` mints a UUID), so the "cleared when the same id starts again" the old comment
 * promised could never fire, and `clear()` has no callers — a session that reviewed forty pull
 * requests kept forty 400-line buffers alive until the window was closed.
 *
 * Eight is enough that everything the UI can have on screen at once is still here: only a *running*
 * run renders from this store (see every `AiRunLog runId=` call site — each one is gated on
 * running/sending/generating), and a finished one renders from the copy taken by `snapshotTrace`. */
const MAX_RUNS = 8;

/** How much of a run's log travels with the message that kept it.
 *
 * Matches `ai_runs.rs::MAX_TRACE_LINES` on purpose: that is what the backend writes to
 * `activity_log`, so a trace read back tomorrow shows exactly what the live one showed today. It
 * is the *copy* rather than the number that matters here — holding the store's own array pinned
 * the whole buffer and made evicting it free nothing at all. */
const MAX_TRACE_LINES = 300;

export interface AiRunLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** What is doing the work on a run: the engine's display name and, when one was forced, the model
 * id. An empty `model` means the CLI is choosing for itself — shown as the engine alone rather than
 * as an invented model name. */
export interface AiRunEngine {
  engine: string;
  model: string;
}

/**
 * What a run *is*, for anything that lists runs rather than renders one.
 *
 * Every model execution in this app goes through [`AiRunState.start`] — a turn, a review, a wiki
 * page, an inline edit — so that call is the one place where "an engine is running" can be known
 * without each feature reporting itself separately. This is what it reports.
 *
 * The kind is a **key**, not a sentence: a run started before a language switch would otherwise
 * still be labelled in the old one for as long as it lasts, and the longest runs here are minutes.
 */
export interface AiRunAbout {
  kindKey: TranslationKey;
  /** What it is acting on — a task's title, a pull request, a file name. User data, so it is the
   * one part that is never translated. */
  detail: string;
  /**
   * Where to go to watch it, in the notification centre's own vocabulary — which is what makes
   * following a *running* run and following a finished one the same landing.
   *
   * Absent for a run whose place is already on screen. An inline edit in the editor has nowhere to
   * send anybody: they are looking at it.
   */
  target?: NotificationTarget;
  /** The workspace it belongs to, so a target can cross back into it. Stamped from wherever the
   * run started, since it may well outlive the user's presence there. */
  workspaceId?: string | null;
}

interface AiRunState {
  /** Live output per run id. Entries survive the run ending so a finished job can still show
   * what it printed; the oldest *settled* ones are dropped once more than `MAX_RUNS` have
   * accumulated (see `start`), or explicitly. */
  linesByRun: Record<string, AiRunLine[]>;
  /** Engine + model per run id, as announced by the backend when the run starts.
   *
   * Deliberately **not** capped along with the rest: the SQL console names the engine on the
   * *answer*, long after the run settled (`SqlConsolePanel` → `RunEngineChip`), so evicting this
   * would quietly blank a chip that is still on screen. Two short strings per run is a few hundred
   * bytes — the buffers next door are four hundred lines each, and they are the actual leak. */
  engineByRun: Record<string, AiRunEngine>;
  /** What each run is, for the status bar's list of everything in flight. Written by `start` and
   * evicted with the buffers; a run with no entry still counts as running, it is just unnamed. */
  aboutByRun: Record<string, AiRunAbout>;
  /** Runs the UI believes are in flight — set on start, cleared on finish. */
  active: Record<string, boolean>;
  /** Ids the user asked to stop, so the UI can show "stopping…" until the process actually dies
   * and can tell an intentional stop apart from a crash when the error arrives. */
  cancelling: Record<string, boolean>;
  /** Subscribes to the backend's output events. Idempotent — safe to call from an effect. */
  init: () => void;
  /** `about` is optional so a run can never fail to register for want of a description — an
   * unnamed row in the status bar is a worse answer than a named one and a much better answer than
   * a model running with nothing on screen to say so. */
  start: (runId: string, about?: AiRunAbout) => void;
  finish: (runId: string) => void;
  cancel: (runId: string) => Promise<void>;
  clear: (runId: string) => void;
  linesFor: (runId: string) => AiRunLine[];
}

const EMPTY_LINES: AiRunLine[] = [];

/**
 * Whether [`init`] has already run, and the handles to undo it.
 *
 * Three separate `listen` calls, and all three belong here. Only the first one used to be kept,
 * which meant `unlisten` claimed to detach the subscription while two others carried on — harmless
 * today because nothing tears this store down, and precisely the kind of thing that is not
 * harmless the first time something does.
 *
 * `subscribed` is a flag rather than "is the array non-empty" because the array fills
 * asynchronously: the guard has to hold from the first synchronous line of `init`, or a second
 * call in the same tick (React StrictMode mounting effects twice) registers everything twice.
 */
let subscribed = false;
const offs: (() => void)[] = [];

/** Run ids in the order they started, oldest first — the eviction order for `start`. Bookkeeping
 * rather than state: nothing renders it, so putting it in the store would only make every run
 * start re-render every subscriber. */
let recentRuns: string[] = [];

/** Drops the keys `gone` names, or hands back the same object when there is nothing to drop —
 * so an ordinary run start still costs exactly the one spread it always did. */
function without<T>(map: Record<string, T>, gone: Set<string>): Record<string, T> {
  if (gone.size === 0) return map;
  const next: Record<string, T> = {};
  for (const key of Object.keys(map)) {
    if (!gone.has(key)) next[key] = map[key];
  }
  return next;
}

export const useAiRunStore = create<AiRunState>((set, get) => ({
  linesByRun: {},
  engineByRun: {},
  aboutByRun: {},
  active: {},
  cancelling: {},

  /**
   * Subscribes to the backend's run events. Idempotent.
   *
   * # This must be called at boot, not only from `start`
   *
   * It used to be reached from exactly one place — `start`, below — which was sound while every
   * run in the app began with a local `start` call. A run kicked off from a paired phone does not:
   * the command is invoked over HTTP and the engine events are the *only* thing this window ever
   * hears about it. With the subscription deferred until the first local run, a desktop that had
   * been open all morning without running anything itself was not listening at all, so a phone
   * could drive an engine against this machine's working copy with nothing on screen to say so.
   *
   * Called from `App`'s boot effect for that reason. Costs two `listen` registrations on a window
   * that may never use them, which is the correct trade against silently missing every remote run.
   */
  init: () => {
    if (subscribed) return;
    // Set before the listeners resolve so a second call in the same tick (React StrictMode
    // mounting effects twice) can't register a duplicate subscription.
    subscribed = true;
    // The batched event and not the per-line `ai:output`: a busy agentic turn prints 20-60 lines a
    // second, and the old subscription paid one IPC callback, one zustand `set` and one full array
    // copy *per line* — sixty renders a second of a list nobody can read at that rate. The backend
    // coalesces on a ~100ms tick (`ai_runs.rs::BATCH_INTERVAL`) and carries the identical lines in
    // the identical order, so what lands in the log is byte-for-byte what the per-line path put
    // there; only the number of renders changed. The tail is safe too: the partial batch is flushed
    // from a `Drop` guard *inside* `scoped_with_trace`, before the command returns and therefore
    // before any caller can emit "this run is done" — cancellation and crashes included.
    void onAiOutputBatch((event: AiOutputBatchEvent) => {
      // Structured agent events become readable lines here rather than in the component, so the
      // stored log is what the user actually saw — and the noise never takes up a slot. Done for
      // the whole batch first so the `set` below is a single, plain append.
      const added: AiRunLine[] = [];
      for (const entry of event.lines) {
        const text = formatAgentLogLine(entry.line);
        if (text === null) continue;
        added.push({ stream: entry.stream, text });
      }
      // A batch of nothing but filtered noise must not re-render every subscriber of this store.
      if (added.length === 0) return;
      set((s) => {
        const previous = s.linesByRun[event.run_id] ?? EMPTY_LINES;
        const next = [...previous, ...added];
        return {
          linesByRun: {
            ...s.linesByRun,
            // `MAX_LINES` applied once for the batch rather than once per line: the tail kept is
            // the same either way, since trimming is idempotent on a growing array.
            [event.run_id]: next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next,
          },
        };
      });
    }).then((off) => {
      offs.push(off);
    });
    // Announced once per run, before its first line: which engine and model are doing the work.
    void onAiEngine((event: AiEngineEvent) => {
      set((s) => {
        const engineByRun = {
          ...s.engineByRun,
          [event.run_id]: { engine: event.engine, model: event.model },
        };
        // A run this window never started.
        //
        // `active` is written by `start`, and `start` is called by whoever invoked the command —
        // which, for a turn kicked off from a paired phone, is nobody here. The engine banner is
        // the first this window hears of it, so it is where the run gets registered; otherwise the
        // status bar would sit empty while a model ran against this machine's working copy, which
        // is exactly the thing that panel exists to prevent.
        //
        // Named as remote rather than left unnamed: `aboutByRun` being absent is a supported state
        // (the panel falls back to "unknown"), but "somebody's phone started this" is the single
        // most useful thing to say about a run you did not start yourself.
        if (s.active[event.run_id]) {
          return { engineByRun };
        }
        return {
          engineByRun,
          active: { ...s.active, [event.run_id]: true },
          aboutByRun: {
            ...s.aboutByRun,
            [event.run_id]: {
              kindKey: "agents.liveKindRemote" as const,
              detail: event.model ? `${event.engine} · ${event.model}` : event.engine,
            },
          },
        };
      });
    }).then((off) => {
      offs.push(off);
    });
    // The counterpart. Harmless for a run this window started — `finish` is idempotent and its own
    // caller is about to call it anyway — and load-bearing for one it did not, which has no
    // promise here to resolve. See `onAiDone`.
    void onAiDone((event) => {
      set((s) => (s.active[event.run_id] ? { active: { ...s.active, [event.run_id]: false } } : s));
    }).then((off) => {
      offs.push(off);
    });
  },

  start: (runId, about) => {
    // Subscribing here (rather than leaving it to whatever renders the log) guarantees the
    // listener is attached before the process can print its first line.
    get().init();
    set((s) => {
      // Old buffers are freed *here* and never in `finish`. Every caller settles the same way —
      // the trace is snapshotted in a `.then()` and `finish` is called from a sibling `.finally()`
      // — so freeing on finish would race the snapshot for the run that just ended. Freeing when
      // the *next* run starts is ordered behind every one of those by construction.
      recentRuns = recentRuns.filter((id) => id !== runId);
      recentRuns.push(runId);
      const gone = new Set<string>();
      for (const id of recentRuns) {
        if (recentRuns.length - gone.size <= MAX_RUNS) break;
        // The run being started is the one id the cap can never reclaim — it is about to be
        // rewritten below anyway, and dropping it from the order would leave it unreclaimable
        // later. Reachable only with more than `MAX_RUNS` turns genuinely in flight at once.
        if (id === runId) continue;
        // A run still in flight keeps its buffer whatever the cap says: it is the one thing this
        // store is on screen for, and `chainStore` reads `active` to decide whether a step's work
        // is still ours to watch. Dropping a settled id from `active` is safe — the reads all treat
        // absent as false, which is what `finish` left there anyway.
        if (!s.active[id]) gone.add(id);
      }
      if (gone.size > 0) recentRuns = recentRuns.filter((id) => !gone.has(id));

      // The engine is dropped along with the lines: routing can have changed since, and a stale
      // name on a fresh run is worse than no name at all. The backend re-announces immediately.
      const { [runId]: _previousEngine, ...engineByRun } = s.engineByRun;
      // Written before the process exists, so the status bar names the run from the frame it
      // starts rather than from whenever the engine gets round to announcing itself.
      const aboutByRun = without(s.aboutByRun, gone);
      return {
        linesByRun: { ...without(s.linesByRun, gone), [runId]: [] },
        engineByRun,
        aboutByRun: about ? { ...aboutByRun, [runId]: about } : aboutByRun,
        active: { ...without(s.active, gone), [runId]: true },
        cancelling: { ...without(s.cancelling, gone), [runId]: false },
      };
    });
  },

  finish: (runId) =>
    set((s) => ({
      active: { ...s.active, [runId]: false },
      cancelling: { ...s.cancelling, [runId]: false },
    })),

  cancel: async (runId) => {
    set((s) => ({ cancelling: { ...s.cancelling, [runId]: true } }));
    // The backend answering `false` just means the run finished on its own in the meantime; the
    // caller's promise is about to resolve with a real reply, so nothing to report here.
    await cancelAiRun(runId).catch(() => false);
  },

  clear: (runId) =>
    set((s) => {
      const { [runId]: _dropped, ...rest } = s.linesByRun;
      return { linesByRun: rest };
    }),

  linesFor: (runId) => get().linesByRun[runId] ?? EMPTY_LINES,
}));

/**
 * The run's log, **copied** out of the store, to keep with the message it produced.
 *
 * Never store what `linesFor` hands back: that array is the store's own, so a transcript holding
 * it pinned the live buffer of every run the session had ever seen — and evicting `linesByRun`
 * would then free precisely nothing. The copy is bounded to what the backend persists, so the
 * trace on screen now and the one read back from `activity_log` tomorrow are the same trace.
 */
export function snapshotTrace(runId: string): AiRunLine[] {
  const lines = useAiRunStore.getState().linesByRun[runId] ?? EMPTY_LINES;
  return lines.length > MAX_TRACE_LINES ? lines.slice(-MAX_TRACE_LINES) : lines.slice();
}

/** Mints an id for a run. Prefixed so a stray id is recognizable in logs. */
export function newRunId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** True when an error came from the user pressing stop rather than from a genuine failure. The
 * marker is produced by the backend (`ai_runs::CANCELLED_MARKER`). */
export const CANCELLED_MARKER = "RUN_CANCELLED::";

export function isCancellation(error: unknown): boolean {
  return String(error).includes(CANCELLED_MARKER);
}
