/**
 * A race: one goal handed to several agents at once, each in a worktree of its own, to be compared
 * afterwards and one of them kept.
 *
 * # Why a race needs an id and not a heuristic
 *
 * The tasks of a race are ordinary tasks — same goal, same repository, a worktree each — and
 * nothing about them says they were started together. Grouping by "same goal, created within a few
 * seconds" would quietly merge two separate attempts at the same objective a week apart, which is
 * exactly the comparison nobody asked for. So the id is stamped at creation (`agent_tasks.batch_id`)
 * and this module only ever reads it.
 *
 * Everything here is pure: the ordering of the columns and the arithmetic under them are what a
 * reader compares two agents' work with, and both are worth pinning without a repository on disk.
 */

import type { AgentTask, AgentTaskStatus } from "../../types/domain";

/** The race a task belongs to, or `""` when it was started on its own. */
export function raceIdOf(task: Pick<AgentTask, "batch_id">): string {
  return (task.batch_id ?? "").trim();
}

/**
 * The tasks of one race, in the order their columns are drawn.
 *
 * By creation, oldest first — the order they were started in, which is the order the dialog listed
 * the agents in — and by id for the pair created in the same millisecond, so two renders of the
 * same race never swap two columns around. Deliberately *not* by progress or by size: a column that
 * moved every time an agent wrote a line would make the comparison impossible to read.
 */
export function racersOf(tasks: readonly AgentTask[], batchId: string): AgentTask[] {
  const id = batchId.trim();
  if (id === "") return [];
  return tasks
    .filter((task) => raceIdOf(task) === id)
    .sort((a, b) => (a.created_at === b.created_at ? a.id.localeCompare(b.id) : a.created_at.localeCompare(b.created_at)));
}

/** What one agent's work adds up to, as the column's headline. */
export interface RaceTally {
  files: number;
  added: number;
  removed: number;
}

/** The totals of a worktree's changed files — `taskReviewStore`'s rows, already counted per file. */
export function tally(files: readonly { added: number; removed: number }[]): RaceTally {
  return files.reduce<RaceTally>(
    (total, file) => ({
      files: total.files + 1,
      added: total.added + file.added,
      removed: total.removed + file.removed,
    }),
    { files: 0, added: 0, removed: 0 },
  );
}

/**
 * Whether a race is still being run.
 *
 * `true` while any of its tasks is working, which is what the panel says instead of inviting a
 * comparison between a finished agent and one that is halfway through its first file. It is not a
 * lock: the columns are readable throughout, and nothing here stops anyone keeping one early.
 */
export function raceRunning(racers: readonly AgentTask[], sendingIds: ReadonlySet<string>): boolean {
  return racers.some((task) => sendingIds.has(task.id) || task.status === "running");
}

/** A race as the task list draws it: the id, and its tasks in column order. */
export interface RaceGroup {
  batchId: string;
  tasks: AgentTask[];
}

/**
 * The races among a list of tasks, and which race each grouped task belongs to.
 *
 * **Only a race of two or more is a race.** A group of one would be a parent row with a single
 * child — the same task drawn twice, one indent apart — and that happens routinely: tasks of a race
 * get deleted, and a search matches one racer and not its rivals. Those survivors are left out of
 * `memberOf` so the caller draws them where it draws any loose task.
 *
 * `exclude` is for tasks that already belong to something else, a chain's steps above all: a task
 * can only be nested under one parent, and the plan it was produced by wins over a race it was
 * somehow also stamped with.
 */
export function groupRaces(
  tasks: readonly AgentTask[],
  exclude?: ReadonlySet<string>,
): { races: RaceGroup[]; memberOf: Map<string, string> } {
  const byRace = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    if (exclude?.has(task.id)) continue;
    const id = raceIdOf(task);
    if (id === "") continue;
    const bucket = byRace.get(id);
    if (bucket) bucket.push(task);
    else byRace.set(id, [task]);
  }

  const races: RaceGroup[] = [];
  const memberOf = new Map<string, string>();
  for (const [batchId, members] of byRace) {
    if (members.length < 2) continue;
    races.push({ batchId, tasks: racersOf(members, batchId) });
    for (const task of members) memberOf.set(task.id, batchId);
  }
  return { races, memberOf };
}

/** When the race last moved — the list is ordered by it, as it is for a chain. */
export function raceStamp(race: RaceGroup): string {
  return race.tasks.reduce((latest, task) => (task.updated_at > latest ? task.updated_at : latest), "");
}

/**
 * The one status a race's row wears.
 *
 * Live work first — a race with an agent still writing is a race, whatever the others finished as —
 * then the states that ask something of the user, and `done` only once every racer is done. The
 * order is the question it answers: "is there anything to do about this?"
 */
export function raceStatus(racers: readonly AgentTask[], sendingIds: ReadonlySet<string>): AgentTaskStatus {
  if (racers.length === 0) return "idle";
  if (raceRunning(racers, sendingIds)) return "running";
  if (racers.some((task) => task.status === "error")) return "error";
  if (racers.some((task) => task.status === "idle" || task.status === "draft")) return "idle";
  if (racers.every((task) => task.status === "done")) return "done";
  return "cancelled";
}
