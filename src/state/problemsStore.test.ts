import { beforeEach, describe, expect, it } from "vitest";
import { countProblems, flushReports, groupProblems, reportSoon, useProblemsStore, type Problem } from "./problemsStore";

const problem = (line: number, severity: Problem["severity"], message: string, column = 1): Problem => ({
  line,
  column,
  endLine: line,
  endColumn: column + 3,
  severity,
  message,
});

beforeEach(() => useProblemsStore.getState().clear());

describe("the problems store", () => {
  it("replaces an owner's answer for a file, and forgets the file on an empty one", () => {
    const store = useProblemsStore.getState();
    store.report("lsp:p1:pyright", "a.py", [problem(1, "error", "x")]);
    store.report("lsp:p1:pyright", "a.py", [problem(2, "warning", "y")]);
    expect(useProblemsStore.getState().byOwner["lsp:p1:pyright"]).toEqual({ "a.py": [problem(2, "warning", "y")] });
    store.report("lsp:p1:pyright", "a.py", []);
    expect(useProblemsStore.getState().byOwner["lsp:p1:pyright"]).toEqual({});
  });

  it("keeps two owners of one file apart, so neither erases the other", () => {
    const store = useProblemsStore.getState();
    store.report("lsp:p1:pyright", "a.py", [problem(1, "error", "types")]);
    store.report("lsp:p1:ruff", "a.py", [problem(3, "warning", "lint")]);
    store.report("lsp:p1:ruff", "a.py", []);
    expect(groupProblems(useProblemsStore.getState().byOwner)).toEqual([
      { path: "a.py", problems: [problem(1, "error", "types")] },
    ]);
  });

  it("forgets by owner prefix — a stopped server, or one file tsserver let go of", () => {
    const store = useProblemsStore.getState();
    store.report("tsserver:semantic", "a.ts", [problem(1, "error", "x")]);
    store.report("tsserver:syntax", "a.ts", [problem(2, "error", "y")]);
    store.report("tsserver:semantic", "b.ts", [problem(1, "error", "z")]);
    store.report("lsp:p1:rust", "src/main.rs", [problem(1, "error", "w")]);
    store.forgetFile("tsserver:", "a.ts");
    expect(groupProblems(useProblemsStore.getState().byOwner).map((file) => file.path)).toEqual(["b.ts", "src/main.rs"]);
    store.forget("lsp:");
    expect(Object.keys(useProblemsStore.getState().byOwner)).toEqual(["tsserver:semantic", "tsserver:syntax"]);
  });
});

describe("reports that arrive in bursts", () => {
  it("land together, keeping the last word per owner and file", () => {
    reportSoon("lsp:p1:rust", "a.rs", [problem(1, "error", "first")]);
    reportSoon("lsp:p1:rust", "a.rs", [problem(2, "error", "second")]);
    reportSoon("lsp:p1:rust", "b.rs", [problem(3, "warning", "w")]);
    expect(useProblemsStore.getState().byOwner).toEqual({});
    flushReports();
    expect(useProblemsStore.getState().byOwner["lsp:p1:rust"]).toEqual({
      "a.rs": [problem(2, "error", "second")],
      "b.rs": [problem(3, "warning", "w")],
    });
  });

  it("never land after the store was cleared or their owner forgotten", () => {
    reportSoon("lsp:p1:rust", "a.rs", [problem(1, "error", "stale")]);
    useProblemsStore.getState().clear();
    reportSoon("tsserver:semantic", "a.ts", [problem(1, "error", "gone")]);
    useProblemsStore.getState().forget("tsserver:");
    flushReports();
    expect(useProblemsStore.getState().byOwner).toEqual({});
  });
});

describe("grouping and counting", () => {
  it("sorts files by path and problems by position, and lists a problem two owners share once", () => {
    const shared = problem(4, "error", "Cannot find name 'x'.");
    const byOwner = {
      "tsserver:semantic": { "src/b.ts": [problem(9, "warning", "late"), shared], "src/a.ts": [problem(1, "info", "i")] },
      "tsproject:semantic": { "src/b.ts": [shared] },
    };
    expect(groupProblems(byOwner)).toEqual([
      { path: "src/a.ts", problems: [problem(1, "info", "i")] },
      { path: "src/b.ts", problems: [shared, problem(9, "warning", "late")] },
    ]);
    expect(countProblems(byOwner)).toEqual({ error: 1, warning: 1, info: 1 });
  });

  it("filters by severity, dropping files left with nothing", () => {
    const byOwner = { o: { "a.ts": [problem(1, "warning", "w")], "b.ts": [problem(1, "error", "e")] } };
    expect(groupProblems(byOwner, { error: true, warning: false, info: true }).map((file) => file.path)).toEqual([
      "b.ts",
    ]);
  });
});
