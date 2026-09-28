import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineArtifact, PipelineJob, PipelineRun, PipelineRunDetail } from "../types/domain";

/**
 * The Pipelines tab's store, against a fake backend.
 *
 * What these hold down: the keys that keep one repository's `#42` from lighting up another's; the
 * merge that keeps a "passed with warnings" row amber across polls; the rule that a poll re-selecting
 * the open run must not take the user's job away; the refresh a re-run under the same id needs; the
 * notifications that fire on a *transition* and never on a first sighting; and the new flows — a
 * started run found and opened, and a download followed from its first byte to its end.
 */

const calls: { name: string; args: Record<string, unknown> }[] = [];
let answers: Record<string, (args: Record<string, unknown>) => unknown> = {};
let progress: ((event: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (!answer) return Promise.resolve(null);
    try {
      return Promise.resolve(answer(args));
    } catch (error) {
      return Promise.reject(error);
    }
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "ci:artifact") progress = handler;
    return Promise.resolve(() => {});
  },
}));

const notify = vi.fn();
vi.mock("./notificationStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notificationStore")>()),
  notify: (input: unknown) => notify(input),
}));

const {
  useCiStore,
  runKey,
  artifactKey,
  pickInterestingJob,
  selectedDetail,
  selectedDetailBusy,
  selectedDetailError,
  selectedJobKey,
  findDispatchedRun,
  DISPATCH_ATTEMPTS,
  DISPATCH_POLL_MS,
} = await import("./ciStore");
const { useWorkspaceStore } = await import("./workspaceStore");

const INITIAL = useCiStore.getState();
const named = (name: string) => calls.filter((call) => call.name === name);

function run(id: string, over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "github",
    id,
    number: Number(id),
    name: "CI",
    status: "success",
    raw_status: "success",
    branch: "main",
    commit_sha: "abc1234def",
    commit_title: "fix the thing",
    actor: null,
    event: "push",
    created_at: "2026-09-01T10:00:00Z",
    started_at: "2026-09-01T10:00:05Z",
    finished_at: "2026-09-01T10:05:00Z",
    web_url: `https://github.com/example-org/example-repo/actions/runs/${id}`,
    definition_path: ".github/workflows/ci.yml",
    gated: false,
    ...over,
  };
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

function detail(of: PipelineRun, jobs: PipelineJob[]): PipelineRunDetail {
  return { run: of, jobs, stages: [], gates: [] };
}

beforeEach(() => {
  calls.length = 0;
  answers = {};
  notify.mockClear();
  useCiStore.setState(INITIAL, true);
  useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("keys", () => {
  it("carry the project and the provider, because run ids repeat across both", () => {
    expect(runKey("p-1", { provider: "gitlab", id: "42" })).toBe("p-1:gitlab:42");
    expect(artifactKey("p-1", { provider: "azure", id: "42" }, "7")).toBe("p-1:azure:42:7");
  });
});

describe("pickInterestingJob", () => {
  it("opens a run on the reason anybody opened it", () => {
    const jobs = [job("ok"), job("warn", { status: "warning" }), job("live", { status: "running" }), job("bad", { status: "failed" })];
    expect(pickInterestingJob(jobs)?.id).toBe("bad");
    expect(pickInterestingJob(jobs.slice(0, 3))?.id).toBe("live");
    expect(pickInterestingJob(jobs.slice(0, 2))?.id).toBe("warn");
    expect(pickInterestingJob([job("first"), job("second")])?.id).toBe("first");
    expect(pickInterestingJob([])).toBeUndefined();
  });
});

describe("selectors", () => {
  it("answer for the selected run only", () => {
    const key = "p-1:github:7";
    useCiStore.setState({
      selection: { projectId: "p-1", runId: "7", provider: "github", jobId: "j" },
      detailByRun: { [key]: detail(run("7"), [job("j")]) },
      detailBusy: { [key]: true },
      detailError: { [key]: "boom" },
    });
    const state = useCiStore.getState();
    expect(selectedDetail(state)?.run.id).toBe("7");
    expect(selectedDetailBusy(state)).toBe(true);
    expect(selectedDetailError(state)).toBe("boom");
    expect(selectedJobKey(state)).toBe("p-1:github:7:j");

    useCiStore.setState({ selection: null });
    const none = useCiStore.getState();
    expect(selectedDetail(none)).toBeUndefined();
    expect(selectedDetailBusy(none)).toBe(false);
    expect(selectedDetailError(none)).toBe("");
    expect(selectedJobKey(none)).toBeNull();
  });
});

describe("load", () => {
  it("keeps the detail's verdict over the list's while the provider's own word hasn't changed", async () => {
    // The list can't reach "passed with warnings"; the opened run did.
    const refined = run("7", { status: "warning" });
    useCiStore.setState({ detailByRun: { "p-1:github:7": detail(refined, []) } });
    answers.list_pipeline_runs = () => [run("7"), run("8")];

    await useCiStore.getState().load("p-1");
    expect(useCiStore.getState().runsByProject["p-1"].map((r) => r.status)).toEqual(["warning", "success"]);

    // A re-run of the same id finishes at another time: the list's copy wins again.
    answers.list_pipeline_runs = () => [run("7", { finished_at: "2026-09-01T11:00:00Z" })];
    await useCiStore.getState().load("p-1");
    expect(useCiStore.getState().runsByProject["p-1"][0].status).toBe("success");
  });

  it("keeps an Azure run's gate flag, which only the opened run can know", async () => {
    const opened = run("9", { provider: "azure", status: "running", raw_status: "inProgress", finished_at: null, gated: true });
    useCiStore.setState({ detailByRun: { "p-1:azure:9": detail(opened, []) } });
    answers.list_pipeline_runs = () => [run("9", { provider: "azure", status: "running", raw_status: "inProgress", finished_at: null })];
    await useCiStore.getState().load("p-1");
    expect(useCiStore.getState().runsByProject["p-1"][0].gated).toBe(true);
  });

  it("accumulates the branches it has seen, so narrowing never eats the picker's options", async () => {
    answers.list_pipeline_runs = () => [run("1", { branch: "main" }), run("2", { branch: "release/1.4" })];
    await useCiStore.getState().load("p-1");
    const first = useCiStore.getState().branchesSeenByProject["p-1"];
    expect(first).toEqual(["main", "release/1.4"]);

    answers.list_pipeline_runs = () => [run("2", { branch: "release/1.4" })];
    await useCiStore.getState().load("p-1");
    // Nothing new: the same array, so the picker doesn't re-render on every poll.
    expect(useCiStore.getState().branchesSeenByProject["p-1"]).toBe(first);
  });

  // A project of its own: what has already been announced is module state, and outlives a test.
  it("announces a run that finished, never one seen for the first time", async () => {
    answers.list_pipeline_runs = () => [run("1", { status: "running", finished_at: null }), run("2", { status: "failed" })];
    await useCiStore.getState().load("p-announce");
    // First sightings, including a year-old failure: silent.
    expect(notify).not.toHaveBeenCalled();

    useWorkspaceStore.setState({ activeWorkspaceId: "ws-1" } as never);
    answers.list_pipeline_runs = () => {
      // The user switches workspace while the poll is in flight; the row belongs to the old one.
      useWorkspaceStore.setState({ activeWorkspaceId: "ws-2" } as never);
      return [run("1", { status: "failed" }), run("2", { status: "failed" })];
    };
    await useCiStore.getState().load("p-announce");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({
      source: "ci",
      workspaceId: "ws-1",
      status: "error",
      titleKey: "pipelines.notifyFailed",
      target: { view: "pipelines", projectId: "p-announce", select: { kind: "pipelineRun", id: "p-announce:github:1" } },
    });
  });

  it("does not announce a run that only started moving", async () => {
    answers.list_pipeline_runs = () => [run("1", { status: "queued", finished_at: null })];
    await useCiStore.getState().load("p-moving");
    answers.list_pipeline_runs = () => [run("1", { status: "running", finished_at: null })];
    await useCiStore.getState().load("p-moving");
    expect(notify).not.toHaveBeenCalled();
  });

  it("remembers a failure without a spinner when quiet", async () => {
    answers.list_pipeline_runs = () => {
      throw "GitHub didn't answer in time";
    };
    const loading = useCiStore.getState().load("p-1", { quiet: true });
    expect(useCiStore.getState().loadingProjectId).toBeNull();
    await loading;
    expect(useCiStore.getState().errorByProject["p-1"]).toBe("GitHub didn't answer in time");
    expect(useCiStore.getState().fetchedProjects["p-1"]).toBe(true);
  });
});

describe("selectRun", () => {
  it("keeps the job the user chose when the poll re-selects the open run", async () => {
    const live = run("7", { status: "running", finished_at: null });
    answers.pipeline_run_detail = () => detail(live, [job("a", { status: "failed" }), job("b")]);
    await useCiStore.getState().selectRun("p-1", live);
    // Opened on the failure.
    expect(useCiStore.getState().selection?.jobId).toBe("a");

    await useCiStore.getState().selectJob("b");
    await useCiStore.getState().selectRun("p-1", live);
    expect(useCiStore.getState().selection?.jobId).toBe("b");
  });

  it("does not re-read a finished run it already has", async () => {
    const done = run("7");
    useCiStore.setState({ detailByRun: { "p-1:github:7": detail(done, [job("a")]) } });
    await useCiStore.getState().selectRun("p-1", done);
    expect(named("pipeline_run_detail")).toHaveLength(0);
  });

  it("re-reads it when asked to — a gate was just answered", async () => {
    const done = run("7");
    useCiStore.setState({ detailByRun: { "p-1:github:7": detail(done, [job("a")]) } });
    answers.pipeline_run_detail = () => detail(done, [job("a")]);
    await useCiStore.getState().selectRun("p-1", done, { refresh: true });
    expect(named("pipeline_run_detail")).toHaveLength(1);
  });

  /** GitHub's re-run keeps the run's id. The cache said "finished" and every poll trusted it, so
   *  the second attempt played out behind the first one's jobs. */
  it("re-reads a finished run the list says is moving again", async () => {
    useCiStore.setState({ detailByRun: { "p-1:github:7": detail(run("7"), [job("a")]) } });
    answers.pipeline_run_detail = () => detail(run("7", { status: "queued", finished_at: null }), [job("a", { status: "queued" })]);
    await useCiStore.getState().selectRun("p-1", run("7", { status: "queued", finished_at: null }));
    expect(named("pipeline_run_detail")).toHaveLength(1);
    expect(useCiStore.getState().detailByRun["p-1:github:7"].run.status).toBe("queued");
  });

  it("corrects the list's copy of the run from the detail", async () => {
    useCiStore.setState({ runsByProject: { "p-1": [run("7"), run("8")] } });
    answers.pipeline_run_detail = () => detail(run("7", { status: "warning" }), [job("a")]);
    await useCiStore.getState().selectRun("p-1", run("7"));
    expect(useCiStore.getState().runsByProject["p-1"].map((r) => r.status)).toEqual(["warning", "success"]);
  });

  it("records why a run couldn't be read", async () => {
    answers.pipeline_run_detail = () => {
      throw "gone";
    };
    await useCiStore.getState().selectRun("p-1", run("7"));
    expect(useCiStore.getState().detailError["p-1:github:7"]).toBe("gone");
    expect(useCiStore.getState().detailBusy["p-1:github:7"]).toBe(false);
  });
});

describe("openByKey", () => {
  it("opens a run by the key a notification carries, fetching the list when it isn't there", async () => {
    answers.list_pipeline_runs = () => [run("7")];
    answers.pipeline_run_detail = () => detail(run("7"), [job("a")]);
    await useCiStore.getState().openByKey("p-1:github:7");
    expect(named("list_pipeline_runs")).toHaveLength(1);
    expect(useCiStore.getState().selection).toMatchObject({ projectId: "p-1", runId: "7", provider: "github" });
  });
});

describe("setBranchFilter", () => {
  it("refetches from the host with the branch, per project", async () => {
    answers.list_pipeline_runs = () => [];
    useCiStore.getState().setBranchFilter("p-1", "release/2.0");
    await vi.waitFor(() => expect(named("list_pipeline_runs")).toHaveLength(1));
    expect(named("list_pipeline_runs")[0].args).toMatchObject({ projectId: "p-1", branch: "release/2.0" });
    expect(useCiStore.getState().branchFilterByProject).toEqual({ "p-1": "release/2.0" });
  });
});

describe("findDispatchedRun", () => {
  const since = Date.parse("2026-09-01T10:00:00Z");
  const dispatched = (id: string, over: Partial<PipelineRun> = {}) =>
    run(id, { event: "workflow_dispatch", created_at: "2026-09-01T10:00:03Z", ...over });

  it("finds the new workflow_dispatch run of that workflow on that ref", () => {
    const runs = [
      dispatched("10", { branch: "other" }),
      dispatched("11", { definition_path: ".github/workflows/other.yml" }),
      run("12", { created_at: "2026-09-01T10:00:04Z" }),
      dispatched("13"),
    ];
    expect(findDispatchedRun(runs, new Set(), { ref: "refs/heads/main", path: ".github/workflows/ci.yml", since })?.id).toBe("13");
  });

  it("never picks a run that was on the list before the click, or one from long before it", () => {
    const runs = [dispatched("13"), dispatched("9", { created_at: "2026-09-01T09:50:00Z" })];
    expect(findDispatchedRun(runs, new Set(["13"]), { ref: "main", path: null, since })).toBeUndefined();
  });

  it("matches a run whose path names the ref it was read at", () => {
    const runs = [dispatched("15", { definition_path: ".github/workflows/ci.yml@main" })];
    expect(findDispatchedRun(runs, new Set(), { ref: "main", path: ".github/workflows/ci.yml", since })?.id).toBe("15");
  });

  it("takes the newest when several qualify", () => {
    const runs = [dispatched("13", { created_at: "2026-09-01T10:00:03Z" }), dispatched("14", { created_at: "2026-09-01T10:00:09Z" })];
    expect(findDispatchedRun(runs, new Set(), { ref: "main", path: null, since })?.id).toBe("14");
  });
});

describe("startRun", () => {
  const request = { definition_id: "161335", ref: "main", inputs: { dry_run: true }, variables: [] };

  it("opens the run the host says it started", async () => {
    answers.start_pipeline = () => ({ run_id: "30433642", web_url: null });
    answers.list_pipeline_runs = () => [run("30433642", { status: "queued", finished_at: null })];
    answers.pipeline_run_detail = () => detail(run("30433642", { status: "queued", finished_at: null }), [job("a")]);

    const id = await useCiStore.getState().startRun("p-1", "github", request, ".github/workflows/ci.yml");
    expect(id).toBe("30433642");
    expect(named("start_pipeline")[0].args).toEqual({ projectId: "p-1", request });
    expect(useCiStore.getState().selection).toMatchObject({ runId: "30433642", provider: "github" });
  });

  it("finds a run the host started without naming it, and opens it", async () => {
    vi.useFakeTimers();
    useCiStore.setState({ runsByProject: { "p-1": [run("5")] } });
    answers.start_pipeline = () => ({ run_id: null, web_url: null });
    let listed = 0;
    answers.list_pipeline_runs = () => {
      listed += 1;
      // Not on the first look — a runner queue takes a moment.
      return listed < 2
        ? [run("5")]
        : [run("5"), run("6", { event: "workflow_dispatch", created_at: new Date().toISOString() })];
    };
    answers.pipeline_run_detail = () => detail(run("6"), [job("a")]);

    const id = await useCiStore.getState().startRun("p-1", "github", request, ".github/workflows/ci.yml");
    expect(id).toBeNull();
    for (let tick = 0; tick < DISPATCH_ATTEMPTS && useCiStore.getState().selection?.runId !== "6"; tick += 1) {
      await vi.advanceTimersByTimeAsync(DISPATCH_POLL_MS);
    }
    expect(useCiStore.getState().selection?.runId).toBe("6");
    // Looked up by the ref, not through the filter on screen.
    expect(named("list_pipeline_runs").some((call) => call.args.branch === "main")).toBe(true);
  });

  it("does not pull the pane away from a run the user opened in the meantime", async () => {
    vi.useFakeTimers();
    answers.start_pipeline = () => ({ run_id: null, web_url: null });
    answers.list_pipeline_runs = () => [run("6", { event: "workflow_dispatch", created_at: new Date().toISOString() })];
    answers.pipeline_run_detail = () => detail(run("3"), [job("a")]);

    await useCiStore.getState().startRun("p-1", "github", request, null);
    await useCiStore.getState().selectRun("p-1", run("3"));
    await vi.advanceTimersByTimeAsync(DISPATCH_POLL_MS * DISPATCH_ATTEMPTS);
    expect(useCiStore.getState().selection?.runId).toBe("3");
  });

  it("passes the host's refusal to the caller", async () => {
    answers.start_pipeline = () => {
      throw "GitHub returned 422 Unprocessable Entity: Required input 'environment' not provided";
    };
    await expect(useCiStore.getState().startRun("p-1", "github", request, null)).rejects.toContain("Required input");
  });
});

describe("artifacts", () => {
  const artifact: PipelineArtifact = {
    provider: "github",
    run_id: "7",
    id: "11",
    name: "dist",
    size_bytes: 1000,
    expires_at: null,
    expired: false,
    job_name: null,
    file_name: "dist.zip",
  };
  const theRun = { provider: "github" as const, id: "7" };
  const key = "p-1:github:7:11";

  it("lists a run's artifacts, and says why it couldn't", async () => {
    answers.list_pipeline_artifacts = () => [artifact];
    await useCiStore.getState().loadArtifacts("p-1", theRun);
    expect(useCiStore.getState().artifactsByRun["p-1:github:7"]).toEqual([artifact]);

    answers.list_pipeline_artifacts = () => {
      throw "no scope";
    };
    await useCiStore.getState().loadArtifacts("p-1", theRun);
    expect(useCiStore.getState().artifactsError["p-1:github:7"]).toBe("no scope");
    expect(useCiStore.getState().artifactsBusy["p-1:github:7"]).toBe(false);
  });

  it("follows a download from its first progress event to its end", async () => {
    let finish: (bytes: number) => void = () => {};
    answers.download_pipeline_artifact = () => new Promise<number>((resolve) => (finish = resolve));

    const downloading = useCiStore.getState().downloadArtifact("p-1", theRun, artifact, "/tmp/dist.zip");
    const started = useCiStore.getState().downloads[key];
    expect(started).toMatchObject({ state: "running", done: 0, total: 1000, path: "/tmp/dist.zip" });
    expect(named("download_pipeline_artifact")[0].args).toMatchObject({
      projectId: "p-1",
      runId: "7",
      artifactId: "11",
      destination: "/tmp/dist.zip",
      transferId: started.transferId,
    });

    // Progress for somebody else's transfer is not ours.
    progress?.({ payload: { id: "other", done: 999, total: 1000 } });
    progress?.({ payload: { id: started.transferId, done: 400, total: 1000 } });
    expect(useCiStore.getState().downloads[key].done).toBe(400);

    finish(1000);
    await downloading;
    expect(useCiStore.getState().downloads[key]).toMatchObject({ state: "done", done: 1000, total: 1000 });

    // A late progress event must not reopen a finished row.
    progress?.({ payload: { id: started.transferId, done: 10, total: 1000 } });
    expect(useCiStore.getState().downloads[key].state).toBe("done");
  });

  it("ignores a second click on a download that is running", async () => {
    answers.download_pipeline_artifact = () => new Promise<number>(() => {});
    void useCiStore.getState().downloadArtifact("p-1", theRun, artifact, "/tmp/a.zip");
    await useCiStore.getState().downloadArtifact("p-1", theRun, artifact, "/tmp/b.zip");
    expect(named("download_pipeline_artifact")).toHaveLength(1);
  });

  it("reports a stopped download as stopped, not failed", async () => {
    let fail: (reason: string) => void = () => {};
    answers.download_pipeline_artifact = () => new Promise<number>((_, reject) => (fail = reject));
    answers.cancel_pipeline_artifact_download = () => null;

    const downloading = useCiStore.getState().downloadArtifact("p-1", theRun, artifact, "/tmp/dist.zip");
    const transferId = useCiStore.getState().downloads[key].transferId;
    useCiStore.getState().cancelDownload(key);
    expect(named("cancel_pipeline_artifact_download")[0].args).toEqual({ transferId });

    fail("download cancelled");
    await downloading;
    expect(useCiStore.getState().downloads[key]).toMatchObject({ state: "cancelled" });
    expect(useCiStore.getState().downloads[key].error).toBeUndefined();
  });

  it("keeps a failure's reason and hands it to the caller", async () => {
    answers.download_pipeline_artifact = () => {
      throw "GitHub no longer has that artifact — it expired or was deleted";
    };
    await expect(useCiStore.getState().downloadArtifact("p-1", theRun, artifact, "/tmp/dist.zip")).rejects.toContain("expired");
    expect(useCiStore.getState().downloads[key]).toMatchObject({ state: "failed", error: expect.stringContaining("expired") });
  });
});
