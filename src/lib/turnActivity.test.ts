import { describe, expect, it } from "vitest";
import { parseRunSteps, touchedFiles } from "./runSteps";
import { turnActivity } from "./turnActivity";

const out = (text: string) => ({ stream: "stdout" as const, text });

describe("turnActivity", () => {
  const steps = parseRunSteps([
    out("⏵ mcp__codeflow_map__recall: convenciones de commits"),
    out("⏵ mcp__codeflow_map__recall: convenciones de commits"),
    out("⏵ mcp__codeflow_map__search_knowledge: cómo se despliega"),
    out("⏵ mcp__codeflow_map__read_note: note-42"),
    out("⏵ mcp__codeflow_map__read_reference_file: src/index.ts"),
    out("⏵ Read: /Users/x/.claude/projects/repo/memory/backlog.md"),
    out("⏵ Read: src/a.ts"),
    out("⏵ Bash: pnpm test"),
    out("⏵ WebSearch: tauri v2 capabilities"),
    out("⏵ mcp__claude_ai_Google_Drive__search_files: presupuesto"),
    out("⏵ mcp__codeflow_map__service_logs: api"),
    out("⏵ Grep: cancelling"),
  ]);

  it("groups each place the turn went, in a fixed order, counting repeats once as items", () => {
    const groups = turnActivity(steps);
    expect(groups.map((g) => g.kind)).toEqual(["memory", "notes", "reference", "web", "connector", "app", "command"]);
    const memory = groups.find((g) => g.kind === "memory")!;
    expect(memory.count).toBe(3);
    expect(memory.items).toEqual(["convenciones de commits", "backlog"]);
    expect(groups.find((g) => g.kind === "notes")!.items).toEqual(["cómo se despliega", "note-42"]);
    expect(groups.find((g) => g.kind === "connector")).toMatchObject({ source: "Google Drive", items: ["search_files: presupuesto"] });
    expect(groups.find((g) => g.kind === "command")!.items).toEqual(["pnpm test"]);
  });

  it("leaves repository files and plain searches to the file chips", () => {
    expect(turnActivity(parseRunSteps([out("⏵ Read: src/a.ts"), out("⏵ Grep: x")]))).toEqual([]);
    // …and the file chips leave out the memory file.
    expect(touchedFiles(steps).map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});
