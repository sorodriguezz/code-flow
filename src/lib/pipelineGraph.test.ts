import { describe, expect, it } from "vitest";
import {
  buildGraph,
  isSettled,
  layerDeclared,
  layerSpans,
  orderLayers,
  parseAzureStages,
  parseWorkflowNeeds,
  transitiveReduction,
  type GraphEdge,
  type Span,
} from "./pipelineGraph";
import type { PipelineJob } from "../types/domain";

/**
 * The ordering logic the Pipelines tab draws with — and the one place in it where a wrong answer
 * looks exactly like a right one. A graph that invents a dependency, or loses one, still renders;
 * nothing on screen says it is wrong. These pin down the rules the module's comments argue for,
 * each with the shape of run that broke it before.
 */

/** A timestamp `seconds` into a fixed morning, so spans read as plain offsets. */
function T(seconds: number): string {
  return new Date(Date.UTC(2026, 8, 1, 10, 0, 0) + seconds * 1000).toISOString();
}

function job(id: string, over: Partial<PipelineJob> = {}): PipelineJob {
  return {
    provider: "github",
    run_id: "1",
    id,
    name: id,
    stage: null,
    stage_id: null,
    status: "success",
    raw_status: "success",
    started_at: null,
    finished_at: null,
    web_url: "",
    log_ref: null,
    ...over,
  };
}

function span(key: string, start: number | null, end: number | null, settled?: boolean): Span {
  return { key, startedAt: start === null ? null : T(start), finishedAt: end === null ? null : T(end), settled };
}

const edge = (fromId: string, toId: string): GraphEdge => ({ fromId, toId });
const keysOf = (layers: string[][]) => layers.map((layer) => [...layer]);

describe("isSettled", () => {
  it("is the five buckets that mean it is over", () => {
    for (const settled of ["success", "warning", "failed", "cancelled", "skipped"]) {
      expect(isSettled(settled)).toBe(true);
    }
    for (const moving of ["queued", "running", "something-new"]) expect(isSettled(moving)).toBe(false);
  });
});

describe("transitiveReduction", () => {
  it("drops an arrow the rest of the graph already implies", () => {
    expect(transitiveReduction([edge("a", "b"), edge("b", "c"), edge("a", "c")])).toEqual([
      edge("a", "b"),
      edge("b", "c"),
    ]);
  });

  it("keeps a diamond's four sides and drops its diagonal", () => {
    const reduced = transitiveReduction([
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
      edge("a", "d"),
    ]);
    expect(reduced).toEqual([edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d")]);
  });

  /** release.yml's shape: every job `needs:` the version check to read its output. Drawn
   *  literally, four arrows ran the length of the graph behind the cards. */
  it("reduces a job everybody needs for its outputs to the one arrow the chain needs", () => {
    const declared = [
      edge("check", "build"),
      edge("check", "release"),
      edge("build", "release"),
      edge("check", "publish"),
      edge("release", "publish"),
    ];
    expect(transitiveReduction(declared)).toEqual([
      edge("check", "build"),
      edge("build", "release"),
      edge("release", "publish"),
    ]);
  });

  it("terminates on a cycle instead of walking it forever", () => {
    expect(transitiveReduction([edge("a", "b"), edge("b", "a")])).toEqual([edge("a", "b"), edge("b", "a")]);
  });
});

describe("parseWorkflowNeeds", () => {
  it("maps each job's display name to the display names it needs", () => {
    const needs = parseWorkflowNeeds(`
on: push
jobs:
  build:
    name: Build app
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: ubuntu-latest
  release:
    needs: [build, test]
    runs-on: ubuntu-latest
`);
    expect(needs).not.toBeNull();
    // The API reports "Build app", so that is the key — and a need on `build` is translated to it.
    expect(needs!.get("Build app")).toEqual([]);
    expect(needs!.get("test")).toEqual(["Build app"]);
    expect(needs!.get("release")).toEqual(["Build app", "test"]);
  });

  it("falls back to the id for a name that is an expression", () => {
    const needs = parseWorkflowNeeds(`
jobs:
  build:
    name: build \${{ matrix.os }}
  test:
    needs: build
`);
    expect([...needs!.keys()]).toEqual(["build", "test"]);
    expect(needs!.get("test")).toEqual(["build"]);
  });

  it("answers null — never a half-parsed map — for anything that isn't a workflow", () => {
    expect(parseWorkflowNeeds("jobs: [unclosed")).toBeNull();
    expect(parseWorkflowNeeds("just a string")).toBeNull();
    expect(parseWorkflowNeeds("on: push")).toBeNull();
    expect(parseWorkflowNeeds("jobs: {}")).toBeNull();
    expect(parseWorkflowNeeds("")).toBeNull();
  });
});

describe("buildGraph", () => {
  it("is flat and empty for a run with no jobs", () => {
    expect(buildGraph([])).toEqual({ columns: [], source: "flat", maxParallel: 0, edges: [] });
  });

  it("takes the provider's stages when every job has one, in first-appearance order", () => {
    const graph = buildGraph([
      job("1", { stage: "build" }),
      job("2", { stage: "test" }),
      job("3", { stage: "build" }),
      job("4", { stage: "deploy" }),
    ]);
    expect(graph.source).toBe("stage");
    expect(graph.columns.map((column) => [column.label, column.jobs.map((j) => j.id)])).toEqual([
      ["build", ["1", "3"]],
      ["test", ["2"]],
      ["deploy", ["4"]],
    ]);
    expect(graph.maxParallel).toBe(2);
    // A stage name says which jobs ran under it, not which of them fed which.
    expect(graph.edges).toEqual([]);
  });

  /** Two stages from one template with a constant displayName are two stages. Merged by name they
   *  became one card with one stage's verdict over the other's jobs. */
  it("groups by stage id, so two stages sharing a display name stay two columns", () => {
    const graph = buildGraph([
      job("dev-job", { stage: "Deploy", stage_id: "stage-dev" }),
      job("prod-job", { stage: "Deploy", stage_id: "stage-prod" }),
    ]);
    expect(graph.columns).toHaveLength(2);
    expect(graph.columns.map((column) => column.label)).toEqual(["Deploy", "Deploy"]);
    expect(graph.columns[0].key).not.toBe(graph.columns[1].key);
  });

  it("does not trust stages when only some jobs carry one", () => {
    const graph = buildGraph([
      job("a", { stage: "build", started_at: T(0), finished_at: T(10) }),
      job("b", { stage: "", started_at: T(12), finished_at: T(20) }),
    ]);
    expect(graph.source).toBe("time");
  });

  it("lays GitHub jobs out by the levels of their needs, with the declared arrows", () => {
    const needs = parseWorkflowNeeds(`
on: push
jobs:
  build: {}
  test:
    needs: build
  lint: {}
  release:
    needs: [test, lint]
`)!;
    const graph = buildGraph([job("build"), job("test"), job("lint"), job("release")], { needs });
    expect(graph.source).toBe("needs");
    expect(graph.columns.map((column) => column.jobs.map((j) => j.id))).toEqual([
      ["build", "lint"],
      ["test"],
      ["release"],
    ]);
    // Two unrelated jobs have no shared name; one job lends its own.
    expect(graph.columns.map((column) => column.label)).toEqual(["", "test", "release"]);
    expect(graph.edges).toEqual([edge("build", "test"), edge("test", "release"), edge("lint", "release")]);
    expect(graph.maxParallel).toBe(2);
  });

  /** A matrix job arrives as one job per leg; a reusable workflow's children arrive prefixed with
   *  the caller's name and a slash. Both have to satisfy the one declaration they came from. */
  it("matches matrix legs and reusable-workflow children to their declaration", () => {
    const needs = parseWorkflowNeeds(`
on: push
jobs:
  build: {}
  ci:
    uses: ./.github/workflows/ci.yml
  release:
    needs: [build, ci]
`)!;
    const graph = buildGraph(
      [job("b1", { name: "build (ubuntu-latest)" }), job("b2", { name: "build (macos-latest)" }), job("c", { name: "ci / test" }), job("r", { name: "release" })],
      { needs },
    );
    expect(graph.columns.map((column) => column.jobs.map((j) => j.id))).toEqual([["b1", "b2", "c"], ["r"]]);
    expect(graph.edges).toEqual([edge("b1", "r"), edge("b2", "r"), edge("c", "r")]);
  });

  it("names a column of one matrix after the declaration it expands", () => {
    const needs = parseWorkflowNeeds(`
on: push
jobs:
  check: {}
  release:
    needs: check
`)!;
    const graph = buildGraph(
      [job("c", { name: "check" }), job("r1", { name: "release (macos-latest)" }), job("r2", { name: "release (windows-latest)" })],
      { needs },
    );
    expect(graph.columns[1].label).toBe("release");
  });

  it("ignores a need on a job this run doesn't contain rather than holding everything behind it", () => {
    const needs = parseWorkflowNeeds(`
on: push
jobs:
  build: {}
  deploy:
    needs: [build, renamed-away]
`)!;
    const graph = buildGraph([job("build"), job("deploy")], { needs });
    expect(graph.columns.map((column) => column.jobs.map((j) => j.id))).toEqual([["build"], ["deploy"]]);
  });

  it("falls back to the clocks when the workflow could not be read", () => {
    const graph = buildGraph(
      [
        job("build", { started_at: T(0), finished_at: T(10) }),
        job("test", { started_at: T(12), finished_at: T(30) }),
      ],
      { needs: null },
    );
    expect(graph.source).toBe("time");
    expect(graph.columns.map((column) => column.label)).toEqual(["build", "test"]);
    expect(graph.edges).toEqual([edge("build", "test")]);
  });
});

describe("layerSpans", () => {
  it("keeps a sequential run a chain even when the hosts' clocks overlap by a second", () => {
    // B was dispatched a second before A finished tearing down — two machines, two clocks.
    const layered = layerSpans([span("A", 0, 10), span("B", 9, 20), span("C", 20, 30)]);
    expect(keysOf(layered.layers)).toEqual([["A"], ["B"], ["C"]]);
    // A → C is implied by the chain and not drawn again.
    expect(layered.edges).toEqual([edge("A", "B"), edge("B", "C")]);
    expect(layered.branched).toBe(false);
  });

  it("puts two things dispatched in the same instant side by side, whichever finished first", () => {
    const layered = layerSpans([span("A", 0, 10), span("B", 12, 40), span("C", 12, 15)]);
    expect(keysOf(layered.layers)).toEqual([["A"], ["B", "C"]]);
    expect(layered.edges).toEqual([edge("A", "B"), edge("A", "C")]);
    expect(layered.branched).toBe(true);
  });

  /** The reason interval merging was replaced: overlap is not transitive, and one long span beside
   *  a chain swallowed the chain into a single column. */
  it("keeps a chain that ran beside one long span", () => {
    const layered = layerSpans([span("Build", 0, 10), span("Testing", 0, 100), span("Deploy", 12, 30)]);
    expect(keysOf(layered.layers)).toEqual([["Build", "Testing"], ["Deploy"]]);
    expect(layered.edges).toEqual([edge("Build", "Deploy")]);
  });

  /** Declaration order is the tie-break: something declared *after* cannot gate what was declared
   *  before it, whatever the clocks say. */
  it("lets declaration order decide what may have gated what", () => {
    // Quality Code is declared before Deploy and started after Deploy finished.
    const declaredFirst = layerSpans([span("Env", 0, 10), span("QC", 40, 60), span("Deploy", 12, 30)]);
    expect(keysOf(declaredFirst.layers)).toEqual([["Env"], ["QC", "Deploy"]]);

    // Declared the other way round, the same clocks do make a chain.
    const declaredAfter = layerSpans([span("Env", 0, 10), span("Deploy", 12, 30), span("QC", 40, 60)]);
    expect(keysOf(declaredAfter.layers)).toEqual([["Env"], ["Deploy"], ["QC"]]);
  });

  /** Measured to `now`, a running span read as "finished two seconds ago" and chained every
   *  sibling dispatched in the last two seconds of a poll. */
  it("never lets a span that is still running gate anything", () => {
    const layered = layerSpans([span("A", 0, null, false), span("B", 20, 30)]);
    expect(keysOf(layered.layers)).toEqual([["A", "B"]]);
    expect(layered.edges).toEqual([]);
  });

  it("draws the same shape for the same data, every time", () => {
    const spans = [span("A", 0, null, false), span("B", 5, null, false), span("C", 1, 3)];
    expect(layerSpans(spans)).toEqual(layerSpans(spans));
  });

  it("reads a span that settled without a finish stamp as ending where it started", () => {
    const layered = layerSpans([span("Abandoned", 0, null, true), span("Next", 5, 10)]);
    expect(keysOf(layered.layers)).toEqual([["Abandoned"], ["Next"]]);
  });

  /** A stage skipped by a condition was passed over on the way to the next one, not run beside
   *  it: without the second half of the barrier rule, DeployStaging (skipped) stacked against
   *  DeployProd as though they had gone out together. */
  it("treats a span that never started as a barrier in both directions", () => {
    const layered = layerSpans([span("Build", 0, 10), span("DeployStaging", null, null), span("DeployProd", 12, 20)]);
    expect(keysOf(layered.layers)).toEqual([["Build"], ["DeployStaging"], ["DeployProd"]]);
    expect(layered.edges).toEqual([edge("Build", "DeployStaging"), edge("DeployStaging", "DeployProd")]);
  });

  /** The barrier rule breaks transitivity — J and I overlap outright, yet J → K → I — so the
   *  closure has to be computed for the depths and the covers to be right. */
  it("computes the closure the barrier rule needs", () => {
    const layered = layerSpans([span("J", 0, 100), span("K", null, null), span("I", 50, 60)]);
    expect(keysOf(layered.layers)).toEqual([["J"], ["K"], ["I"]]);
    expect(layered.edges).toEqual([edge("J", "K"), edge("K", "I")]);
  });

  it("places queued work behind what was declared before it, in order", () => {
    const layered = layerSpans([span("Build", 0, 10), span("Test", null, null), span("Ship", null, null)]);
    expect(keysOf(layered.layers)).toEqual([["Build"], ["Test"], ["Ship"]]);
  });

  it("handles nothing", () => {
    expect(layerSpans([])).toEqual({ layers: [], edges: [], branched: false });
  });
});

describe("layerDeclared", () => {
  const refs: Record<string, string | null> = { s1: "Build", s2: "Test", s3: "Lint", s4: "Deploy" };
  const refOf = (key: string) => refs[key] ?? null;

  it("lays stages out by the longest chain of dependsOn, reduced", () => {
    const deps = new Map([
      ["build", []],
      ["test", ["build"]],
      ["lint", ["build"]],
      ["deploy", ["test", "lint"]],
    ]);
    const layered = layerDeclared(["s1", "s2", "s3", "s4"], refOf, deps)!;
    expect(keysOf(layered.layers)).toEqual([["s1"], ["s2", "s3"], ["s4"]]);
    expect(layered.edges).toEqual([edge("s1", "s2"), edge("s1", "s3"), edge("s2", "s4"), edge("s3", "s4")]);
    expect(layered.branched).toBe(true);
  });

  it("pushes a stage one column past the deepest thing it waits on", () => {
    const deps = new Map([
      ["build", []],
      ["test", ["build"]],
      ["lint", ["test"]],
      ["deploy", ["build", "lint"]],
    ]);
    const layered = layerDeclared(["s1", "s2", "s3", "s4"], refOf, deps)!;
    expect(keysOf(layered.layers)).toEqual([["s1"], ["s2"], ["s3"], ["s4"]]);
    // build → deploy is implied by the chain and not drawn.
    expect(layered.edges).toEqual([edge("s1", "s2"), edge("s2", "s3"), edge("s3", "s4")]);
  });

  it("does not draw a dependency on a stage this run pruned", () => {
    const layered = layerDeclared(["s1", "s2"], refOf, new Map([["build", []], ["test", ["build", "gone"]]]))!;
    expect(keysOf(layered.layers)).toEqual([["s1"], ["s2"]]);
  });

  it("matches ref names without regard to case, as Azure does", () => {
    const layered = layerDeclared(["s1", "s2"], (key) => (key === "s1" ? "BUILD" : "test"), new Map([["build", []], ["test", ["build"]]]));
    expect(layered?.edges).toEqual([edge("s1", "s2")]);
  });

  it("refuses — never a partial layering — when the file doesn't describe this run", () => {
    const deps = new Map([["build", []], ["test", ["build"]]]);
    expect(layerDeclared([], refOf, deps)).toBeNull();
    // A stage without a ref name has nothing to join on.
    expect(layerDeclared(["s1", "x"], refOf, deps)).toBeNull();
    // A stage the file doesn't cover sends the whole board back to the clocks.
    expect(layerDeclared(["s1", "s2", "s3"], refOf, deps)).toBeNull();
    // Two cards under one ref name.
    expect(layerDeclared(["a", "b"], () => "Build", deps)).toBeNull();
    // A cycle means the file read is not the file that ran.
    expect(layerDeclared(["s1", "s2"], refOf, new Map([["build", ["test"]], ["test", ["build"]]]))).toBeNull();
  });
});

describe("parseAzureStages", () => {
  it("gives an omitted dependsOn the stage written above it, and the first stage nothing", () => {
    const parsed = parseAzureStages(`
stages:
- stage: Build
- stage: Test
- stage: Deploy
`)!;
    expect(parsed.deps).toEqual(new Map([["build", []], ["test", ["build"]], ["deploy", ["test"]]]));
  });

  it("reads an empty dependsOn — written either way — as 'start immediately'", () => {
    const parsed = parseAzureStages(`
stages:
- stage: Build
- stage: Lint
  dependsOn: []
- stage: Docs
  dependsOn:
`)!;
    expect(parsed.deps.get("lint")).toEqual([]);
    expect(parsed.deps.get("docs")).toEqual([]);
  });

  it("keys everything lower-case and takes a single dependency as a string", () => {
    const parsed = parseAzureStages(`
stages:
- stage: Build
- stage: Deploy
  dependsOn: BUILD
`)!;
    expect(parsed.deps.get("deploy")).toEqual(["build"]);
  });

  it("omits every stage whose dependencies can't be known, rather than guessing", () => {
    const parsed = parseAzureStages(`
stages:
- stage: Build
- template: stages/test.yml
- stage: AfterTemplate
- stage: Expression
  dependsOn: \${{ parameters.after }}
- stage: PartlyReadable
  dependsOn: [Build, 3]
- stage: Fine
  dependsOn: [Build]
`)!;
    // The entry after a template would have inherited from something unnamed.
    expect(parsed.deps.has("aftertemplate")).toBe(false);
    expect(parsed.deps.has("expression")).toBe(false);
    // A partly-unreadable list is not a shorter list.
    expect(parsed.deps.has("partlyreadable")).toBe(false);
    expect(parsed.deps.get("fine")).toEqual(["build"]);
  });

  it("collects the job names each stage declares, preferring what Azure would display", () => {
    const parsed = parseAzureStages(`
stages:
- stage: Deploy
  jobs:
  - deployment: DeployWeb
    displayName: Deploy the web app
  - job: Smoke
  - job: \${{ parameters.dynamic }}
`)!;
    expect(parsed.jobs.get("deploy")).toEqual(["Deploy the web app", "Smoke"]);
  });

  it("answers null for anything that is not a stage-shaped pipeline", () => {
    expect(parseAzureStages("stages: [unclosed")).toBeNull();
    expect(parseAzureStages("jobs:\n- job: Only\n")).toBeNull();
    expect(parseAzureStages("plain text")).toBeNull();
    expect(parseAzureStages("stages:\n- template: all.yml\n")).toBeNull();
  });
});

describe("orderLayers", () => {
  it("swaps two cards to take a crossing out", () => {
    const ordered = orderLayers([["a", "b"], ["c", "d"]], [edge("a", "d"), edge("b", "c")]);
    expect(ordered).toEqual([["a", "b"], ["d", "c"]]);
  });

  it("leaves declaration order alone when nothing crosses", () => {
    const layers = [["a", "b"], ["c", "d"]];
    expect(orderLayers(layers, [edge("a", "c"), edge("b", "d")])).toEqual(layers);
  });

  it("ignores long arrows, which are routed under the board and cross nothing", () => {
    const layers = [["a", "b"], ["c"], ["d", "e"]];
    expect(orderLayers(layers, [edge("a", "e"), edge("b", "d")])).toEqual(layers);
  });

  it("returns copies, never the arrays it was handed", () => {
    const layers = [["a"]];
    const ordered = orderLayers(layers, []);
    expect(ordered).toEqual(layers);
    expect(ordered[0]).not.toBe(layers[0]);
  });
});
