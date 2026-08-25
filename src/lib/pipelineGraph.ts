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

/** One declared dependency, job id to job id, pointing the way the run flowed. */
export interface GraphEdge {
  fromId: string;
  toId: string;
}

export interface PipelineGraph {
  columns: GraphColumn[];
  source: GraphSource;
  /** The widest column — how many jobs ran at once at the busiest moment of the run. */
  maxParallel: number;
  /**
   * The arrows, and where they came from depends on the source:
   *
   *  - `needs` — one per declaration that resolved to a job in this run. They can skip columns,
   *    because a job may depend on something two levels back.
   *  - `time` — the covering pairs of "could have gated", measured off the timestamps by
   *    [`layerSpans`]. Weaker than a declaration and drawn all the same, because the alternative is
   *    joining consecutive columns in full, which claims *more*: every job to every job.
   *  - `stage` — empty, and meaningfully so. A stage name says which jobs ran under it and nothing
   *    about which of them fed which; the stage board draws the relations between the **stages**,
   *    which it works out from the stage clocks rather than from these.
   */
  edges: GraphEdge[];
}

/** Epoch milliseconds, or `null` for a job that never started. */
function at(stamp: string | null): number | null {
  if (!stamp) return null;
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Columns straight from the stage the provider gave, in first-appearance order.
 *
 * First-appearance rather than alphabetical or by start time: the backend already returns jobs in
 * the order the host lists them, which for both GitLab and Azure is declaration order — the order
 * the person who wrote the pipeline put them in, and the one they will be looking for.
 *
 * Grouped by [`PipelineJob.stage_id`] and only *labelled* with `stage`, because a display name is
 * not an identity. Azure requires a stage's `stage:` key to be unique and says nothing about its
 * `displayName`, so one template instantiated per environment with a constant `displayName: Deploy`
 * produces two genuinely different stages under one string — and merged into one column they became
 * one card wearing one stage's verdict over the other's jobs. GitLab has no stage object and so no
 * id, but there the name *is* the identity: a pipeline cannot declare the same stage twice.
 */
function byStage(jobs: PipelineJob[]): GraphColumn[] {
  const order: string[] = [];
  const map = new Map<string, PipelineJob[]>();
  for (const job of jobs) {
    const key = job.stage_id ?? job.stage ?? "";
    if (!map.has(key)) {
      map.set(key, []);
      order.push(key);
    }
    map.get(key)!.push(job);
  }
  return order.map((key) => ({
    key: `stage:${key}`,
    label: map.get(key)![0].stage ?? "",
    jobs: map.get(key)!,
  }));
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
function levelsFromNeeds(
  jobs: PipelineJob[],
  needs: Map<string, string[]>,
): { columns: GraphColumn[]; edges: GraphEdge[] } | null {
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

  // One arrow per `needs:` that actually resolved. Built from the declarations rather than from the
  // columns, so a job that depends on something two levels back gets the arrow it earned instead of
  // one implied by whatever happens to sit immediately to its left.
  const declared: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    for (const need of dependsOn(job)) {
      for (const source of jobs) {
        const key = `${source.id}>${job.id}`;
        if (source.id !== job.id && matches(source.name, need) && !seen.has(key)) {
          seen.add(key);
          declared.push({ fromId: source.id, toId: job.id });
        }
      }
    }
  }

  return {
    columns: levels.map((jobsAtLevel, index) => ({
      key: `needs:${index}`,
      label: declaredLabel(jobsAtLevel, needs),
      jobs: jobsAtLevel,
    })),
    edges: transitiveReduction(declared),
  };
}

/**
 * Drops every arrow the rest of the graph already implies.
 *
 * An edge `u → v` goes if there is any *other* path from `u` to `v`: the dependency is still there,
 * still enforced, still reachable in the drawing — it is just no longer stated twice. This is the
 * transitive reduction of the DAG, and it has exactly the same reachability as what went in.
 *
 * **It is not a tidy-up, it is a correctness fix.** Real workflows declare far more than the graph's
 * shape needs, because `needs:` is also how a job gets another job's *outputs*: this repository's
 * own `release.yml` names `check-version` in all five of its jobs, to read the version it computed.
 * Drawn literally that is five arrows leaving `check-version`, four of which run the length of the
 * graph hidden behind the cards in between and surface only as an arrowhead in the last gutter. The
 * reader does not see four long arrows; the reader sees the short chain lit up, and concludes that
 * `create-release → release` is the highlighted edge when what is actually highlighted is
 * `check-version → prune-caches` passing behind it. An arrow nobody can trace to its own tail is
 * worse than no arrow — it attaches itself to whatever it happens to be lying on top of.
 *
 * The edges that survive are the ones that say something the layout doesn't already: they are what
 * the columns are *for*. Anything still spanning more than one column after this is genuine
 * information, and `RunGraph` routes those around the block rather than behind it.
 *
 * O(E·(V+E)) with a visited set per edge, which for a CI run — tens of jobs — is nothing, and the
 * visited set is also what keeps a malformed graph from walking a cycle forever.
 */
export function transitiveReduction(edges: GraphEdge[]): GraphEdge[] {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.fromId);
    if (list) list.push(edge.toId);
    else out.set(edge.fromId, [edge.toId]);
  }

  /** Can `target` be reached from `from` *without* taking the one edge under test? */
  const reachesAround = (edge: GraphEdge): boolean => {
    const visited = new Set<string>([edge.fromId]);
    // Seeded with the first hop rather than with `fromId`, so the edge being tested is the only one
    // excluded — every *other* edge out of `fromId`, including a parallel duplicate, still counts.
    const stack = (out.get(edge.fromId) ?? []).filter((next) => next !== edge.toId);
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === edge.toId) return true;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of out.get(node) ?? []) stack.push(next);
    }
    return false;
  };

  return edges.filter((edge) => !reachesAround(edge));
}

/**
 * The name a column of jobs can honestly be given.
 *
 * One job lends its own name. Several jobs that are all expansions of the *same* declaration —
 * a matrix — lend that declaration's name: `release (macos-latest)` and `release (windows-latest)`
 * are one `release:` in the workflow, and "RELEASE" is what the person who wrote it calls that
 * column. Several unrelated jobs have no shared name and get none.
 *
 * What this replaces was the level's 1-based index, printed bare: a column headed **3** sitting
 * between one headed CREATE-RELEASE and one headed UPDATER-JSON, with nothing to say that the 3
 * was an ordinal and not a count of anything. Two vocabularies in one row of headers, and the
 * number was the one that looked like data.
 */
function declaredLabel(jobs: PipelineJob[], needs: Map<string, string[]>): string {
  if (jobs.length === 1) return jobs[0].name;
  for (const declared of needs.keys()) {
    if (jobs.every((job) => matches(job.name, declared))) return declared;
  }
  return "";
}

/**
 * A name for a column of jobs that ran at the same depth.
 *
 * One job lends its name; several have nothing in common but a clock, so the header shows only the
 * "×N in parallel" badge. Deliberately *not* the column's index: see [`declaredLabel`].
 */
function labelForWave(jobs: PipelineJob[]): string {
  return jobs.length === 1 ? jobs[0].name : "";
}

/**
 * How far a span may appear to outlive the one after it and still count as its gate.
 *
 * A sequential pipeline is the common case and it has to keep looking sequential. The hosts stamp a
 * container's `finishTime` when it finished tearing down and its successor's `startTime` when the
 * successor was dispatched, and those two are recorded by different machines: a few hundred
 * milliseconds of overlap between two stages that plainly ran one after the other is ordinary, and
 * read literally it would put them side by side and claim they ran at once.
 *
 * Two seconds is deliberately far below the overlap of anything genuinely concurrent — parallel
 * stages share minutes, not milliseconds — so the slack cannot merge a real branch back into a
 * chain. It buys the reverse: a chain stays a chain.
 */
const GATE_SLACK_MS = 2000;

/** The five status buckets that mean "this is over". Everything else is still moving.
 *
 *  Lives here rather than beside the icons in `pipelineStatus.ts` because `layerSpans` needs it and
 *  nothing under `lib/` should be reaching into a component directory for a set of strings. */
export function isSettled(status: string): boolean {
  return (
    status === "success" ||
    status === "warning" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "skipped"
  );
}

/** One thing that occupied a span of time and has to be placed in the drawing: a job, or a whole
 *  stage. Only the two timestamps matter, which is why this is not `PipelineJob`. */
export interface Span {
  key: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Whether it has reached a terminal state. Only consulted for the awkward span that has settled
   * without publishing a finish time — see the `end` computation in [`layerSpans`]. A span with a
   * finish stamp does not need it, and neither does one that never started.
   */
  settled?: boolean;
}

export interface SpanLayers {
  /** `layers[d]` is every key at depth `d`, in the order the provider declared them. */
  layers: string[][];
  /** The covering pairs — the *latest* things that could have gated each span, and no more. */
  edges: GraphEdge[];
  /** True once any layer holds more than one span: the drawing now says something beyond "then". */
  branched: boolean;
}

/**
 * Depth for each span, from what could possibly have gated what.
 *
 * This replaces the interval merging that used to group jobs into "waves", and it is the reason a
 * run stops being drawn as a queue of one thing after another. Merging asks "did these overlap",
 * which is not transitive and collapses a whole chain the moment one long span touches all of it:
 * a 4-minute `Testing` running alongside `Build`→`Deploy` merged all three into one column, and the
 * fact that Deploy could not start until Build finished disappeared.
 *
 * What is asked instead is **"could j have gated i"**, and three rules answer it:
 *
 *  1. `j` started first and had **finished** by the time `i` started, give or take
 *     [`GATE_SLACK_MS`]. Finished is meant literally: something still running has not gated
 *     anything, however long ago it started.
 *  2. `i` never started, so no clock can place it. It sits behind everything declared ahead of it.
 *  3. `j` never started, so nothing declared after it can be shown running *beside* it — a stage
 *     that was skipped by a condition did not run alongside the one after it, it was passed over on
 *     the way there. Without this rule a `DeployStaging` skipped on this branch was drawn stacked
 *     against `DeployProd` as though the two had gone out together.
 *
 * Depth is the *longest* chain of gates reaching a span, so anything with no gate between it and
 * another span shares that span's column. On a real Azure build — `Environment` → (`Testing`,
 * `Build`) → (`Quality Code`, `Deploy`) — this reproduces the host's own drawing exactly, arrows
 * included, out of nothing but five pairs of timestamps.
 *
 * **Declaration order is the tie-break**, deliberately: `j` can only gate `i` when it comes first in
 * the array. That guarantees the relation is acyclic whatever the timestamps say (two zero-length
 * spans stamped identically would otherwise gate each other), and it is not merely a safety net —
 * declaration order is itself something the provider told us. On the build above, `Quality Code` is
 * declared before `Deploy` and finished after it, so by the clock alone Deploy appears to gate it
 * and the two stop being siblings; the YAML's order is what keeps them in one column.
 *
 * The three rules together are **not** transitively closed — rule 3 can hand `j → k` and `k → i`
 * where `j` and `i` overlap outright — so the closure is computed rather than assumed. That is what
 * `reaches` is: without it the depths would be short by however many unplaceable spans lay along
 * the chain, and the covers below would not be a transitive reduction at all but merely a filter
 * that happens to be right most of the time.
 *
 * Note what is *not* a parameter: the clock. Nothing here consults the present, so a run's shape is
 * a function of the run alone and two polls of the same unchanged data cannot draw it differently.
 * That was not true while a running span was measured to `now`.
 */
export function layerSpans(spans: Span[]): SpanLayers {
  const n = spans.length;
  const start = spans.map((span) => at(span.startedAt));
  // When it stopped, or `null` for something that has not stopped.
  //
  // Deliberately *not* `now`. `now` is what the durations on screen are measured against, and it was
  // used here too until a run with two stages both in flight was drawn as a chain: `end - SLACK <=
  // start` reads a running span as one that finished two seconds ago, so every sibling dispatched
  // within the last couple of seconds of the poll looked gated by it. Two things running at the same
  // instant are the one case where concurrency is not an inference at all, and it was the case this
  // got wrong.
  //
  // A span that has settled without a finish stamp — an abandoned Azure stage — is taken as
  // instantaneous at its start rather than as never-ending: it is over, and what is left of it must
  // not hold the next column open.
  const end = spans.map((span, i) => {
    if (start[i] === null) return null;
    const stopped = at(span.finishedAt);
    if (stopped !== null) return stopped;
    return span.settled ? start[i] : null;
  });

  const gate: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      // Rules 2 and 3: one of the pair has no clock, so the file's order is the whole answer.
      if (start[i] === null || start[j] === null) {
        gate[j][i] = true;
        continue;
      }
      if (end[j] === null) continue;
      gate[j][i] =
        // Started later, or they are siblings: two stages dispatched in the same instant are the
        // shape this whole function exists to draw, and the shorter of them must not be read as the
        // longer one's gate just because it finished first.
        (start[j] as number) < (start[i] as number) &&
        (end[j] as number) - GATE_SLACK_MS <= (start[i] as number);
    }
  }

  // `reaches[i][j]` — j is an ancestor of i. Built in one ascending pass because `gate[j][i]` only
  // ever holds for `j < i`, so every ancestor of j is already known by the time i is reached.
  const reaches: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const depth = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (!gate[j][i]) continue;
      reaches[i][j] = true;
      for (let k = 0; k < j; k++) if (reaches[j][k]) reaches[i][k] = true;
    }
    // The longest chain ending here. Every chain to i passes through one of its ancestors, and each
    // ancestor's own longest chain is already settled, so the maximum over them is exact.
    for (let j = 0; j < i; j++) {
      if (reaches[i][j]) depth[i] = Math.max(depth[i], depth[j] + 1);
    }
  }

  const edges: GraphEdge[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (!reaches[i][j]) continue;
      // A cover: nothing sits between them. `j → k → i` already says everything `j → i` would.
      let covered = false;
      for (let k = j + 1; k < i && !covered; k++) covered = reaches[k][j] && reaches[i][k];
      if (!covered) edges.push({ fromId: spans[j].key, toId: spans[i].key });
    }
  }

  const layers: string[][] = [];
  for (let i = 0; i < n; i++) {
    while (layers.length <= depth[i]) layers.push([]);
    layers[depth[i]].push(spans[i].key);
  }

  return { layers, edges, branched: layers.some((layer) => layer.length > 1) };
}

/**
 * Columns of jobs, placed by [`layerSpans`] — the fallback for a run whose structure nothing
 * declared.
 *
 * This is the only grouping that needs nothing but the data every provider returns, and it is the
 * only one that is *measured* rather than declared, which cuts both ways: it cannot claim a
 * dependency that wasn't there, and it can invent one that was only ever a queue for a runner.
 *
 * Jobs that never started are placed by declaration order rather than swept into a trailing column,
 * which is what `layerSpans`' second rule buys: a queued job now sits behind what was declared
 * before it instead of behind everything, and two of them declared in sequence read as a sequence.
 */
function byTime(jobs: PipelineJob[]): { columns: GraphColumn[]; edges: GraphEdge[] } {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const { layers, edges } = layerSpans(
    jobs.map((job) => ({
      key: job.id,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      settled: isSettled(job.status),
    })),
  );

  return {
    columns: layers.map((layer, index) => {
      const inLayer = layer.map((key) => byId.get(key)!);
      return { key: `time:${index}`, label: labelForWave(inLayer), jobs: inLayer };
    }),
    edges,
  };
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
  const finish = (columns: GraphColumn[], source: GraphSource, edges: GraphEdge[] = []): PipelineGraph => ({
    columns,
    source,
    maxParallel: columns.reduce((most, column) => Math.max(most, column.jobs.length), 0),
    edges,
  });

  if (jobs.length === 0) return finish([], "flat");

  // Declared by the provider. Every job has to have one — a run where half the jobs carry a stage
  // is a shape no provider produces, and guessing the other half would put jobs in columns their
  // own host never claimed.
  if (jobs.every((job) => job.stage !== null && job.stage !== "")) {
    return finish(byStage(jobs), "stage");
  }

  if (options.needs && options.needs.size > 0) {
    const built = levelsFromNeeds(jobs, options.needs);
    // One column out of `needs:` is a real answer, not a failed one: a workflow whose jobs declare
    // no dependencies genuinely runs all of them at once.
    if (built) return finish(built.columns, "needs", built.edges);
  }

  const measured = byTime(jobs);
  return finish(measured.columns, "time", measured.edges);
}
