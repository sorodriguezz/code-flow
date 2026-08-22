import { parse as parseYaml } from "yaml";
import type { PipelineJob } from "../types/domain";

/**
 * The columns of the pipeline graph — which jobs ran at the same time as which others.
 *
 * This module exists because a vertical list of jobs is a lie. It reads as "this, then this, then
 * this", and in CI most of those jobs started within the same second. The columns are the fix:
 * one column per stage, everything inside a column ran together.
 *
 * The hard part is that the three providers answer the question in three different ways, and one
 * of them doesn't answer it at all:
 *
 *  - **GitLab** puts `stage` on every job. First class, nothing to compute.
 *  - **Azure** gives a timeline whose records nest, so the backend has already resolved each job's
 *    `Stage` ancestor into the same `stage` field.
 *  - **GitHub** gives *nothing*. `GET /runs/{id}/jobs` returns names, statuses and timings, and no
 *    relation between jobs whatsoever. So its columns are read out of the workflow file — the run
 *    carries its `path`, the file is in the working copy, and `needs:` is what we're after.
 *
 * And when the workflow can't be read — renamed, deleted, or the working copy sitting on a
 * different commit than the run — there is a third way: group jobs whose execution *overlapped in
 * time*. It is an approximation and it is capable of being wrong (two independent jobs that ran
 * back to back because there was only one runner look like a dependency), which is precisely why
 * [`PipelineGraph.source`] exists and the panel header says out loud where its structure came from.
 */
export type GraphSource = "stage" | "needs" | "time" | "flat";

export interface GraphColumn {
  /** Stable across re-renders; the stage name, the level index, or the wave index. */
  key: string;
  /** What the header shows. Empty for a level that has no name of its own. */
  label: string;
  jobs: PipelineJob[];
}

export interface PipelineGraph {
  columns: GraphColumn[];
  source: GraphSource;
  /** The widest column — how many jobs ran at once at the busiest moment of the run. */
  maxParallel: number;
}

/** Epoch milliseconds, or `null` for a job that never started. */
function at(stamp: string | null): number | null {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Columns straight from the `stage` the provider gave, in first-appearance order.
 *
 * First-appearance rather than alphabetical or by start time: the backend already returns jobs in
 * the order the host lists them, which for both GitLab and Azure is declaration order — the order
 * the person who wrote the pipeline put them in, and the one they will be looking for.
 */
function byStage(jobs: PipelineJob[]): GraphColumn[] {
  const order: string[] = [];
  const map = new Map<string, PipelineJob[]>();
  for (const job of jobs) {
    const stage = job.stage ?? "";
    if (!map.has(stage)) {
      map.set(stage, []);
      order.push(stage);
    }
    map.get(stage)!.push(job);
  }
  return order.map((stage) => ({ key: `stage:${stage}`, label: stage, jobs: map.get(stage)! }));
}

/**
 * Reads the `needs:` out of a GitHub workflow file.
 *
 * Returns a map from *display name* to the display names it depends on, because the display name
 * is the only thing the jobs endpoint gives us to match against. Two shapes have to be handled:
 *
 *  - `jobs.<id>.name` when the workflow sets one — that string is what the API reports;
 *  - the bare `<id>` when it doesn't.
 *
 * Matrix jobs are the reason this returns names and not ids: `jobs.build` with a matrix over three
 * runners arrives from the API as three jobs called `build (macos-latest)`, `build (ubuntu-latest)`
 * and `build (windows-latest)`. Prefix matching in [`levelsFromNeeds`] is what reunites them.
 *
 * Returns `null` — never throws and never a half-parsed map — when the file isn't a workflow we
 * recognise. The caller falls back to time, which is always available.
 */
export function parseWorkflowNeeds(yamlText: string): Map<string, string[]> | null {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const jobs = (doc as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object") return null;

  // id → the name the API will report for it.
  const displayOf = new Map<string, string>();
  for (const [id, value] of Object.entries(jobs as Record<string, unknown>)) {
    const name =
      value && typeof value === "object" && typeof (value as Record<string, unknown>).name === "string"
        ? ((value as Record<string, unknown>).name as string)
        : id;
    // A `name:` with an expression in it (`${{ matrix.os }}`) resolves at run time to something
    // this file cannot know. Falling back to the id keeps the prefix match working for the common
    // case where the expression is a suffix; where it isn't, the job simply doesn't match and
    // lands in the first level, which is the same place an unconstrained job belongs anyway.
    displayOf.set(id, name.includes("${{") ? id : name);
  }

  const needs = new Map<string, string[]>();
  for (const [id, value] of Object.entries(jobs as Record<string, unknown>)) {
    const raw = value && typeof value === "object" ? (value as Record<string, unknown>).needs : undefined;
    const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
    needs.set(displayOf.get(id)!, list.map((n) => displayOf.get(n) ?? n));
  }
  return needs.size > 0 ? needs : null;
}

/**
 * Whether an API job name belongs to a workflow job called `declared`.
 *
 * Three shapes, because GitHub reports one declaration under three different names:
 *  - exactly, for an ordinary job;
 *  - `build (macos-latest)`, for a matrix expansion;
 *  - `ci / build`, for a job that `uses:` a reusable workflow — its children are reported prefixed
 *    with the *caller's* name and a slash. Missing this one was not cosmetic: no need could ever be
 *    satisfied, so every job downstream of the reusable one collapsed into a single column and the
 *    panel labelled the result "declared by the pipeline", which is the badge that means trust me.
 */
function matches(apiName: string, declared: string): boolean {
  return (
    apiName === declared ||
    apiName.startsWith(`${declared} (`) ||
    apiName.startsWith(`${declared} / `)
  );
}

/**
 * Topological levels: level 0 is everything that depends on nothing, level N is everything whose
 * dependencies are all satisfied by levels below N.
 *
 * A cycle can't happen in a workflow GitHub accepted, but a `needs:` pointing at a job that was
 * renamed can — so anything still unplaced after the levels stop growing is swept into the last
 * one rather than dropped. A job you can see in the log has to appear in the graph.
 */
function levelsFromNeeds(jobs: PipelineJob[], needs: Map<string, string[]>): GraphColumn[] | null {
  const dependsOn = (job: PipelineJob): string[] => {
    for (const [declared, list] of needs) {
      if (matches(job.name, declared)) return list;
    }
    return [];
  };

  const placed = new Map<string, number>();
  const remaining = [...jobs];
  const levels: PipelineJob[][] = [];

  while (remaining.length > 0) {
    const ready = remaining.filter((job) =>
      dependsOn(job).every(
        (need) =>
          [...placed.keys()].some((name) => matches(name, need)) ||
          // A need naming a job this run doesn't contain — renamed since, or skipped entirely by a
          // job-level `if:` — is not a reason to hold everything behind it. Ignored, so one stale
          // reference can't sweep the whole tail into a single column that claims they ran together.
          !jobs.some((candidate) => matches(candidate.name, need)),
      ),
    );
    // Nothing became ready: the graph references something that isn't here. Everything left goes
    // into one final column together.
    if (ready.length === 0) {
      levels.push(remaining.splice(0, remaining.length));
      break;
    }
    levels.push(ready);
    for (const job of ready) {
      placed.set(job.name, levels.length - 1);
      remaining.splice(remaining.indexOf(job), 1);
    }
  }

  if (levels.length === 0) return null;
  return levels.map((jobsAtLevel, index) => ({
    key: `needs:${index}`,
    label: labelForLevel(jobsAtLevel, index),
    jobs: jobsAtLevel,
  }));
}

/**
 * A name for a column that has none.
 *
 * A level with one job borrows that job's name — "setup" reads better as a column header than
 * "Nivel 1" does. A level with several has no honest name, so it gets none and the header shows
 * only the count and the "×N in parallel" badge, which is the information that matters there.
 */
function labelForLevel(jobs: PipelineJob[], index: number): string {
  return jobs.length === 1 ? jobs[0].name : String(index + 1);
}

/**
 * Waves of jobs whose runs overlapped in time.
 *
 * Interval merging: sort by start, and a job joins the open wave when it started before that wave
 * ended. This is the only grouping that needs nothing but the data every provider returns, and it
 * is the only one that is *measured* rather than declared — which cuts both ways. It cannot claim
 * a dependency that wasn't there, and it can invent one that was only ever a queue.
 *
 * Jobs that never started (queued, skipped) have no interval to merge and are collected into a
 * trailing column: they are real, they belong on screen, and putting them anywhere else would
 * imply a position in the run they haven't earned yet.
 */
function byTime(jobs: PipelineJob[]): GraphColumn[] {
  const started = jobs.filter((job) => at(job.started_at) !== null);
  const pending = jobs.filter((job) => at(job.started_at) === null);

  const sorted = [...started].sort((a, b) => (at(a.started_at) ?? 0) - (at(b.started_at) ?? 0));
  const waves: PipelineJob[][] = [];
  let waveEnd = -Infinity;

  for (const job of sorted) {
    const start = at(job.started_at)!;
    // A job still running has no end; treat it as reaching the present, which it does.
    const end = at(job.finished_at) ?? Date.now();
    if (waves.length === 0 || start >= waveEnd) {
      waves.push([job]);
      waveEnd = end;
    } else {
      waves[waves.length - 1].push(job);
      waveEnd = Math.max(waveEnd, end);
    }
  }

  const columns = waves.map((wave, index) => ({
    key: `time:${index}`,
    label: labelForLevel(wave, index),
    jobs: wave,
  }));
  if (pending.length > 0) {
    columns.push({ key: "time:pending", label: "", jobs: pending });
  }
  return columns;
}

export interface BuildGraphOptions {
  /** The `needs:` map from the run's workflow file, when it could be read. GitHub only. */
  needs?: Map<string, string[]> | null;
}

/**
 * The graph, from whichever source can actually answer.
 *
 * The order is by trustworthiness, not by convenience: what the provider *declared* beats what we
 * *parsed*, and both beat what we *measured*.
 */
export function buildGraph(jobs: PipelineJob[], options: BuildGraphOptions = {}): PipelineGraph {
  const finish = (columns: GraphColumn[], source: GraphSource): PipelineGraph => ({
    columns,
    source,
    maxParallel: columns.reduce((most, column) => Math.max(most, column.jobs.length), 0),
  });

  if (jobs.length === 0) return finish([], "flat");

  // Declared by the provider. Every job has to have one — a run where half the jobs carry a stage
  // is a shape no provider produces, and guessing the other half would put jobs in columns their
  // own host never claimed.
  if (jobs.every((job) => job.stage !== null && job.stage !== "")) {
    return finish(byStage(jobs), "stage");
  }

  if (options.needs && options.needs.size > 0) {
    const columns = levelsFromNeeds(jobs, options.needs);
    // One column out of `needs:` is a real answer, not a failed one: a workflow whose jobs declare
    // no dependencies genuinely runs all of them at once.
    if (columns) return finish(columns, "needs");
  }

  return finish(byTime(jobs), "time");
}
