import { create } from "zustand";
import { getFileDiff, getStagedDiff, getWorkingDiff, writeTerminal } from "../lib/tauri/commands";
import { useAgentsStore } from "./agentsStore";
import { buildReviewMessage, diffStats, type ReviewComment, type ReviewMessageLabels } from "../lib/agents/reviewNote";
import type { FileDiffInfo } from "../types/domain";

/** The tabs a task's detail pane can open on — see `AgentTaskDetail`. */
export type TaskTab = "chat" | "review" | "race";

/**
 * Reviewing what an agent actually did, inside the task that did it.
 *
 * # Why this is not the Changes view
 *
 * A task that runs in the repository's working copy could already be reviewed there: «Revisar
 * cambios» focuses the repository and switches view. A task in a **worktree of its own** could not
 * be reviewed anywhere — its edits are in a folder no view of the app opens, and the only thing
 * offered for it was "show the folder". That is the hole this fills, and the reason the diff is read
 * from a path rather than from `repoStore`: the path is the worktree when there is one.
 *
 * # Why the comments live here and not on disk
 *
 * A comment is a sentence on its way to the agent — it exists between reading a line and sending
 * the turn, and once sent it is in the transcript, which *is* the record. Persisting it would mean
 * deciding what a comment on a line that no longer exists means after a restart, and the honest
 * answer is "nothing": re-read the diff and say it again. So the review is session state, keyed by
 * task, dropped with the window.
 */

/** How much context the file *list* is read with — `repoStore.LIST_DIFF_CONTEXT_LINES`, kept here
 *  rather than imported so a review needs nothing of the repository views. Whole-file context is
 *  paid once, for the file actually opened, by `selectFile`. */
const LIST_DIFF_CONTEXT_LINES = 3;

/** One changed file of the task's working copy, as the list draws it. */
export interface ReviewFile {
  /** Repo-relative, POSIX separators — what `getFileDiff` takes. */
  path: string;
  /** libgit2's delta word: `modified`, `untracked`, `deleted`… */
  status: string;
  binary: boolean;
  added: number;
  removed: number;
  /** Which side to ask `getFileDiff` for: a file only in the index is `true`. */
  staged: boolean;
}

export interface TaskReview {
  /** The working copy being reviewed: the task's worktree, or its repository. */
  repoPath: string;
  files: ReviewFile[];
  loading: boolean;
  error: string;
  /** The file open in the diff pane, or `null` while the list alone is shown. */
  selected: string | null;
  diff: FileDiffInfo | null;
  diffLoading: boolean;
  comments: ReviewComment[];
  /** The comment about the change as a whole — not anchored to any line. */
  general: string;
}

const EMPTY: TaskReview = {
  repoPath: "",
  files: [],
  loading: false,
  error: "",
  selected: null,
  diff: null,
  diffLoading: false,
  comments: [],
  general: "",
};

interface TaskReviewState {
  byTask: Record<string, TaskReview>;
  /**
   * A task somewhere else asked to open on a particular tab — the race panel's «read the diff», a
   * race row in the list asking for the comparison.
   *
   * A request rather than a call, because the tab a task is open on is the detail pane's own state
   * and belongs there: the alternative was lifting every task's tab into a store so that one button
   * in another component could set it. Consumed once, by the pane that lands on that task.
   */
  openRequest: { taskId: string; tab: TaskTab } | null;
  /** Reads the changed files of `repoPath`. Comments already left are kept: re-reading the diff is
   *  what the user does *while* reviewing, and losing their notes to a refresh would be a bug. */
  load: (taskId: string, repoPath: string) => Promise<void>;
  /** Opens one file's diff at full context, or closes the pane with `null`. */
  selectFile: (taskId: string, path: string | null) => Promise<void>;
  addComment: (taskId: string, comment: Omit<ReviewComment, "id" | "createdAt">) => void;
  removeComment: (taskId: string, commentId: string) => void;
  setGeneral: (taskId: string, text: string) => void;
  clearComments: (taskId: string) => void;
  /**
   * Sends the review as the task's next turn.
   *
   * Returns what `agentsStore.send` returned: `false` when it refused (nothing to say, a turn
   * already running, the repository taken by another task). The comments are cleared **only** on a
   * send that was taken — a refused review that emptied the list would lose the reading it took to
   * write.
   */
  sendReview: (taskId: string, labels: ReviewMessageLabels) => boolean;
  /**
   * The same review, typed into an agent CLI running in a terminal (`sessionId` is the pty's) — for a
   * working copy whose agent is a terminal rather than a chat task. Pasted as one bracketed paste and
   * then Enter, so the CLI takes the whole message as one turn instead of sending its first line.
   * Answers whether it went.
   */
  sendReviewToTerminal: (taskId: string, labels: ReviewMessageLabels, sessionId: string) => Promise<boolean>;
  /** Asks for `taskId` to open on one of its tabs. Pairs with {@link takeOpenRequest}. */
  requestTab: (taskId: string, tab: TaskTab) => void;
  /** The tab asked for, once, for the task the request named; clears it. */
  takeOpenRequest: (taskId: string) => TaskTab | null;
  /** Forgets a task's review — called when the task itself goes. */
  forget: (taskId: string) => void;
}

/** The review of `taskId`, or the empty one. Never `undefined`, so every reader is spared a guard. */
export function reviewOf(state: TaskReviewState, taskId: string): TaskReview {
  return state.byTask[taskId] ?? EMPTY;
}

let commentSeq = 0;

function merge(files: FileDiffInfo[], staged: boolean): ReviewFile[] {
  return files.map((file) => {
    const { added, removed } = diffStats(file.hunks);
    return {
      // A rename reports both sides; the new path is the one that exists to be opened.
      path: file.new_path ?? file.old_path ?? "",
      status: file.status,
      binary: file.binary,
      added,
      removed,
      staged,
    };
  });
}

/** The working tree's files and the index's, as one list. A file in both is shown once, as its
 *  working-tree side — that is the newer of the two and the one a follow-up turn would edit. */
export function mergeSides(working: FileDiffInfo[], stagedFiles: FileDiffInfo[]): ReviewFile[] {
  const rows = merge(working, false);
  const seen = new Set(rows.map((row) => row.path));
  for (const row of merge(stagedFiles, true)) {
    if (!seen.has(row.path) && row.path !== "") rows.push(row);
  }
  return rows.filter((row) => row.path !== "").sort((a, b) => a.path.localeCompare(b.path));
}

function patch(taskId: string, change: Partial<TaskReview>): void {
  useTaskReviewStore.setState((s) => ({
    byTask: { ...s.byTask, [taskId]: { ...(s.byTask[taskId] ?? EMPTY), ...change } },
  }));
}

export const useTaskReviewStore = create<TaskReviewState>((set, get) => ({
  byTask: {},
  openRequest: null,

  load: async (taskId, repoPath) => {
    if (!repoPath) {
      patch(taskId, { repoPath, files: [], loading: false, error: "" });
      return;
    }
    patch(taskId, { repoPath, loading: true, error: "" });
    try {
      // Narrow context on purpose: this is a *list*. The file the user opens is fetched again at
      // full context by `selectFile` — see `LIST_DIFF_CONTEXT_LINES`.
      const [working, staged] = await Promise.all([
        getWorkingDiff(repoPath, LIST_DIFF_CONTEXT_LINES),
        getStagedDiff(repoPath, LIST_DIFF_CONTEXT_LINES),
      ]);
      const files = mergeSides(working, staged);
      const current = reviewOf(get(), taskId);
      patch(taskId, {
        files,
        loading: false,
        // A file that stopped being changed — committed, reverted — must not stay open showing a
        // diff that no longer exists.
        ...(current.selected && !files.some((file) => file.path === current.selected)
          ? { selected: null, diff: null }
          : {}),
      });
    } catch (error) {
      patch(taskId, { loading: false, files: [], error: String(error) });
    }
  },

  selectFile: async (taskId, path) => {
    if (path === null) {
      patch(taskId, { selected: null, diff: null, diffLoading: false });
      return;
    }
    const review = reviewOf(get(), taskId);
    const row = review.files.find((file) => file.path === path);
    patch(taskId, { selected: path, diff: null, diffLoading: true });
    try {
      const diff = await getFileDiff(review.repoPath, path, row?.staged ?? false);
      // Another file may have been clicked while this one was in flight; the last click wins.
      if (reviewOf(get(), taskId).selected !== path) return;
      patch(taskId, { diff, diffLoading: false });
    } catch (error) {
      if (reviewOf(get(), taskId).selected !== path) return;
      patch(taskId, { diff: null, diffLoading: false, error: String(error) });
    }
  },

  addComment: (taskId, comment) => {
    commentSeq += 1;
    const row: ReviewComment = { ...comment, id: `rc${commentSeq}`, createdAt: Date.now() + commentSeq };
    patch(taskId, { comments: [...reviewOf(get(), taskId).comments, row] });
  },

  removeComment: (taskId, commentId) => {
    patch(taskId, { comments: reviewOf(get(), taskId).comments.filter((comment) => comment.id !== commentId) });
  },

  setGeneral: (taskId, text) => patch(taskId, { general: text }),

  clearComments: (taskId) => patch(taskId, { comments: [], general: "" }),

  sendReview: (taskId, labels) => {
    const review = reviewOf(get(), taskId);
    const message = buildReviewMessage(review.comments, review.general, labels);
    if (!message) return false;
    if (!useAgentsStore.getState().send(taskId, message)) return false;
    get().clearComments(taskId);
    return true;
  },

  sendReviewToTerminal: async (taskId, labels, sessionId) => {
    const review = reviewOf(get(), taskId);
    const message = buildReviewMessage(review.comments, review.general, labels);
    if (!message) return false;
    try {
      // Bracketed paste: every agent TUI the rail knows turns it on, and without it each newline of
      // the review would be an Enter — the first line sent alone, the rest typed into the next turn.
      await writeTerminal(sessionId, `\x1b[200~${message}\x1b[201~`);
      // Enter on its own, a beat later, so it is not read as the last character of the paste.
      await new Promise((resolve) => setTimeout(resolve, 120));
      await writeTerminal(sessionId, "\r");
    } catch {
      return false;
    }
    get().clearComments(taskId);
    return true;
  },

  requestTab: (taskId, tab) => set({ openRequest: { taskId, tab } }),

  takeOpenRequest: (taskId) => {
    const request = get().openRequest;
    if (request?.taskId !== taskId) return null;
    set({ openRequest: null });
    return request.tab;
  },

  forget: (taskId) =>
    set((s) => {
      if (!(taskId in s.byTask)) return s;
      const byTask = { ...s.byTask };
      delete byTask[taskId];
      return { byTask };
    }),
}));

/**
 * A review belongs to its task and goes with it.
 *
 * Watched here rather than called from `agentsStore.remove`, because a task leaves the list in more
 * than one way — deleted, archived with its folder, dropped on a workspace switch — and because the
 * dependency only points one way: this store knows about the agents, and the agents know nothing
 * about reviews. Only the ids are compared, and only when the list has actually shrunk.
 */
useAgentsStore.subscribe((state, previous) => {
  if (state.tasks === previous.tasks || state.tasks.length >= previous.tasks.length) return;
  const open = Object.keys(useTaskReviewStore.getState().byTask);
  if (open.length === 0) return;
  const alive = new Set(state.tasks.map((task) => task.id));
  for (const taskId of open) {
    if (!alive.has(taskId)) useTaskReviewStore.getState().forget(taskId);
  }
});
