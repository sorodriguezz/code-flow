import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({ readFileText: async () => "" }));
const { coverageSummary, fileCoverage, parseCobertura, parseIstanbul, parseLcov } = await import("./coverage");

describe("coverage reports", () => {
  it("reads lcov", () => {
    const report = parseLcov(["TN:", "SF:/ci/work/repo/src/a.ts", "DA:1,3", "DA:2,0", "DA:4,1", "end_of_record"].join("\n"));
    expect(fileCoverage(report, "src/a.ts")).toEqual({ hit: [1, 4], missed: [2] });
  });

  it("reads Istanbul JSON by statement start line", () => {
    const report = parseIstanbul(
      JSON.stringify({
        "/repo/src/b.ts": {
          path: "/repo/src/b.ts",
          statementMap: { "0": { start: { line: 1 } }, "1": { start: { line: 2 } }, "2": { start: { line: 2 } } },
          s: { "0": 0, "1": 0, "2": 5 },
        },
      }),
    );
    expect(fileCoverage(report, "src/b.ts")).toEqual({ hit: [2], missed: [1] });
  });

  it("reads Cobertura XML", () => {
    const xml = `<coverage><packages><package><classes>
      <class name="m" filename="pkg/m.py"><lines><line number="1" hits="1"/><line number="3" hits="0"/></lines></class>
    </classes></package></packages></coverage>`;
    expect(fileCoverage(parseCobertura(xml), "pkg/m.py")).toEqual({ hit: [1], missed: [3] });
  });

  it("matches a report written relative to a sub-package", () => {
    const report = parseLcov("SF:src/x.ts\nDA:1,1\nend_of_record");
    expect(fileCoverage(report, "packages/web/src/x.ts")).toEqual({ hit: [1], missed: [] });
    expect(fileCoverage(report, "src/y.ts")).toBeNull();
  });

  it("sums lines covered over lines executable", () => {
    const report = parseLcov("SF:a\nDA:1,1\nDA:2,0\nend_of_record\nSF:b\nDA:1,1\nend_of_record");
    expect(coverageSummary(report)).toEqual({ hit: 2, total: 3 });
  });
});
