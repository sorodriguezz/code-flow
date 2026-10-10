import { describe, expect, it } from "vitest";
import { formatDuration, formatEffort, formatTestTime, groupCases, logText, stageDetail } from "./ReviewerView";
import { EMPTY_PROJECT_CONFIG, effectiveCommands } from "../../state/reviewerStore";
import type { ReviewerStage, ReviewerSuggestion, ReviewerTestCase } from "../../lib/tauri/reviewerCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

// A translator that names the key and its params, so the assertions say which sentence was chosen.
const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const stage = (patch: Partial<ReviewerStage>): ReviewerStage => ({
  id: "test",
  status: "ok",
  command: "",
  startedAt: null,
  durationMs: null,
  detail: null,
  ...patch,
});

describe("reviewer view helpers", () => {
  it("formats durations the way the stage strip shows them", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(6_400)).toBe("6 s");
    expect(formatDuration(72_000)).toBe("1 m 12 s");
    expect(formatDuration(7_380_000)).toBe("2 h 3 m");
  });

  it("formats one test's time finer than a stage's", () => {
    expect(formatTestTime(null)).toBe("");
    expect(formatTestTime(0)).toBe("<1 ms");
    expect(formatTestTime(12)).toBe("12 ms");
    expect(formatTestTime(1_440)).toBe("1.4 s");
    expect(formatTestTime(72_000)).toBe("1 m 12 s");
  });

  it("groups cases by suite in the order the reports name them, with each suite's tally", () => {
    const test = (suite: string, status: ReviewerTestCase["status"], durationMs: number | null): ReviewerTestCase => ({
      suite,
      name: `${suite}-${status}`,
      status,
      durationMs,
      file: null,
      line: null,
    });
    const groups = groupCases([
      test("orders", "passed", 10),
      test("payments", "failed", 5),
      test("orders", "skipped", null),
      test("orders", "passed", 20),
    ]);
    expect(groups.map((g) => [g.suite, g.cases.length, g.passed, g.failed, g.skipped, g.durationMs])).toEqual([
      ["orders", 3, 2, 0, 1, 30],
      ["payments", 1, 0, 1, 0, 5],
    ]);
  });

  it("formats SonarQube's remediation effort in its own units", () => {
    expect(formatEffort(null)).toBe("");
    expect(formatEffort(10)).toBe("10 min");
    expect(formatEffort(90)).toBe("1 h 30 min");
    expect(formatEffort(120)).toBe("2 h");
    // A SonarQube day is eight hours.
    expect(formatEffort(960)).toBe("2 d");
  });

  it("explains a stage's result in the user's words", () => {
    expect(stageDetail(t, stage({ status: "failed", detail: "exit:2" }))).toBe("reviewer.exitCode(code=2)");
    expect(stageDetail(t, stage({ id: "sonar", status: "failed", detail: "scanner:3" }))).toBe("reviewer.scannerExit(code=3)");
    expect(stageDetail(t, stage({ id: "gate", detail: "ERROR", status: "failed" }))).toBe("reviewer.gateFailedShort");
    expect(stageDetail(t, stage({ id: "gate", detail: "OK" }))).toBe("reviewer.gatePassedShort");
    expect(stageDetail(t, stage({ detail: "212/214" }))).toBe("212/214");
    expect(stageDetail(t, stage({ status: "skipped" }))).toBe("reviewer.stageSkipped");
  });

  it("translates CodeFlow's own log lines and leaves tool output alone", () => {
    // The dictionary's answer for a key it has; a key it lacks comes back as itself.
    const dictionary = (key: TranslationKey) => (key === "reviewer.log.processing" ? "Procesando…" : key);
    expect(logText(dictionary, "cf:processing")).toBe("Procesando…");
    expect(logText(dictionary, "10:10:24 INFO ANALYSIS SUCCESSFUL")).toBe("10:10:24 INFO ANALYSIS SUCCESSFUL");
    // An unknown key shows as it came rather than as the raw key.
    expect(logText(dictionary, "cf:nope")).toBe("cf:nope");
  });
});

describe("effectiveCommands", () => {
  const suggestion: ReviewerSuggestion = {
    stacks: ["Maven"],
    prepare: "",
    build: "./mvnw -B -DskipTests compile",
    test: "./mvnw -B test",
    notes: [],
    projectKey: "demo-abc123",
    hasProperties: false,
  };

  it("follows the detected commands until the user edits one", () => {
    expect(effectiveCommands(EMPTY_PROJECT_CONFIG, suggestion)).toEqual({
      prepare: "",
      build: suggestion.build,
      test: suggestion.test,
    });
  });

  it("keeps the user's commands once customised, empty ones included", () => {
    const custom = { ...EMPTY_PROJECT_CONFIG, customized: true, build: "", test: "make test" };
    expect(effectiveCommands(custom, suggestion)).toEqual({ prepare: "", build: "", test: "make test" });
  });
});
