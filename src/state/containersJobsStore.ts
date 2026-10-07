import { create } from "zustand";
import { closeTerminal } from "../lib/tauri/commands";
import { onTerminalExit, onTerminalOutput } from "../lib/tauri/events";
import { containersOpenSession, type SessionRequest } from "../lib/tauri/containersCommands";
import { useContainersStore } from "./containersStore";
import { disownTerminalBacklog } from "./terminalStore";
import { pushSuccessToast } from "./toastStore";
import type { RuntimeId } from "../types/containers";

/**
 * The Contenedores manager's long jobs — a pull, a build, `compose up`, a project's log — owned here
 * rather than by the page that started them.
 *
 * A job is a terminal session (the engine's own command in a pty, see `containers::session`), and a
 * session used to die with the pane that opened it: a 2 GB pull stopped the moment the user looked
 * at another section, or closed the dock. Here the store opens the session, keeps its output whether
 * or not a pane shows it (the terminal router keeps nothing for a session once its first pane has
 * gone), and a pane mounted later replays it through `TerminalPane`'s `backlog` — numbered, so
 * nothing prints twice — before following it live.
 *
 * What a job does when it ends is data, not a callback: a callback would close over the page that
 * started it, and that page may be long gone by then.
 */

export interface JobOptions {
  /** A log followed until closed (`projectLogs`), not a command that ends by itself. */
  follow?: boolean;
  /** The engine's lists the job changes, read again when it ends however it ended. */
  refresh?: string[];
  /** Said when it ends well. */
  done?: string;
  /** An image a container can be run from once it ends well — the one pulled, the tag built. */
  runImage?: string;
  /** Whatever the page that started it wants to find again — a build's folder and Dockerfile. */
  meta?: Record<string, string>;
}

export interface ContainerJob {
  key: number;
  title: string;
  request: SessionRequest;
  options: JobOptions;
  sessionId: string | null;
  ended: boolean;
  /** The exit code once ended; `null` when there is none (it never started, or was cut). */
  code: number | null;
  /** Why it never started. */
  error: string | null;
  startedAt: number;
}

/** A job that ended, remembered after its panel is closed — what «Construir» lists as recent. */
export interface PastJob {
  kind: SessionRequest["kind"];
  runtime: string;
  meta: Record<string, string>;
  code: number | null;
  at: number;
}

interface JobsState {
  jobs: ContainerJob[];
  /** The job whose output is open, by key. */
  shown: number | null;
  /** The panel folded down to its header. */
  folded: boolean;
  history: PastJob[];
  start: (title: string, request: SessionRequest, options?: JobOptions) => Promise<number>;
  /** Stops a job still running and lets it go. */
  close: (key: number) => void;
  show: (key: number) => void;
  setFolded: (folded: boolean) => void;
}

/** Ended jobs kept in the panel before the oldest go — a running one is never dropped. */
const KEEP_ENDED = 6;
const HISTORY = 20;
/** Per job: several times what xterm's scrollback can show. */
const OUTPUT_LIMIT = 1024 * 1024;

interface Output {
  chunks: Array<{ data: string; seq: number }>;
  bytes: number;
}
const output = new Map<string, Output>();
/**
 * What arrived while a `start` was waiting for its session's id — a command fast enough to print,
 * or even end, inside that round trip. Collected only while one is waiting, adopted by the job whose
 * id it is, and the rest forgotten.
 */
const early = new Map<string, { chunks: Array<{ data: string; seq: number }>; exit?: number | null }>();
let waiting = 0;
let keySeq = 0;
/** Both listeners attached — a session opened before then could print, or end, unheard. */
let listening: Promise<unknown> | null = null;

function keep(id: string, data: string, seq: number): boolean {
  const out = output.get(id);
  if (!out) return false;
  out.chunks.push({ data, seq });
  out.bytes += data.length;
  while (out.bytes > OUTPUT_LIMIT && out.chunks.length > 1) out.bytes -= out.chunks.shift()!.data.length;
  return true;
}

/** What a pane mounted on a job writes first: everything kept, and the number it reaches. */
export function jobBacklog(sessionId: string): { text: string; seq: number } {
  const out = output.get(sessionId);
  if (!out || out.chunks.length === 0) return { text: "", seq: 0 };
  return { text: out.chunks.map((c) => c.data).join(""), seq: out.chunks[out.chunks.length - 1].seq };
}

export const useContainersJobsStore = create<JobsState>((set, get) => {
  const finish = (key: number, code: number | null, error: string | null = null) => {
    const job = get().jobs.find((j) => j.key === key);
    if (!job || job.ended) return;
    set((s) => ({
      jobs: s.jobs.map((j) => (j.key === key ? { ...j, ended: true, code, error } : j)),
      history: job.options.follow
        ? s.history
        : [{ kind: job.request.kind, runtime: job.request.runtime, meta: job.options.meta ?? {}, code, at: Date.now() }, ...s.history].slice(0, HISTORY),
    }));
    const containers = useContainersStore.getState();
    for (const what of job.options.refresh ?? []) void containers.refreshList(job.request.runtime as RuntimeId, what);
    if (code === 0 && job.options.done) pushSuccessToast(job.options.done);
  };

  const listen = () => {
    listening ??= Promise.all([
      onTerminalOutput((e) => {
        const seq = e.seq ?? 0;
        if (keep(e.id, e.data, seq) || waiting === 0) return;
        const held = early.get(e.id) ?? { chunks: [] };
        if (held.chunks.length < 500) held.chunks.push({ data: e.data, seq });
        early.set(e.id, held);
      }),
      onTerminalExit((e) => {
        const job = get().jobs.find((j) => j.sessionId === e.id);
        if (job) finish(job.key, e.code ?? null);
        else if (waiting > 0) early.set(e.id, { ...(early.get(e.id) ?? { chunks: [] }), exit: e.code ?? null });
      }),
    ]);
    return listening;
  };

  /** Lets the oldest ended jobs go once there are too many. */
  const trim = (jobs: ContainerJob[]) => {
    const ended = jobs.filter((j) => j.ended);
    const drop = new Set(ended.slice(0, Math.max(0, ended.length - KEEP_ENDED)).map((j) => j.key));
    for (const job of jobs) if (drop.has(job.key) && job.sessionId) forget(job.sessionId);
    return drop.size ? jobs.filter((j) => !drop.has(j.key)) : jobs;
  };

  const forget = (sessionId: string) => {
    void closeTerminal(sessionId).catch(() => {});
    output.delete(sessionId);
  };

  return {
    jobs: [],
    shown: null,
    folded: false,
    history: [],

    start: async (title, request, options = {}) => {
      const key = ++keySeq;
      const job: ContainerJob = { key, title, request, options, sessionId: null, ended: false, code: null, error: null, startedAt: Date.now() };
      set((s) => ({ jobs: trim([...s.jobs, job]), shown: key, folded: false }));
      waiting++;
      try {
        await listen();
        const id = await containersOpenSession(request);
        // This store keeps the session's history; the router must not hold a second copy for a
        // first pane that may never come.
        disownTerminalBacklog(id);
        output.set(id, { chunks: [], bytes: 0 });
        const held = early.get(id);
        early.delete(id);
        for (const chunk of held?.chunks ?? []) keep(id, chunk.data, chunk.seq);
        if (!get().jobs.some((j) => j.key === key)) {
          // Closed while it was opening: nobody is left to stop what it opened.
          forget(id);
        } else {
          set((s) => ({ jobs: s.jobs.map((j) => (j.key === key ? { ...j, sessionId: id } : j)) }));
          if (held?.exit !== undefined) finish(key, held.exit);
        }
      } catch (error) {
        finish(key, null, String(error));
      } finally {
        waiting--;
        if (waiting === 0) early.clear();
      }
      return key;
    },

    close: (key) => {
      const job = get().jobs.find((j) => j.key === key);
      if (!job) return;
      if (job.sessionId) forget(job.sessionId);
      set((s) => {
        const jobs = s.jobs.filter((j) => j.key !== key);
        return { jobs, shown: s.shown === key ? (jobs.length ? jobs[jobs.length - 1].key : null) : s.shown };
      });
    },

    show: (key) => set({ shown: key, folded: false }),
    setFolded: (folded) => set({ folded }),
  };
});
