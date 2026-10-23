import { describe, expect, it } from "vitest";
import { ago, exitMeaning, lastErrorLine, readContainer, readRun } from "./diagnose";
import type { ContainerRow, ContainerSummary } from "../../types/containers";
import type { PipelineRun } from "../../types/domain";

const NOW = Date.parse("2026-10-22T12:00:00Z");

const row = (over: Partial<ContainerRow>): ContainerRow => ({
  id: "abc",
  name: "api",
  image: "api:latest",
  state: "exited",
  status: "Exited (137) 12 minutes ago",
  health: "",
  exitCode: 137,
  ports: [],
  created: "",
  command: "",
  project: "",
  service: "",
  projectDir: "",
  configFiles: "",
  pod: "",
  labels: {},
  ...over,
});

const detail = (over: Partial<ContainerSummary>): ContainerSummary =>
  ({
    image: "api:latest",
    command: null,
    entrypoint: null,
    workingDir: null,
    created: null,
    startedAt: null,
    finishedAt: "2026-10-22T11:48:00Z",
    exitCode: 137,
    oomKilled: false,
    restartCount: 0,
    restartPolicy: null,
    health: null,
    healthLog: [],
    env: [{ name: "DB_PASSWORD", value: "hunter2", secret: true }],
    mounts: [],
    networks: [],
    ports: [],
    labels: {},
    ...over,
  }) as ContainerSummary;

describe("what Codi says about a container", () => {
  it("says how long ago, in words", () => {
    expect(ago("2026-10-22T11:48:00Z", NOW)).toBe("12 minutes ago");
    expect(ago("2026-10-22T11:59:50Z", NOW)).toBe("just now");
    expect(ago(null, NOW)).toBe("");
  });

  it("reads an exit code as what usually caused it", () => {
    expect(exitMeaning(137, true)).toBe("codi.say.exit.oom");
    expect(exitMeaning(137, false)).toBe("codi.say.exit.killed");
    expect(exitMeaning(143, null)).toBe("codi.say.exit.term");
    expect(exitMeaning(0, null)).toBe("codi.say.exit.clean");
    expect(exitMeaning(42, null)).toBe("codi.say.exit.other");
  });

  it("finds the last line that reads like a failure, without its timestamp", () => {
    const log = "2026-10-22T11:47:59Z starting\n2026-10-22T11:47:59.120Z ERROR: connection refused to db:5432\nbye";
    expect(lastErrorLine(log)).toBe("connection refused to db:5432");
    expect(lastErrorLine("all good\nlistening on 8080")).toBe(null);
  });

  it("says why a container fell, and offers the AI only when it fell badly", () => {
    const fell = readContainer(row({}), detail({ oomKilled: true }), "Killed\nERROR: out of memory", NOW);
    expect(fell.sentence).toBe("api stopped 12 minutes ago with code 137: it ran out of memory. The last error line says: “out of memory”.");
    expect(fell.troubled).toBe(true);
    const clean = readContainer(row({ exitCode: 0 }), detail({ exitCode: 0 }), "", NOW);
    expect(clean.sentence).toBe("api stopped 12 minutes ago with code 0: it finished without an error.");
    expect(clean.troubled).toBe(false);
    const flapping = readContainer(row({ state: "running", exitCode: null }), detail({ restartCount: 4, health: "unhealthy" }), "", NOW);
    expect(flapping.sentence).toBe("api is running, but it has restarted 4 times. Its health check is failing.");
  });

  it("never says what the container's environment holds", () => {
    const said = readContainer(row({}), detail({}), "", NOW).sentence;
    expect(said).not.toContain("hunter2");
    expect(said).not.toContain("DB_PASSWORD");
  });
});

describe("what Codi says about a pipeline", () => {
  const run = (over: Partial<PipelineRun>): PipelineRun =>
    ({
      provider: "github",
      id: "1",
      number: 12,
      name: "CI",
      status: "failed",
      raw_status: "failure",
      branch: "main",
      commit_sha: "",
      commit_title: null,
      actor: null,
      event: null,
      created_at: "2026-10-22T11:30:00Z",
      started_at: "2026-10-22T11:30:00Z",
      finished_at: "2026-10-22T11:40:00Z",
      web_url: "",
      definition_path: null,
      ...over,
    }) as PipelineRun;

  it("says which run, where, how it went and when", () => {
    expect(readRun(run({}), "api-pagos", NOW)).toBe("The latest pipeline of api-pagos, CI on main, failed 20 minutes ago.");
    expect(readRun(run({ status: "running", finished_at: null, started_at: "2026-10-22T11:57:00Z" }), "web", NOW)).toBe(
      "The latest pipeline of web, CI on main, started 3 minutes ago and is still running.",
    );
  });
});
