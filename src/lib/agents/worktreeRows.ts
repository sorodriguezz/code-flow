/**
 * The «Worktrees» view of the agent console, as data: every working copy of the workspace's
 * repositories, the task working in each one, and the state that row should wear.
 *
 * # Why worktrees and not tasks
 *
 * The task list answers "what have I asked for". The question asked while several agents run at
 * once is a different one — *where* is each of them working and which needs me now — and its unit
 * is the folder: one agent per working copy is the rule the app already enforces, so a list of
 * working copies is a list of agents with nothing hidden and nothing counted twice.
 *
 * # What makes a row
 *
 * - A task with a worktree of its own is a row at that worktree.
 * - A task that runs in the repository's own working copy is a row at the main checkout.
 * - A linked worktree no task owns — made by hand, or left behind by a deleted task — is a row too:
 *   it is still a place an agent can be started, which is what the view is for.
 * - The main checkout is always present, even with nothing in it, so every repository has a place
 *   to start from.
 *
 * Archived tasks are left out: archiving is the user saying "not here any more".
 *
 * Pure, so the grouping and the order — which decide whether a glance at the rail is honest — are
 * pinned without a repository on disk.
 */

import type { AgentTask, TerminalAgent } from "../../types/domain";
import { raceIdOf } from "./race";
import { isWithin, pathKey, samePath } from "./terminalTask";

/** A linked worktree as `list_worktrees` reports it — only the fields this module reads. */
export interface WorktreeListing {
  path: string;
  branch: string | null;
  is_main: boolean;
  prunable: boolean;
}

/** A repository of the workspace — only the fields this module reads. */
export interface RepoRef {
  id: string;
  name: string;
  local_path: string;
  /** The project's colour, for the square on a card's repository chip. */
  color?: string;
}

export interface WorktreeRow {
  /** Stable across reloads: `task:<id>` for a task's row, `path:<path>` for one no task owns. */
  key: string;
  projectId: string;
  /** The working copy the row stands for. */
  path: string;
  /** The checked-out branch, or `""` when nothing says (a detached head, a listing not read yet). */
  branch: string;
  /** The repository's own working copy rather than a linked worktree. */
  isMain: boolean;
  task: AgentTask | null;
}

/** One line of a repository's block: a row, or a race with its runners under it. */
export type RepoItem = { kind: "row"; row: WorktreeRow } | { kind: "race"; raceId: string; rows: WorktreeRow[] };

export interface RepoBlock {
  repo: RepoRef;
  items: RepoItem[];
  /** Every row of the block in drawing order, races flattened — what a count or a keyboard walk wants. */
  rows: WorktreeRow[];
}

/** Newest first, and by id for the pair created in the same millisecond, so rows never swap. */
function byCreation(a: AgentTask, b: AgentTask): number {
  if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
  return a.id.localeCompare(b.id);
}

export function buildRepoBlocks(
  repos: readonly RepoRef[],
  listings: Readonly<Record<string, readonly WorktreeListing[] | undefined>>,
  tasks: readonly AgentTask[],
): RepoBlock[] {
  const live = tasks.filter((task) => !task.archived);
  return repos.map((repo) => {
    const listing = listings[repo.id] ?? [];
    const mainBranch = listing.find((entry) => entry.is_main)?.branch ?? "";
    const own = live.filter((task) => task.project_id === repo.id).sort(byCreation);

    const rows: WorktreeRow[] = [];
    const inMain = own.filter((task) => !(task.worktree_path ?? "").trim());
    const inWorktree = own.filter((task) => (task.worktree_path ?? "").trim());

    for (const task of inWorktree) {
      const path = task.worktree_path ?? "";
      const listed = listing.find((entry) => samePath(entry.path, path));
      rows.push({
        key: `task:${task.id}`,
        projectId: repo.id,
        path,
        branch: task.worktree_branch || listed?.branch || "",
        isMain: false,
        task,
      });
    }
    for (const task of inMain) {
      rows.push({ key: `task:${task.id}`, projectId: repo.id, path: repo.local_path, branch: mainBranch, isMain: true, task });
    }
    // Worktrees nobody's task owns, in the order git lists them. A prunable one is a folder that is
    // gone — nothing can be started there, so it is the Git view's to clean up, not a row here.
    for (const entry of listing) {
      if (entry.is_main || entry.prunable) continue;
      if (inWorktree.some((task) => samePath(task.worktree_path ?? "", entry.path))) continue;
      rows.push({ key: `path:${entry.path}`, projectId: repo.id, path: entry.path, branch: entry.branch ?? "", isMain: false, task: null });
    }
    // The main checkout with nothing in it, last: a place to start rather than work in progress.
    if (inMain.length === 0 && repo.local_path) {
      rows.push({ key: `path:${repo.local_path}`, projectId: repo.id, path: repo.local_path, branch: mainBranch, isMain: true, task: null });
    }

    // Races gather where their newest runner would have been, so a race reads as one entry.
    const items: RepoItem[] = [];
    const placed = new Set<string>();
    for (const row of rows) {
      const raceId = row.task ? raceIdOf(row.task) : "";
      if (raceId === "") {
        items.push({ kind: "row", row });
        continue;
      }
      if (placed.has(raceId)) continue;
      placed.add(raceId);
      // Runners in the order they were started — the race panel's column order — not newest first.
      const runners = rows
        .filter((candidate) => candidate.task && raceIdOf(candidate.task) === raceId)
        .sort((a, b) => -byCreation(a.task as AgentTask, b.task as AgentTask));
      items.push({ kind: "race", raceId, rows: runners });
    }
    // `rows` in the order the rail draws them, so "the first row" means the one on top.
    return { repo, items, rows: items.flatMap((item) => (item.kind === "row" ? [item.row] : item.rows)) };
  });
}

/**
 * What a row is doing, in the words the rail draws.
 *
 * - `asking`: something is waiting on the user — a `cf ask` from that folder.
 * - `working`: a turn is running.
 * - `failed`: the last turn failed.
 * - `ready`: it has answered and is waiting for the next word — the "your turn" state, and the one
 *   an unread mark goes on.
 * - `done`, `draft`, `stopped`: the task's own states.
 * - `empty`: no task here — a place to start one.
 */
export type RowState = "asking" | "working" | "failed" | "ready" | "done" | "draft" | "stopped" | "empty";

export function rowState(row: WorktreeRow, sending: boolean, asking: boolean): RowState {
  if (asking) return "asking";
  const task = row.task;
  if (!task) return "empty";
  if (sending || task.status === "running") return "working";
  switch (task.status) {
    case "error":
      return "failed";
    case "done":
      return "done";
    case "cancelled":
      return "stopped";
    case "draft":
      return "draft";
    default:
      return task.turns > 0 ? "ready" : "draft";
  }
}

/** Whether a row has news the user has not looked at: a turn finished since they last opened it. */
export function isUnread(task: AgentTask | null, seenTurns: Readonly<Record<string, number>>, selected: boolean): boolean {
  if (!task || selected) return false;
  const seen = seenTurns[task.id];
  // Never recorded is "seen": the marks start with the first turn that lands after this view
  // exists, rather than lighting up every task the user already read before it did.
  if (seen === undefined) return false;
  return task.turns > seen;
}

/** The folder name a row's path ends in — what a row with no branch is called. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

// ── Sections: where a working copy sits on the rail ───────────────────────────────────────────

/**
 * The statuses a working copy is filed under, as Orca files its workspaces: set by the user (the
 * card's menu, or a drag onto another section), never moved by the app. Pinned rows sit above all
 * of them.
 */
export type LaneId = "todo" | "progress" | "review" | "done";
export const LANES: readonly LaneId[] = ["todo", "progress", "review", "done"];
/** Where a working copy nobody has filed goes: it is on the rail because work happens there. */
export const DEFAULT_LANE: LaneId = "progress";
export type RailGrouping = "status" | "project";

export interface RailSection {
  /** `pinned`, `lane:<id>` or `project:<id>` — also the key its fold is remembered under. */
  id: string;
  /** The status a card dropped on this section takes, or `null` where a drop means nothing. */
  lane: LaneId | null;
  /** The repository a project section is, or `null`. */
  projectId: string | null;
  rows: WorktreeRow[];
}

/** A row's status. Keyed by folder, not by row key: a task row becomes a plain row when its task is
 *  deleted, and the working copy is still the same one, filed where the user put it. */
export function laneOf(row: WorktreeRow, lanes: Readonly<Record<string, LaneId>>): LaneId {
  return lanes[pathKey(row.path)] ?? DEFAULT_LANE;
}

/**
 * The rail's sections. Pinned first when anything is pinned; then every status — empty ones too, so
 * there is always somewhere to drop a card — or every repository with rows in it.
 */
export function railSections(
  blocks: readonly RepoBlock[],
  options: { grouping: RailGrouping; lanes: Readonly<Record<string, LaneId>>; pinned: readonly string[] },
): RailSection[] {
  const pinned = new Set(options.pinned);
  const isPinned = (row: WorktreeRow) => row.path !== "" && pinned.has(pathKey(row.path));
  const sections: RailSection[] = [];
  const top = blocks.flatMap((block) => block.rows.filter(isPinned));
  if (top.length > 0) sections.push({ id: "pinned", lane: null, projectId: null, rows: top });
  if (options.grouping === "project") {
    for (const block of blocks) {
      const rows = block.rows.filter((row) => !isPinned(row));
      if (rows.length > 0) sections.push({ id: `project:${block.repo.id}`, lane: null, projectId: block.repo.id, rows });
    }
    return sections;
  }
  const rest = blocks.flatMap((block) => block.rows.filter((row) => !isPinned(row)));
  for (const lane of LANES) {
    sections.push({ id: `lane:${lane}`, lane, projectId: null, rows: rest.filter((row) => laneOf(row, options.lanes) === lane) });
  }
  return sections;
}

// ── Agent lines: who is working in a working copy ─────────────────────────────────────────────

/** What one agent line says it is doing — the glyphs the rail and the tabs share. */
export type LineState = "working" | "blocked" | "error" | "done" | "idle";

export interface AgentLine {
  key: string;
  /** Provider id for its mark, or `null` for a program that did not say what it is. */
  provider: string | null;
  state: LineState;
  /** What it was asked, when known. */
  prompt: string;
  /** What it answered, or its own one-line summary. */
  detail: string;
  /** Unix ms of its last change of state — the age on the line. */
  at: number;
  /** It finished (or stopped to ask) since the user last looked. */
  unread: boolean;
  /** Where a click on the line goes. */
  target: { kind: "terminal"; sessionId: string } | { kind: "task"; taskId: string };
}

/**
 * The row a folder belongs to: the one whose working copy holds it most closely. A Claude Code
 * worktree under `<repo>/.claude/worktrees/…` is inside the main checkout too, and belongs to its
 * own row, not to the repository's.
 */
export function rowForFolder(rows: readonly WorktreeRow[], folder: string): WorktreeRow | null {
  let best: WorktreeRow | null = null;
  let bestLength = -1;
  for (const row of rows) {
    if (row.path === "" || !isWithin(row.path, folder)) continue;
    const length = pathKey(row.path).length;
    if (length > bestLength) {
      best = row;
      bestLength = length;
    }
  }
  return best;
}

/** Every terminal agent, filed under the row whose folder it is in. */
export function agentsByRow(rows: readonly WorktreeRow[], agents: Readonly<Record<string, TerminalAgent>>): Map<string, TerminalAgent[]> {
  const out = new Map<string, TerminalAgent[]>();
  for (const agent of Object.values(agents)) {
    if (!agent.state) continue;
    const row = rowForFolder(rows, agent.cwd);
    if (!row) continue;
    const list = out.get(row.key);
    if (list) list.push(agent);
    else out.set(row.key, [agent]);
  }
  for (const list of out.values()) list.sort((a, b) => a.session_id.localeCompare(b.session_id));
  return out;
}

/** A terminal agent as a line. Unread while its turn started after the user last looked, and it has
 *  since stopped — finished, failed, or waiting on them. */
export function terminalLine(agent: TerminalAgent, seenAt: number | undefined): AgentLine | null {
  if (!agent.state) return null;
  const state: LineState = agent.state;
  const settled = state === "done" || state === "blocked" || state === "error";
  return {
    key: `terminal:${agent.session_id}`,
    provider: agent.agent,
    state,
    prompt: agent.prompt,
    detail: agent.reply || agent.summary,
    at: agent.since,
    unread: settled && agent.turn > 0 && agent.turn > (seenAt ?? 0),
    target: { kind: "terminal", sessionId: agent.session_id },
  };
}

const TASK_LINE: Record<RowState, LineState> = {
  asking: "blocked",
  working: "working",
  failed: "error",
  ready: "done",
  done: "done",
  draft: "idle",
  stopped: "idle",
  empty: "idle",
};

/** A row's own task — a chat agent, the local model included — as a line. */
export function taskLine(task: AgentTask, state: RowState, unread: boolean): AgentLine {
  const at = Date.parse(task.updated_at);
  return {
    key: `task:${task.id}`,
    provider: task.provider,
    state: TASK_LINE[state],
    prompt: task.title || task.goal || task.prompt,
    detail: "",
    at: Number.isFinite(at) ? at : 0,
    unread,
    target: { kind: "task", taskId: task.id },
  };
}

const URGENCY: readonly LineState[] = ["blocked", "working", "error", "done", "idle"];

/** The one state a card wears for all its lines: the most urgent — someone waiting on the user
 *  first, then work under way. `null` with nobody there. */
export function cardState(lines: readonly AgentLine[]): LineState | null {
  for (const state of URGENCY) if (lines.some((line) => line.state === state)) return state;
  return null;
}

// ── What the rail lists ───────────────────────────────────────────────────────────────────────

/**
 * Whether a row is **a task** — what the rail lists, as Orca lists workspaces and not every folder
 * git knows about: a chat task, a working copy «Nuevo agente» made (it has a name), one with an
 * agent at work in a terminal right now, or one the user pinned. A repository's own checkout or a
 * worktree with nothing in it is a place, not a task, and stays off the rail until something
 * happens there.
 */
export function isListed(
  row: WorktreeRow,
  context: { names: Readonly<Record<string, string>>; pinned: readonly string[]; byRow: ReadonlyMap<string, readonly TerminalAgent[]> },
): boolean {
  if (row.task) return true;
  if (row.path === "") return false;
  const key = pathKey(row.path);
  return !!context.names[key] || context.pinned.includes(key) || (context.byRow.get(row.key)?.length ?? 0) > 0;
}

/** The blocks with only the rows `isListed` keeps. */
export function listedBlocks(
  blocks: readonly RepoBlock[],
  context: Parameters<typeof isListed>[1],
): RepoBlock[] {
  return blocks.map((block) => {
    const rows = block.rows.filter((row) => isListed(row, context));
    return { ...block, rows, items: block.items.filter((item) => (item.kind === "row" ? rows.includes(item.row) : true)) };
  });
}

