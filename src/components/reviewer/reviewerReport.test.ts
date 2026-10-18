import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { reviewReportMarkdown } from "./reviewerReport";
import { onNewCode } from "./ReviewerFindings";
import type { ReviewerRunSummary } from "../../lib/tauri/reviewerCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

const t = (key: TranslationKey, params?: Record<string, string | number>) =>
  params ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(",")})` : key;

const summary = {
  runId: "r1",
  projectId: "p1",
  projectKey: "demo",
  startedAt: 0,
  finishedAt: 0,
  status: "failed",
  error: null,
  stages: [],
  gate: { status: "ERROR", conditions: [{ metric: "coverage", comparator: "LT", threshold: "80", actual: "61.5", status: "ERROR" }] },
  measures: { reliabilityRating: "B", securityRating: "A", maintainabilityRating: "A", reliabilityIssues: 1, securityIssues: 0, maintainabilityIssues: 3, coverage: 61.5, duplicatedLinesDensity: 2, ncloc: 1200, debtMinutes: 30, linesToCover: 400, uncoveredLines: 154 },
  issues: [{ key: "i1", rule: "ts:S1", message: "Remove this | pipe", path: "src/a.ts", line: 4, quality: "reliability", severity: "high", effortMinutes: 5, tags: [] }],
  issuesTotal: 1,
  hotspots: [{ key: "h1", rule: "ts:S2077", message: "Check this query", path: "src/db.ts", line: 9, probability: "HIGH", category: "sql-injection", status: "TO_REVIEW", resolution: null }],
  tests: null,
  coverage: [],
  commit: "abc1234",
  branch: "feature",
  dirty: false,
  sonarqubeVersion: "26.9",
} as unknown as ReviewerRunSummary;

describe("the review report", () => {
  it("writes the gate, the issues and the hotspots as tables, escaping pipes", () => {
    const text = reviewReportMarkdown(t, summary);
    expect(text).toContain("| coverage | 61.5 | ≥ 80 | ✗ |");
    expect(text).toContain("src/a.ts:4 | Remove this \\| pipe | ts:S1 |");
    expect(text).toContain("## reviewer.tabHotspots (1)");
    expect(text).toContain("src/db.ts:9");
  });
});

describe("new code", () => {
  const changed = { base: "origin/main", files: { "src/a.ts": [[2, 5]] as [number, number][] }, added: ["src/new.ts"] };
  it("counts a line inside a changed run, a new file, and a whole-file finding on a changed file", () => {
    expect(onNewCode(changed, "src/a.ts", 4)).toBe(true);
    expect(onNewCode(changed, "src/a.ts", 9)).toBe(false);
    expect(onNewCode(changed, "src/a.ts", null)).toBe(true);
    expect(onNewCode(changed, "src/new.ts", 100)).toBe(true);
    expect(onNewCode(changed, "src/other.ts", 1)).toBe(false);
  });
});
