import { describe, expect, it } from "vitest";
import { parseBitbucketPipelines, validateVariables, variablesToSend } from "./runInputs";

/**
 * The custom pipelines the "Run pipeline" dialog offers for a Bitbucket repository, read out of
 * `bitbucket-pipelines.yml`. A wrong reading here is a pipeline that isn't offered, or one started
 * with a variable it never declared.
 */

const PIPELINES = `
image: node:20

definitions:
  steps:
    - step: &build
        name: Build
        script:
          - npm ci

pipelines:
  default:
    - step: *build
  branches:
    main:
      - step: *build
  custom:
    deploy-to-production:
      - variables:
          - name: Region
            default: eu-west-1
            allowed-values:
              - eu-west-1
              - us-east-1
            description: Where to deploy
          - name: DryRun
            default: "true"
          - name: Ticket
      - step:
          name: Deploy
          deployment: production
          script:
            - ./deploy.sh
    nightly-report:
      - step: *build
`;

describe("parseBitbucketPipelines", () => {
  it("lists the custom pipelines, with the variables each asks for", () => {
    const pipelines = parseBitbucketPipelines(PIPELINES);
    expect(pipelines?.map((pipeline) => pipeline.name)).toEqual(["deploy-to-production", "nightly-report"]);
    expect(pipelines?.[0].variables).toEqual([
      { key: "Region", value: "eu-west-1", description: "Where to deploy", options: ["eu-west-1", "us-east-1"] },
      { key: "DryRun", value: "true", description: null, options: [] },
      { key: "Ticket", value: "", description: null, options: [] },
    ]);
    // Anchors resolve like any other step: the pipeline is there, with nothing to ask.
    expect(pipelines?.[1].variables).toEqual([]);
  });

  it("keeps a default inside its allowed values", () => {
    const pipelines = parseBitbucketPipelines(`
pipelines:
  custom:
    promote:
      - variables:
          - name: Stage
            default: nowhere
            allowed-values: [staging, production]
`);
    expect(pipelines?.[0].variables[0].value).toBe("staging");
  });

  it("answers an empty list for a file without custom pipelines, and null for one that isn't a pipeline file", () => {
    expect(parseBitbucketPipelines("pipelines:\n  default:\n    - step:\n        script: [make]\n")).toEqual([]);
    expect(parseBitbucketPipelines("image: node:20\n")).toBeNull();
    expect(parseBitbucketPipelines("pipelines: [\n")).toBeNull();
    expect(parseBitbucketPipelines("")).toBeNull();
  });

  it("sends every declared variable — defaults included — under Bitbucket's name rules", () => {
    const [deploy] = parseBitbucketPipelines(PIPELINES) ?? [];
    // Rows as the dialog builds them: fixed names and no `initial`, so none is held back.
    const rows = deploy.variables.map((variable, index) => ({
      id: `row-${index}`,
      key: variable.key,
      value: variable.value,
      masked: false,
    }));
    expect(validateVariables(rows, "bitbucket")).toEqual({});
    expect(variablesToSend(rows)).toEqual([
      { key: "Region", value: "eu-west-1", masked: false },
      { key: "DryRun", value: "true", masked: false },
      { key: "Ticket", value: "", masked: false },
    ]);
    expect(validateVariables([{ id: "x", key: "deploy.env", value: "1", masked: false }], "bitbucket")).toEqual({ x: "name" });
  });
});
