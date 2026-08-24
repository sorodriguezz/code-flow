/**
 * The mobile client's state.
 *
 * One store, not the sixty-odd the desktop has, and the difference is not laziness — it is that
 * this client holds far less. The desktop's stores each own a view with its own selection, its own
 * drafts and its own undo; here there are five screens and one selection between them.
 *
 * Everything is loaded from the desktop and nothing is authoritative here. When in doubt the client
 * refetches rather than reconciling: the round trip is a few milliseconds over a home network, and
 * a phone showing a stale gate is worse than a phone showing a spinner.
 *
 * # What is deliberately *not* here
 *
 * Where the user is. That used to be split between this file (`openChain`) and five booleans in
 * five screens, which is how the Agents tab ended up with no way back to its own list: `openChain`
 * survived every tab switch, so re-entering the tab re-entered the chain, forever. Navigation lives
 * in `nav.ts` now, and this file holds only data.
 */

import { create } from "zustand";
import { NotAllowed, rpc, Unpaired } from "./transport";
import { t } from "./i18n";
import { toastError, toastSuccess } from "./toast";
import { resetDepth } from "./nav";

/**
 * The outcome of one read, with the two failures that must not be treated alike kept apart.
 *
 * Every read in this file used to end in `.catch(() => [])`, and the cost of that was not a lost
 * error message — it was the client answering questions it had no answer to. A `get_status` that
 * failed became `status: null`, which `RepoScreen` draws as *"El árbol de trabajo está limpio"*;
 * a `list_pull_requests` that failed became *"No hay pull requests"*. A phone that had just been
 * revoked therefore showed a clean, calm, entirely fictional picture of the repository.
 *
 * So a caller is handed the distinction instead: `unpaired` means stop and go re-pair, anything
 * else means keep what is on screen and say that it is stale. Deliberately **not** a rethrow inside
 * `Promise.all` — every caller here invokes these as bare `void`, so a rejecting refresh would only
 * convert a silent desync into an unhandled rejection.
 */
type Read<T> = { ok: true; value: T } | { ok: false; unpaired: boolean; error: string };

async function read<T>(action: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await action() };
  } catch (e) {
    if (e instanceof Unpaired) return { ok: false, unpaired: true, error: "unpaired" };
    return { ok: false, unpaired: false, error: String(e) };
  }
}

/**
 * Whether any of a batch of reads failed because this device is no longer paired.
 *
 * One unpaired answer settles the whole batch: the token is gone, so the others either already
 * failed the same way or are about to.
 */
const anyUnpaired = (...reads: Read<unknown>[]) => reads.some((r) => !r.ok && r.unpaired);

/**
 * Asks the desktop to keep a native filesystem watcher on the repository this client is showing.
 *
 * # Why the phone has to ask at all
 *
 * `repo:fs-changed` is what makes an edit made anywhere appear without pulling to refresh, and it
 * comes from a watcher the *desktop window* starts on the project **it** has open. A phone on any
 * other project was therefore reading a repository nobody was watching: an agent could rewrite the
 * whole tree and the Repo tab would sit on a diff from ten minutes ago until something else
 * happened to fire.
 *
 * Fire-and-forget, and deliberately silent on failure. The watcher is an optimisation on top of
 * every explicit refresh this client already does — losing it costs liveness, not correctness — and
 * a desktop older than this client answers `not_allowed`, which must not surface as an error banner
 * over a working screen.
 */
function watchProject(projectId: string | null) {
  if (!projectId) return;
  void rpc("watch_project", { projectId }).catch(() => undefined);
}

/**
 * The pty sessions this device has open, by project.
 *
 * # Why this outlives the page
 *
 * A shell opened from a phone is a real process on the desktop, and this client is the only thing
 * that knows its id. Everything about a phone loses that knowledge constantly: the browser evicts a
 * backgrounded tab, the user reloads, the page is rebuilt under them after a desktop update. Held
 * only in memory, every one of those stranded a live shell — the desktop had no tab for it, the phone
 * had forgotten it existed, and it ran until the app was quit.
 *
 * Written through to `localStorage` so coming back **reattaches** to the shell that is still running
 * rather than opening a second one beside it. Verified against `list_terminals` before it is used:
 * the id is a claim about another process's state, and the process may well have exited.
 */
const TERMINALS_KEY = "codeflow.remote.terminals";

/**
 * The workspace and project this phone was last looking at.
 *
 * # Why the phone remembers a scope the desktop already has an opinion about
 *
 * `resync` goes out of its way to keep the user where they were — its own comment says that
 * "snapping back to the first project on every reconnect would move the screen under somebody every
 * time their phone woke up" — and `bootstrap` then did exactly that, because it takes the desktop's
 * current workspace and project unconditionally. `bootstrap` is what runs after every reload,
 * *including* the forced one in `reloadIfStale`, which fires precisely when a phone wakes up. So
 * the case `resync` was written to prevent happened anyway, by the other route.
 *
 * The desktop's answer is still the fallback, and still the right one for a genuinely new device.
 */
const SCOPE_KEY = "codeflow.remote.scope";

function storedTerminals(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TERMINALS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    // Anything but an object of strings is a value this client did not write — an older format, or
    // a key somebody else's script put there. Discarded rather than trusted into the store.
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
  } catch {
    // Safari in private browsing throws on `localStorage`, and malformed JSON throws here too. Both
    // mean the same thing: no session to adopt, open a new one.
    return {};
  }
}

function storedScope(): { workspaceId: string | null; projectId: string | null } {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    if (!raw) return { workspaceId: null, projectId: null };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : null,
    };
  } catch {
    return { workspaceId: null, projectId: null };
  }
}

function rememberScope(workspaceId: string | null, projectId: string | null) {
  try {
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ workspaceId, projectId }));
  } catch {
    /* private browsing; the scope is simply not remembered across reloads */
  }
}

import type {
  AgentChain,
  CommitInfo,
  Project,
  RepoStatusInfo,
  Workspace,
} from "../types/domain";

/**
 * The groups a mutating command can be in flight for.
 *
 * A closed set rather than free-form strings, because the whole value of the split is that two
 * buttons which must not block each other are provably in different groups — and a typo'd key would
 * silently create a third group that never blocks anything at all.
 *
 * The grouping is "actions that contend for the same thing", not "actions on the same screen":
 * a checkout and a commit both write the working tree and genuinely should wait for each other, so
 * the branch screen shares `repo`. `review` and `chat` are apart from everything because they are
 * the two calls that hold the connection open for as long as an engine takes to answer.
 */
export type BusyKey = "repo" | "analyze" | "chains" | "review" | "chat";

/** What one live run is printing, as the batches arrive. */
export interface RunLog {
  lines: string[];
  engine?: string;
  /** Set when `ai:done` lands. The card stays — its output is still worth reading — but stops
   *  claiming to be live and stops offering to cancel something that already ended. */
  finished?: boolean;
  /** When this client first heard of the run, so the card can say how long ago that was. Not the
   *  run's real start: a phone that joined mid-run knows only when it joined, and pretending
   *  otherwise would put a wrong number next to a right one. */
  firstSeen: number;
}

/**
 * How many lines of a run's output are kept per run.
 *
 * A quarter of the desktop's 400, on purpose: this renders into a phone-width column where each
 * line wraps to two or three, and nobody scrolls back through a transcript on a phone — they read
 * the tail to see whether it is still moving. The full record is in the desktop's own log either
 * way.
 */
const MAX_LINES = 100;

/** What `remote_bootstrap` answers — the cold start, and the reconnect. See the dispatch arm. */
interface Bootstrap {
  workspaces: Workspace[];
  workspaceId: string | null;
  projects: Project[];
  /**
   * Which project the *desktop* is on, when it is one of the above.
   *
   * The phone used to open on `projects[0]`, which on any machine with more than one repository was
   * a coin toss — you unlock your phone to check on the work you left running and land on a
   * different repo's clean tree. `null` when the workspace has no projects; never invented.
   */
  projectId: string | null;
  chains: AgentChain[];
  allowTerminal: boolean;
}

interface MobileState {
  ready: boolean;
  unpaired: boolean;
  connected: boolean;
  /**
   * Whether the desktop has granted this device a shell.
   *
   * **Told, not discovered.** `remote_bootstrap` carries it. This used to be probed by calling the
   * cheapest terminal command there was and seeing whether it came back refused — which cost this
   * feature its pairing, because a refusal and a dead token were the same 401 and the client
   * answered that by deleting its token. The probe is gone; see `NotAllowed` in `transport.ts`.
   */
  terminalAllowed: boolean;

  workspaces: Workspace[];
  workspaceId: string | null;
  projects: Project[];
  projectId: string | null;

  status: RepoStatusInfo | null;
  /**
   * Whether `status` is an answer yet.
   *
   * `status: null` used to mean three different things — not asked yet, project switched, the read
   * failed — and `RepoScreen` drew all three as a clean working tree. So every cold start painted
   * *"El árbol de trabajo está limpio"* over a repository it had not looked at, and a failure was
   * indistinguishable from good news. This is the field that separates them.
   */
  repoState: "loading" | "ready" | "error";
  /**
   * The commits that exist here and not upstream — the rows, not a count.
   *
   * It used to be collapsed to `.length` on arrival, which threw away the only thing that made the
   * number checkable: *which* commits they are. The history list marks them, so "3 sin enviar" is
   * three rows you can point at rather than a number you have to take on faith.
   */
  unpushed: CommitInfo[];
  /** The last 30 commits. */
  commits: CommitInfo[];

  chains: AgentChain[];

  logs: Record<string, RunLog>;

  /** The pty session open for each project, by project id. See [`TERMINALS_KEY`]. */
  terminals: Record<string, string>;

  /**
   * Which groups of actions have a command in flight, by [`BusyKey`].
   *
   * # Why this is not one flag any more
   *
   * It was, and the flag was held for the whole lifetime of the fetch — which is correct for a
   * commit and catastrophic for the two commands that run an engine. `review_pull_request` and
   * `send_chat_message` are awaited *inline* in the axum handler, so a review started from this
   * phone holds the flag for as long as the model takes: minutes in which committing, pushing,
   * pulling, staging, answering a chain gate and every PR action were all disabled, on a screen
   * showing no reason why. One long action must not be able to freeze the rest of the client.
   */
  busy: Record<BusyKey, boolean>;
  /**
   * The last *read* failure, for the screens that draw it inline beside a retry.
   *
   * Action failures do not come here any more — they go to a toast, which appears next to the thumb
   * that caused them and dismisses itself. This field is only for "the screen could not be filled
   * in", which is a state of the screen rather than an event.
   */
  error: string | null;

  bootstrap: () => Promise<void>;
  resync: () => Promise<void>;
  setWorkspace: (id: string) => Promise<void>;
  setProject: (id: string) => Promise<void>;
  refreshRepo: () => Promise<void>;
  refreshChains: () => Promise<void>;
  /** Everything the current scope can show, for pull-to-refresh. */
  refreshAll: () => Promise<void>;
  /**
   * Runs one mutating command under `key`'s busy flag.
   *
   * `success` is the sentence to show when it lands. Optional only because a handful of callers
   * report their own outcome in a richer way; anything that writes and says nothing is a bug.
   */
  run: <T>(action: () => Promise<T>, key: BusyKey, success?: string) => Promise<T | null>;
  appendLog: (runId: string, lines: string[]) => void;
  setEngine: (runId: string, engine: string) => void;
  markRunFinished: (runId: string) => void;
  /** Drops one run's card. The run itself is untouched — this is the *card*. */
  dismissRun: (runId: string) => void;
  /** Drops every card whose run has ended. */
  clearFinishedRuns: () => void;
  setError: (error: string | null) => void;
  setConnected: (connected: boolean) => void;
  /** Records — or, with `null`, forgets — the shell open for one project. */
  rememberTerminal: (projectId: string, sessionId: string | null) => void;
}

export const useMobileStore = create<MobileState>((set, get) => ({
  ready: false,
  unpaired: false,
  connected: false,
  terminalAllowed: false,

  workspaces: [],
  workspaceId: null,
  projects: [],
  projectId: null,

  status: null,
  repoState: "loading",
  unpushed: [],
  commits: [],

  chains: [],

  logs: {},
  terminals: storedTerminals(),

  busy: { repo: false, analyze: false, chains: false, review: false, chat: false },
  error: null,

  /** The cold-start call. One round trip for what would otherwise be four — see `remote_bootstrap`
   *  in the dispatch table for why that matters on a phone. */
  bootstrap: async () => {
    try {
      const remembered = storedScope();
      // The remembered workspace is sent *with the request*, so the desktop answers with that
      // workspace's projects rather than with its own and having to be corrected afterwards.
      const data = await rpc<Bootstrap>("remote_bootstrap", {
        workspaceId: remembered.workspaceId,
      });
      // The phone's own last choice wins when it still exists, and the desktop's answer is the
      // fallback. `??` and not `||` on the desktop's project: an older desktop sends no field at
      // all, and that is the case the fallback is for.
      const workspaceId = data.workspaces.some((w) => w.id === remembered.workspaceId)
        ? remembered.workspaceId
        : data.workspaceId;
      const projectId = data.projects.some((p) => p.id === remembered.projectId)
        ? remembered.projectId
        : (data.projectId ?? data.projects[0]?.id ?? null);
      set({
        ready: true,
        unpaired: false,
        error: null,
        workspaces: data.workspaces,
        workspaceId,
        projects: data.projects,
        chains: data.chains,
        projectId,
        // One field of one answer, where there used to be a second round trip that could unpair the
        // device. `?? false` because a desktop older than this client will not send it, and no
        // answer must mean no shell.
        terminalAllowed: data.allowTerminal ?? false,
      });
      rememberScope(workspaceId, projectId);
      if (projectId) {
        watchProject(projectId);
        void get().refreshRepo();
      }
    } catch (e) {
      if (e instanceof Unpaired) set({ unpaired: true, ready: true });
      else set({ ready: true, error: String(e) });
    }
  },

  /**
   * Everything this client believes, re-read after a gap in the stream.
   *
   * # Why this is not just `refreshRepo` twice
   *
   * The socket is the only thing keeping this client in step, and while it was down the desktop
   * went on emitting into nothing. Those frames are not queued anywhere — they were broadcast to
   * whoever was listening, and nobody was. So there are four different kinds of staleness to
   * settle, and each one had a symptom:
   *
   * * the working tree and the chains moved (the ordinary case, and the reason `state:resync`
   *   already existed);
   * * the desktop's *shape* moved — a project added, a workspace renamed, and above all
   *   `allowTerminal` flipped, which is pushed and never polled, so a grant made while the phone
   *   was asleep would not appear until the app was reopened;
   * * a run ended. `ai:done` closes a run card, and a card whose `ai:done` was dropped with the
   *   socket spins forever over a stop button wired to a run that no longer exists. Nothing else
   *   in this client would ever settle it.
   *
   * `remote_bootstrap` covers the first two in one round trip, which is why it is reused here
   * rather than a second probe — and reused with the *current* workspace id, or the desktop's
   * default would silently drag the phone back to a workspace the user had navigated away from.
   */
  resync: async () => {
    const workspaceId = get().workspaceId;
    const info = await read(() => rpc<Bootstrap>("remote_bootstrap", { workspaceId }));
    if (!info.ok) {
      if (info.unpaired) set({ unpaired: true });
      else set({ error: info.error });
      // The repo read below would fail the same way. Coming back with nothing changed and the
      // error on screen is the honest outcome; the socket's own backoff will try again.
      return;
    }
    // Another switch may have happened while this was in flight — the same guard every load here
    // needs, and the reason a resync cannot simply overwrite the selection.
    if (get().workspaceId !== workspaceId) return;
    const data = info.value;
    const projectId = get().projectId;
    // The project the user was looking at, kept unless it is genuinely gone from the desktop.
    // Snapping back to the first project on every reconnect would move the screen under somebody
    // every time their phone woke up.
    const nextProject = data.projects.some((p) => p.id === projectId)
      ? projectId
      : (data.projectId ?? data.projects[0]?.id ?? null);
    const moved = nextProject !== projectId;
    set({
      workspaces: data.workspaces,
      workspaceId: data.workspaceId,
      projects: data.projects,
      chains: data.chains,
      terminalAllowed: data.allowTerminal ?? false,
      projectId: nextProject,
      error: null,
      // The same clearing `setProject` does, and for the same reason: `repoPath` resolves from the
      // *new* project the moment this lands, while `status` still holds the old one's rows — so for
      // the round trip until `refreshRepo` answers, the file list on screen belonged to repository A
      // and its checkboxes wrote to repository B.
      ...(moved ? { status: null, commits: [], unpushed: [], repoState: "loading" as const } : {}),
    });
    // The project moved under the user while they were away, so anything open that named the old
    // one is about something that is no longer on screen.
    if (moved) resetDepth();
    rememberScope(data.workspaceId, nextProject);
    // Re-claimed, because the socket that closed is what released it: the desktop drops a device's
    // watchers when its last connection goes (see `DeviceConnection`), which is exactly the gap
    // this resync exists to close.
    watchProject(nextProject);
    void get().refreshRepo();

    const active = await read(() => rpc<string[]>("list_active_runs"));
    if (!active.ok) {
      // Left alone rather than guessed at. Marking runs finished because the *question* failed
      // would close cards for runs that are still printing.
      if (active.unpaired) set({ unpaired: true });
      return;
    }
    const live = new Set(active.value);
    set((s) => {
      const stale = Object.keys(s.logs).filter((id) => !s.logs[id].finished && !live.has(id));
      if (stale.length === 0) return s;
      const logs = { ...s.logs };
      for (const id of stale) logs[id] = { ...logs[id], finished: true };
      return { logs };
    });
  },

  /**
   * Moves to another workspace.
   *
   * # Why this is one call and not two
   *
   * It used to be `list_projects` and `list_agent_chains` in parallel, and then `projects[0]?.id` —
   * two round trips over home wifi to land on *whichever repository sorted first*, which is exactly
   * the coin toss `remote_bootstrap` was added to end for the cold start. That command already
   * answers the projects, the chains, the desktop's own project for the workspace and the terminal
   * grant, in one request. Using it here makes the switch cost what the cold start costs and land
   * where the desktop is.
   */
  setWorkspace: async (id) => {
    // Anything open is about the workspace being left. Popped before the read, so the screen the
    // user lands on is the new workspace's list rather than the old one's chain.
    resetDepth();
    // What to put back if the read fails. Clearing the scope before asking is what makes the switch
    // feel immediate; leaving it cleared afterwards is what made one dropped request unrecoverable —
    // `projectId` stayed null, so every screen drew "Elige un proyecto arriba" and the error had
    // nowhere to appear, on a picker whose only other entry was the workspace that had just failed.
    const previous = {
      workspaceId: get().workspaceId,
      projects: get().projects,
      projectId: get().projectId,
      status: get().status,
      commits: get().commits,
      unpushed: get().unpushed,
      chains: get().chains,
    };
    set({
      workspaceId: id,
      projects: [],
      projectId: null,
      status: null,
      commits: [],
      // Cleared with the rest, as `setProject` already did. Left behind, it is the previous
      // repository's answer to a question about the new one: the Repo tab draws its unpushed rows
      // from this, so switching workspaces showed "3 sin enviar" belonging to a project that is no
      // longer selected, until `refreshRepo` resolved.
      unpushed: [],
      chains: [],
      repoState: "loading",
      error: null,
    });
    const info = await read(() => rpc<Bootstrap>("remote_bootstrap", { workspaceId: id }));
    // The guard every async load here needs: the user may have switched again while this was in
    // flight, and writing the old workspace's rows over the new ones is the bug it prevents.
    if (get().workspaceId !== id) return;
    if (!info.ok) {
      if (info.unpaired) {
        set({ unpaired: true });
        return;
      }
      // Back to the workspace that was working, with the reason said out loud. An empty project list
      // drawn from a failed read is a workspace that looks deleted.
      set({ ...previous, repoState: "ready", error: null });
      toastError(t("error.actionFailed"), info.error);
      return;
    }
    const data = info.value;
    const projectId = data.projectId ?? data.projects[0]?.id ?? null;
    set({
      workspaces: data.workspaces,
      projects: data.projects,
      chains: data.chains,
      terminalAllowed: data.allowTerminal ?? false,
      projectId,
      repoState: projectId ? "loading" : "ready",
      error: null,
    });
    rememberScope(id, projectId);
    if (projectId) {
      watchProject(projectId);
      void get().refreshRepo();
    }
  },

  setProject: async (id) => {
    resetDepth();
    set({ projectId: id, status: null, commits: [], unpushed: [], repoState: "loading" });
    rememberScope(get().workspaceId, id);
    // Before the read, not after: the watcher is what keeps this project live from here on, and the
    // desktop releases whatever this device was holding as part of taking the new claim.
    watchProject(id);
    await get().refreshRepo();
  },

  refreshRepo: async () => {
    const { projectId, projects } = get();
    const repoPath = projects.find((p) => p.id === projectId)?.local_path;
    if (!repoPath) {
      set({ repoState: "ready" });
      return;
    }
    const [status, commits, unpushed] = await Promise.all([
      read(() => rpc<RepoStatusInfo>("get_status", { repoPath })),
      read(() => rpc<CommitInfo[]>("list_commits", { repoPath, allRefs: false, limit: 30 })),
      read(() => rpc<CommitInfo[]>("list_unpushed_commits", { repoPath })),
    ]);
    if (get().projectId !== projectId) return;
    if (anyUnpaired(status, commits, unpushed)) {
      set({ unpaired: true });
      return;
    }
    // `get_status` is the one that decides what the Repo tab claims, so its failure is the one that
    // must never be drawn as an answer. The other two degrade quietly: a missing commit list is a
    // shorter screen, not a wrong one.
    if (!status.ok) {
      set({ repoState: "error", error: status.error });
      return;
    }
    set({
      status: status.value,
      repoState: "ready",
      error: null,
      commits: commits.ok ? commits.value : get().commits,
      unpushed: unpushed.ok ? unpushed.value : get().unpushed,
    });
  },

  refreshChains: async () => {
    const id = get().workspaceId;
    if (!id) return;
    const chains = await read(() => rpc<AgentChain[]>("list_agent_chains", { workspaceId: id }));
    if (get().workspaceId !== id) return;
    if (!chains.ok) {
      if (chains.unpaired) set({ unpaired: true });
      // Keeping the last known list rather than blanking it: the gate badge on the tab bar is the
      // number this whole client exists to surface, and zeroing it on a dropped request would say
      // "nothing is waiting for you" — the one lie that matters most here.
      else set({ error: chains.error });
      return;
    }
    set({ chains: chains.value, error: null });
  },

  refreshAll: async () => {
    await Promise.all([get().refreshRepo(), get().refreshChains()]);
  },

  /**
   * Runs one mutating command under `key`'s busy flag.
   *
   * Nothing here refetches on success, and that is on purpose: every mutating command makes the
   * desktop emit — `state:invalidate` for a chain, `repo:fs-changed` for a commit — and that event
   * comes straight back down this client's own WebSocket. Refetching here as well would be the
   * same read twice for every action.
   *
   * The guard still refuses a second action *within a key*, and that has to stay: a cancel routed
   * through here while a review holds `review` would run its own `finally` and clear the flag the
   * review is still holding. Anything that must work *during* a long command belongs outside this
   * helper entirely — see the stop button in `RunsScreen`.
   */
  run: async (action, key, success) => {
    if (get().busy[key]) return null;
    set((s) => ({ busy: { ...s.busy, [key]: true } }));
    try {
      const value = await action();
      if (success) toastSuccess(success);
      return value;
    } catch (e) {
      if (e instanceof Unpaired) {
        set({ unpaired: true });
      } else if (e instanceof NotAllowed) {
        // `NotAllowed`'s message is the wire token `not_allowed` — a value, not a sentence. It
        // reaches a user only when this client is newer than the desktop and names a command the
        // allowlist has not grown yet, which is a real thing to say and worth saying in words.
        toastError(t("error.notAllowed"));
      } else {
        // `e.message`, not `String(e)`: the transport throws `new Error(body.error)`, and the string
        // form prefixes it with `Error: ` — a piece of JavaScript vocabulary in front of a sentence
        // the backend wrote for the user to read.
        toastError(t("error.actionFailed"), e instanceof Error ? e.message : String(e));
      }
      return null;
    } finally {
      set((s) => ({ busy: { ...s.busy, [key]: false } }));
    }
  },

  appendLog: (runId, lines) =>
    set((s) => {
      const existing = s.logs[runId];
      const merged = [...(existing?.lines ?? []), ...lines];
      return {
        logs: {
          ...s.logs,
          [runId]: {
            ...existing,
            // The first frame this client saw for the run, kept for the life of the card. A run this
            // phone joined halfway through cannot know when it really started, and `?? Date.now()`
            // is the honest version of that: "since you have been watching".
            firstSeen: existing?.firstSeen ?? Date.now(),
            lines: merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged,
          },
        },
      };
    }),

  setEngine: (runId, engine) =>
    set((s) => {
      const existing = s.logs[runId];
      return {
        logs: {
          ...s.logs,
          [runId]: {
            ...existing,
            firstSeen: existing?.firstSeen ?? Date.now(),
            lines: existing?.lines ?? [],
            engine,
          },
        },
      };
    }),

  markRunFinished: (runId) =>
    set((s) =>
      s.logs[runId]
        ? { logs: { ...s.logs, [runId]: { ...s.logs[runId], finished: true } } }
        : // A `ai:done` for a run this client never saw start — it connected mid-run, or the run
          // produced no output at all. Nothing to mark, and inventing an empty finished card would
          // be showing the user a run they cannot learn anything about.
          s,
    ),

  dismissRun: (runId) =>
    set((s) => {
      const logs = { ...s.logs };
      delete logs[runId];
      return { logs };
    }),

  clearFinishedRuns: () =>
    set((s) => ({
      logs: Object.fromEntries(Object.entries(s.logs).filter(([, log]) => !log.finished)),
    })),

  setError: (error) => set({ error }),

  setConnected: (connected) => set({ connected }),

  rememberTerminal: (projectId, sessionId) =>
    set((s) => {
      const terminals = { ...s.terminals };
      if (sessionId) terminals[projectId] = sessionId;
      else delete terminals[projectId];
      try {
        localStorage.setItem(TERMINALS_KEY, JSON.stringify(terminals));
      } catch {
        // Private browsing. The adoption then only works for as long as this page is alive, which
        // is still most of what it is for — a project switch and back does not lose the shell.
      }
      return { terminals };
    }),
}));

/**
 * Whether the given group has an action in flight.
 *
 * A hook rather than `store.busy[key]` at each call site so that a component subscribes to *one
 * boolean*: zustand re-renders every subscriber whose selected value changed, and selecting the map
 * would re-render the commit button every time a review started or ended.
 */
export const useBusy = (key: BusyKey): boolean => useMobileStore((s) => s.busy[key]);

/**
 * The path of the repository currently in scope, or `null`.
 *
 * Every repository screen needs it and every one of them used to compute it inline from `projects`
 * and `projectId` — which meant subscribing to the whole project list to read one string.
 */
export const useRepoPath = (): string | null =>
  useMobileStore((s) => s.projects.find((p) => p.id === s.projectId)?.local_path ?? null);
