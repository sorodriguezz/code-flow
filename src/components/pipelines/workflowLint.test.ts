import { describe, expect, it } from "vitest";
import { lintWorkflow } from "./workflowLint";

const keys = (text: string) => lintWorkflow("ci.yml", text).map((issue) => issue.message.key);

describe("lintWorkflow", () => {
  it("passes a well-formed workflow", () => {
    const text = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo \${{ github.sha }}
  deploy:
    needs: build
    uses: ./.github/workflows/deploy.yml
`;
    expect(keys(text)).toEqual([]);
  });

  it("finds the mistakes GitHub refuses a file for, on their lines", () => {
    const text = `on: push
jobs:
  build:
    steps:
      - name: nothing
      - uses: actions/checkout@v4
        run: echo hi
  test:
    runs-on: ubuntu-latest
    needs: [biuld]
    steps:
      - run: echo \${{ github.sha
`;
    const issues = lintWorkflow("ci.yml", text);
    expect(issues.map((i) => i.message.key)).toEqual(["missingRunsOn", "stepNeither", "stepUsesAndRun", "unknownNeed", "unclosedExpression"]);
    expect(issues.find((i) => i.message.key === "unknownNeed")?.line).toBe(10);
  });

  it("names a loop in needs and a YAML error", () => {
    const loop = `on: push
jobs:
  a:
    runs-on: x
    needs: b
    steps: [{ run: a }]
  b:
    runs-on: x
    needs: a
    steps: [{ run: b }]
`;
    const issues = lintWorkflow("ci.yml", loop);
    expect(issues.map((i) => i.message)).toEqual([{ key: "needsCycle", jobs: "a → b → a" }]);
    expect(keys("on: push\njobs:\n  a: [unclosed\n")[0]).toBe("yaml");
  });
});
