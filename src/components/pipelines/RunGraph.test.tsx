import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PipelineGate, PipelineJob, PipelineRun, PipelineRunDetail, PipelineStage } from "../../types/domain";

/**
 * The graph marks what a gate is holding, in both drawings and on every provider's shape: the job
 * a GitHub environment is holding, and the stage card (with no jobs yet) an Azure approval is.
 */

vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string) => key,
  useLanguageStore: (select: (s: { language: string }) => unknown) => select({ language: "en" }),
}));

import { RunGraph } from "./RunGraph";

const HELD = 'title="pipelines.heldHint"';
const count = (markup: string, needle: string) => markup.split(needle).length - 1;

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    provider: "github",
    id: "7",
    number: 7,
    name: "Deploy",
    status: "queued",
    raw_status: "waiting",
    branch: "main",
    commit_sha: "abc1234",
    commit_title: null,
    actor: null,
    event: "push",
    created_at: "2026-09-01T10:00:00Z",
    started_at: "2026-09-01T10:00:00Z",
    finished_at: null,
    web_url: "",
    definition_path: null,
    gated: true,
    ...over,
  };
}

function job(id: string, over: Partial<PipelineJob> = {}): PipelineJob {
  return {
    provider: "github",
    run_id: "7",
    id,
    name: id,
    stage: null,
    stage_id: null,
    status: "success",
    raw_status: "success",
    started_at: "2026-09-01T10:00:05Z",
    finished_at: "2026-09-01T10:01:00Z",
    web_url: "",
    log_ref: null,
    ...over,
  };
}

function gate(over: Partial<PipelineGate>): PipelineGate {
  return {
    provider: "github",
    run_id: "7",
    id: "1",
    kind: "approval",
    name: "production",
    stage_id: null,
    job_ids: [],
    can_act: true,
    reviewers: [],
    instructions: null,
    since: null,
    web_url: "",
    ...over,
  };
}

function draw(detail: PipelineRunDetail): string {
  return renderToStaticMarkup(
    <RunGraph projectId="p-1" localPath={null} detail={detail} loading={false} error="" now={Date.parse("2026-09-01T10:05:00Z")} />,
  );
}

describe("RunGraph", () => {
  it("marks the one job a GitHub environment is holding, and no other", () => {
    const markup = draw({
      run: run(),
      jobs: [job("build"), job("deploy", { status: "queued", raw_status: "waiting", started_at: null, finished_at: null })],
      stages: [],
      gates: [gate({ job_ids: ["deploy"] })],
    });
    expect(count(markup, HELD)).toBe(1);
  });

  it("marks the stage card an Azure approval is holding, before it has any jobs", () => {
    const stage = (id: string, name: string, status: PipelineStage["status"]): PipelineStage => ({
      provider: "azure",
      run_id: "42",
      id,
      name,
      ref_name: null,
      status,
      raw_status: status === "running" ? "inProgress" : "completed",
      started_at: "2026-09-01T10:00:00Z",
      finished_at: status === "running" ? null : "2026-09-01T10:02:00Z",
    });
    const markup = draw({
      run: run({ provider: "azure", id: "42" }),
      jobs: [
        job("compile", { provider: "azure", run_id: "42", stage: "Build", stage_id: "stage-build" }),
        // The placeholder the backend draws for a stage with no jobs yet: it shares the stage's id.
        job("stage-prod", {
          provider: "azure",
          run_id: "42",
          name: "Deploy prod",
          stage: "Deploy prod",
          stage_id: "stage-prod",
          status: "running",
          started_at: "2026-09-01T10:02:05Z",
          finished_at: null,
        }),
      ],
      stages: [stage("stage-build", "Build", "success"), stage("stage-prod", "Deploy prod", "running")],
      gates: [gate({ provider: "azure", run_id: "42", id: "aab27959-a5be-4ee3-97ca-f19b3602cd2f", stage_id: "stage-prod", name: "Deploy prod" })],
    });
    expect(markup).toContain("Deploy prod");
    expect(count(markup, HELD)).toBe(1);
  });

  it("marks nothing on a run that isn't waiting", () => {
    const markup = draw({ run: run({ gated: false }), jobs: [job("build"), job("test")], stages: [], gates: [] });
    expect(count(markup, HELD)).toBe(0);
  });
});
