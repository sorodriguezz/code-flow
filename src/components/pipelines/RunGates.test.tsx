import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PipelineGate, PipelineRun, PipelineRunDetail } from "../../types/domain";

/**
 * The strip that says what a run is waiting on. Rendered on the server (there is no DOM here), so
 * this checks what is drawn and what can be pressed, not what pressing does — that half is the
 * store's and the backend's, and is tested there.
 */

vi.mock("../../state/languageStore", () => ({ useT: () => (key: string) => key }));

import { RunGates } from "./RunGates";

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
    started_at: null,
    finished_at: null,
    web_url: "https://github.com/example-org/example-repo/actions/runs/7",
    definition_path: null,
    gated: true,
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
    web_url: "https://github.com/example-org/example-repo/actions/runs/7",
    ...over,
  };
}

function draw(gates: PipelineGate[], over: Partial<PipelineRun> = {}): string {
  const detail: PipelineRunDetail = { run: run(over), jobs: [], stages: [], gates };
  return renderToStaticMarkup(<RunGates projectId="p-1" detail={detail} />);
}

/** Whether the `<button>` whose text ends in `label` carries the `disabled` attribute — the
 *  attribute itself, not the `disabled:` variants in its class list. */
function isDisabled(markup: string, label: string): boolean {
  const at = markup.indexOf(`${label}</button>`);
  expect(at, `no button labelled ${label}`).toBeGreaterThan(-1);
  const opening = markup.slice(markup.lastIndexOf("<button", at));
  return /^<button[^>]*\sdisabled=""/.test(opening);
}

describe("RunGates", () => {
  it("draws nothing for a run that isn't waiting", () => {
    expect(draw([], { gated: false })).toBe("");
  });

  it("offers approve and reject on an approval the user may answer", () => {
    const markup = draw([gate({ reviewers: ["octocat"] })]);
    expect(markup).toContain("pipelines.gateApproval");
    expect(markup).toContain("production");
    expect(isDisabled(markup, "pipelines.gateApprove")).toBe(false);
    expect(isDisabled(markup, "pipelines.gateReject")).toBe(false);
  });

  it("keeps the buttons but disables them for someone who isn't a reviewer", () => {
    const markup = draw([gate({ can_act: false })]);
    expect(isDisabled(markup, "pipelines.gateApprove")).toBe(true);
    expect(isDisabled(markup, "pipelines.gateReject")).toBe(true);
  });

  it("offers play on a manual job and nothing on a check", () => {
    const manual = draw([gate({ provider: "gitlab", kind: "manual", name: "deploy-prod", id: "9" })], { provider: "gitlab" });
    expect(manual).toContain("pipelines.gateManual");
    expect(isDisabled(manual, "pipelines.gatePlay")).toBe(false);
    expect(manual).not.toContain("pipelines.gateApprove");

    const check = draw([gate({ provider: "azure", kind: "check", name: "Business hours", can_act: false })], { provider: "azure" });
    expect(check).toContain("pipelines.gateCheck");
    expect(check).not.toContain(">pipelines.gateApprove<");
    expect(check).not.toContain(">pipelines.gatePlay<");
  });

  it("still says the run waits when its gates couldn't be read, and links to the host", () => {
    const markup = draw([]);
    expect(markup).toContain("pipelines.gateApproval");
    expect(markup).toContain('aria-label="pipelines.openOnHost"');
    expect(markup).not.toContain(">pipelines.gateApprove<");
  });

  it("puts what can be answered first", () => {
    const markup = draw([
      gate({ id: "c", kind: "check", name: "Wait timer", can_act: false }),
      gate({ id: "m", kind: "manual", name: "smoke" }),
      gate({ id: "a", kind: "approval", name: "production" }),
    ]);
    const approval = markup.indexOf("production");
    const manual = markup.indexOf("smoke");
    const check = markup.indexOf("Wait timer");
    expect(approval).toBeLessThan(manual);
    expect(manual).toBeLessThan(check);
  });
});
