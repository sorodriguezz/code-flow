import { describe, expect, it } from "vitest";
import {
  MASK,
  confirmationLines,
  parseAzureParameters,
  parseDispatchInputs,
  parseGitlabRunSpec,
  refChoices,
  runValues,
  validateFields,
  validateVariables,
  variablesToSend,
  type RunField,
  type VariableRow,
} from "./runInputs";
import { gateHolds, isHeld, orderGates } from "./gates";
import { formatSize } from "./pipelineStatus";
import type { BranchInfo, PipelineGate } from "../../types/domain";

/**
 * The "Run pipeline" form is worked out from the pipeline's own file, and a wrong reading is a run
 * started with the wrong values — or a run refused by the host with a message that names neither
 * the input nor the rule. These cover every input type each host declares, and the files that are
 * not what they claim to be.
 */

const WORKFLOW = `
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      logLevel:
        description: Log level
        required: true
        default: warning
        type: choice
        options: [info, warning, debug]
      dry_run:
        description: Only print what would change
        type: boolean
        default: true
      replicas:
        type: number
        default: 3
      target:
        description: Where to deploy
        type: environment
        required: true
      notes:
        description: Free text
      bare:
jobs:
  deploy:
    runs-on: ubuntu-latest
`;

describe("parseDispatchInputs", () => {
  it("reads every input type a workflow can declare", () => {
    const spec = parseDispatchInputs(WORKFLOW);
    expect(spec.kind).toBe("dispatch");
    if (spec.kind !== "dispatch") return;
    const byName = Object.fromEntries(spec.fields.map((field) => [field.name, field]));

    expect(byName.logLevel).toEqual({
      name: "logLevel",
      description: "Log level",
      type: "choice",
      required: true,
      initial: "warning",
      options: ["info", "warning", "debug"],
    });
    expect(byName.dry_run).toMatchObject({ type: "boolean", initial: "true", required: false });
    expect(byName.replicas).toMatchObject({ type: "number", initial: "3" });
    expect(byName.target).toMatchObject({ type: "environment", required: true, initial: "", options: [] });
    // No `type:` is a string; an input with nothing under it is an optional, untyped string.
    expect(byName.notes).toMatchObject({ type: "string", description: "Free text", required: false });
    expect(byName.bare).toMatchObject({ type: "string", description: null, required: false, initial: "" });
    // Declaration order, which is the order GitHub's own form uses.
    expect(spec.fields.map((field) => field.name)).toEqual(["logLevel", "dry_run", "replicas", "target", "notes", "bare"]);
  });

  it("starts a choice with no default on its first option, like GitHub's form", () => {
    const spec = parseDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      size:
        type: choice
        options: [small, large]
jobs: { a: {} }
`);
    expect(spec.kind === "dispatch" && spec.fields[0].initial).toBe("small");
  });

  it("accepts a boolean default written as text", () => {
    const spec = parseDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      force: { type: boolean, default: "true" }
      quiet: { type: boolean, default: "false" }
      unset: { type: boolean }
jobs: { a: {} }
`);
    expect(spec.kind === "dispatch" && spec.fields.map((field) => field.initial)).toEqual(["true", "false", "false"]);
  });

  it("finds the trigger in each of the three ways it can be written", () => {
    expect(parseDispatchInputs("on: workflow_dispatch\njobs: { a: {} }")).toEqual({ kind: "dispatch", fields: [] });
    expect(parseDispatchInputs("on: [push, workflow_dispatch]\njobs: { a: {} }")).toEqual({ kind: "dispatch", fields: [] });
    // `workflow_dispatch:` alone is YAML null, and means "no inputs".
    expect(parseDispatchInputs("on:\n  workflow_dispatch:\njobs: { a: {} }")).toEqual({ kind: "dispatch", fields: [] });
  });

  it("reads a trigger block a YAML 1.1 tool filed under `true`", () => {
    expect(parseDispatchInputs('"true": workflow_dispatch\njobs: { a: {} }')).toEqual({ kind: "dispatch", fields: [] });
  });

  it("tells a workflow that can't be started by hand from a file that isn't a workflow", () => {
    expect(parseDispatchInputs("on: push\njobs: { a: {} }")).toEqual({ kind: "none" });
    expect(parseDispatchInputs("on: [push, pull_request]\njobs: { a: {} }")).toEqual({ kind: "none" });
    expect(parseDispatchInputs("on:\n  schedule:\n    - cron: '0 3 * * *'\njobs: { a: {} }")).toEqual({ kind: "none" });

    // Missing, broken or unrelated YAML is `invalid`, and the dialog then looks elsewhere.
    expect(parseDispatchInputs("")).toEqual({ kind: "invalid" });
    expect(parseDispatchInputs("on: [workflow_dispatch")).toEqual({ kind: "invalid" });
    expect(parseDispatchInputs("just words")).toEqual({ kind: "invalid" });
    expect(parseDispatchInputs("on: workflow_dispatch")).toEqual({ kind: "invalid" });
    expect(parseDispatchInputs("jobs: { a: {} }")).toEqual({ kind: "invalid" });
    expect(parseDispatchInputs("a: 1\n---\nb: 2")).toEqual({ kind: "invalid" });
  });

  it("types an input GitHub adds after this was written as text, the one control that can't be wrong", () => {
    const spec = parseDispatchInputs(`
on:
  workflow_dispatch:
    inputs:
      future: { type: secret-thing, default: x }
jobs: { a: {} }
`);
    expect(spec.kind === "dispatch" && spec.fields[0]).toMatchObject({ type: "string", initial: "x" });
  });
});

describe("parseGitlabRunSpec", () => {
  it("pre-fills only the variables with a description, as GitLab's own page does", () => {
    const spec = parseGitlabRunSpec(`
variables:
  DEPLOY_ENVIRONMENT:
    value: staging
    options: [production, staging, canary]
    description: The deployment target.
  PLAIN: "not asked"
  DESCRIBED_NO_VALUE:
    description: Anything you like
  UNDESCRIBED:
    value: "x"
build:
  script: make
`);
    expect(spec).not.toBeNull();
    expect(spec!.variables).toEqual([
      { key: "DEPLOY_ENVIRONMENT", value: "staging", description: "The deployment target.", options: ["production", "staging", "canary"] },
      { key: "DESCRIBED_NO_VALUE", value: "", description: "Anything you like", options: [] },
    ]);
    expect(spec!.inputs).toEqual([]);
  });

  it("reads the typed inputs of a spec header in its own document", () => {
    const spec = parseGitlabRunSpec(`
spec:
  inputs:
    environment:
      options: [staging, production]
      default: staging
    replicas:
      type: number
      default: 2
    verbose:
      type: boolean
    targets:
      type: array
      default: [eu, us]
    ticket:
      description: Change ticket
---
deploy:
  script: ./deploy.sh
`);
    expect(spec).not.toBeNull();
    const byName = Object.fromEntries(spec!.inputs.map((field) => [field.name, field]));
    expect(byName.environment).toMatchObject({ type: "choice", initial: "staging", required: false });
    expect(byName.replicas).toMatchObject({ type: "number", initial: "2", required: false });
    expect(byName.verbose).toMatchObject({ type: "boolean", initial: "false" });
    expect(byName.targets).toMatchObject({ type: "yaml", initial: '["eu","us"]', required: false });
    // No default: GitLab refuses the pipeline without a value.
    expect(byName.ticket).toMatchObject({ type: "string", required: true, description: "Change ticket" });
  });

  it("answers null for a file that is not YAML", () => {
    expect(parseGitlabRunSpec("variables: [unclosed")).toBeNull();
    expect(parseGitlabRunSpec("")).toBeNull();
    expect(parseGitlabRunSpec("- just\n- a list")).toBeNull();
  });

  it("keeps a pre-filled value inside its options", () => {
    const spec = parseGitlabRunSpec(`
variables:
  TIER:
    value: gold
    options: [bronze, silver]
    description: Tier
`);
    expect(spec!.variables[0].value).toBe("bronze");
  });
});

describe("parseAzureParameters", () => {
  it("reads every runtime parameter type, required exactly when there is no default", () => {
    const fields = parseAzureParameters(`
parameters:
- name: image
  displayName: Pool image
  type: string
  default: ubuntu-latest
  values: [windows-latest, ubuntu-latest]
- name: runTests
  displayName: Run tests?
  type: boolean
  default: false
- name: replicas
  type: number
  default: 3
- name: ticket
  type: string
- name: config
  type: object
  default:
    region: eu
- name: extraSteps
  type: stepList
stages:
- stage: Build
`)!;
    const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(byName.image).toEqual({
      name: "image",
      description: "Pool image",
      type: "choice",
      required: false,
      initial: "ubuntu-latest",
      options: ["windows-latest", "ubuntu-latest"],
    });
    expect(byName.runTests).toMatchObject({ type: "boolean", initial: "false", required: false });
    expect(byName.replicas).toMatchObject({ type: "number", initial: "3" });
    expect(byName.ticket).toMatchObject({ type: "string", required: true, initial: "" });
    expect(byName.config).toMatchObject({ type: "yaml", required: false, initial: '{"region":"eu"}' });
    expect(byName.extraSteps).toMatchObject({ type: "yaml", required: true });
  });

  it("has nothing to ask for a pipeline without runtime parameters", () => {
    expect(parseAzureParameters("stages:\n- stage: Build\n")).toEqual([]);
    // A mapping is a template's parameters, not a pipeline's.
    expect(parseAzureParameters("parameters:\n  image: ubuntu\n")).toEqual([]);
    expect(parseAzureParameters("")).toEqual([]);
  });

  it("answers null for a file that is not YAML", () => {
    expect(parseAzureParameters("parameters: [unclosed")).toBeNull();
    expect(parseAzureParameters("just words")).toBeNull();
  });
});

const field = (over: Partial<RunField> & Pick<RunField, "name" | "type">): RunField => ({
  description: null,
  required: false,
  initial: "",
  options: [],
  ...over,
});

describe("validateFields", () => {
  const fields = [
    field({ name: "ticket", type: "string", required: true }),
    field({ name: "replicas", type: "number", initial: "3" }),
    field({ name: "level", type: "choice", options: ["info", "debug"], initial: "info" }),
    field({ name: "config", type: "yaml" }),
    field({ name: "optional", type: "string" }),
  ];

  it("states each rule while there is still a cursor in the field", () => {
    expect(validateFields(fields, { ticket: "", replicas: "three", level: "trace", config: "a: [" })).toEqual({
      ticket: "required",
      replicas: "number",
      level: "choice",
      config: "yaml",
    });
  });

  it("has nothing to say about a form filled in properly", () => {
    expect(validateFields(fields, { ticket: "CHG-1", replicas: "2.5", level: "debug", config: "a: 1" })).toEqual({});
    // Untouched fields start from the file's defaults, which are valid by construction.
    expect(validateFields(fields, { ticket: "CHG-1" })).toEqual({});
  });
});

describe("runValues", () => {
  it("types booleans and numbers, keeps text as typed, and leaves empty optionals to the host's default", () => {
    const fields = [
      field({ name: "dry", type: "boolean", initial: "true" }),
      field({ name: "replicas", type: "number", initial: "3" }),
      field({ name: "note", type: "string" }),
      field({ name: "target", type: "choice", options: ["a", "b"], initial: "a" }),
      field({ name: "ticket", type: "string", required: true }),
    ];
    expect(runValues(fields, { dry: "false", replicas: "5", note: "", target: "b", ticket: " CHG-1 " })).toEqual({
      dry: false,
      replicas: 5,
      target: "b",
      // Text goes as typed — a leading space may be the point of it.
      ticket: " CHG-1 ",
    });
  });

  it("sends a structured value only when it was edited, and parsed", () => {
    const fields = [field({ name: "config", type: "yaml", initial: '{"region":"eu"}' })];
    expect(runValues(fields, {})).toEqual({});
    expect(runValues(fields, { config: '{"region":"eu"}' })).toEqual({});
    expect(runValues(fields, { config: "region: us\nsize: 2" })).toEqual({ config: { region: "us", size: 2 } });
  });
});

const row = (id: string, key: string, value = "v", masked = false): VariableRow => ({ id, key, value, masked });

describe("variables", () => {
  it("applies each host's alphabet to names, and catches a name set twice", () => {
    const rows = [row("1", "DEPLOY_ENV"), row("2", "deploy.env"), row("3", "deploy_env"), row("4", ""), row("5", "", "")];
    expect(validateVariables(rows, "gitlab")).toEqual({ "2": "name", "3": "duplicate", "4": "empty" });
    // Azure allows the dot.
    expect(validateVariables(rows, "azure")).toEqual({ "3": "duplicate", "4": "empty" });
  });

  it("sends named rows only, names trimmed", () => {
    expect(variablesToSend([row("1", " TOKEN ", "s3cret", true), row("2", "", "")])).toEqual([
      { key: "TOKEN", value: "s3cret", masked: true },
    ]);
  });

  /** Azure never returns a secret's value, so a declared secret starts empty — and echoing it back
   *  untouched would run the pipeline with the secret blanked out. */
  it("sends a declared variable only once it has been changed", () => {
    const declaredSecret = { ...row("1", "apiKey", "", true), initial: "" };
    const declaredPlain = { ...row("2", "deployTarget", "staging"), initial: "staging" };
    const edited = { ...row("3", "region", "us"), initial: "eu" };
    expect(variablesToSend([declaredSecret, declaredPlain, edited])).toEqual([
      { key: "region", value: "us", masked: false },
    ]);
  });
});

describe("confirmationLines", () => {
  it("lists what will be sent, with hidden values hidden", () => {
    const fields = [
      field({ name: "dry", type: "boolean", initial: "false" }),
      field({ name: "note", type: "string" }),
      field({ name: "config", type: "yaml", initial: "{}" }),
    ];
    const lines = confirmationLines(fields, { dry: "true", note: "hello", config: "a: 1" }, [
      { key: "TOKEN", value: "s3cret", masked: true },
      { key: "TARGET", value: "eu", masked: false },
    ]);
    expect(lines).toEqual(["dry = true", "note = hello", 'config = {"a":1}', `TOKEN = ${MASK}`, "TARGET = eu"]);
    expect(lines.join("\n")).not.toContain("s3cret");
  });
});

describe("refChoices", () => {
  const branch = (name: string, is_remote: boolean): BranchInfo => ({
    name,
    is_head: false,
    is_remote,
    upstream: null,
    ahead: 0,
    behind: 0,
    target: null,
    tip_time: null,
    is_locked: false,
    locked_by_rule: false,
  });

  it("offers the remote's branches short, the checked-out and default ones first, tags newest first", () => {
    const choices = refChoices(
      [
        branch("main", false),
        branch("local-only", false),
        branch("origin/HEAD", true),
        branch("origin/main", true),
        branch("origin/release/2.0", true),
        branch("origin/feature/a", true),
      ],
      "feature/wip",
      "main",
      ["v1.9.0", "v1.10.0", "v1.10.0"],
    );
    expect(choices.branches).toEqual(["feature/wip", "main", "feature/a", "release/2.0"]);
    // A local-only branch is one the host will say "no such ref" to.
    expect(choices.branches).not.toContain("local-only");
    expect(choices.tags).toEqual(["v1.10.0", "v1.9.0"]);
  });
});

describe("gates", () => {
  const gate = (over: Partial<PipelineGate>): PipelineGate => ({
    provider: "azure",
    run_id: "42",
    id: "g",
    kind: "approval",
    name: "Deploy",
    stage_id: null,
    job_ids: [],
    can_act: null,
    reviewers: [],
    instructions: null,
    since: null,
    web_url: "",
    ...over,
  });

  it("marks the jobs a gate names and the stand-in of a stage it holds", () => {
    const holds = gateHolds([gate({ job_ids: ["j1"] }), gate({ stage_id: "stage-prod" })]);
    expect(isHeld({ id: "j1" }, holds)).toBe(true);
    // An Azure stage with no jobs yet is drawn as a placeholder sharing the stage's id.
    expect(isHeld({ id: "stage-prod" }, holds)).toBe(true);
    expect(isHeld({ id: "j2" }, holds)).toBe(false);
    expect(isHeld({ id: "j1" }, gateHolds(undefined))).toBe(false);
  });

  it("puts what can be answered before what only explains", () => {
    const ordered = orderGates([gate({ id: "c", kind: "check" }), gate({ id: "m", kind: "manual" }), gate({ id: "a", kind: "approval" })]);
    expect(ordered.map((g) => g.id)).toEqual(["a", "m", "c"]);
  });
});

describe("formatSize", () => {
  it("reads at the precision a download is read at", () => {
    expect(formatSize(556)).toBe("556 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(12.4 * 1024 * 1024)).toBe("12 MB");
    expect(formatSize(1.25 * 1024 ** 3)).toBe("1.3 GB");
    expect(formatSize(null)).toBe("");
    expect(formatSize(-1)).toBe("");
  });
});
