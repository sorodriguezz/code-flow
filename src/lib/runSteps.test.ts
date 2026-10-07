import { describe, expect, it } from "vitest";
import { parseRunSteps, phaseOfSteps, phaseOfTool, touchedFiles } from "./runSteps";

const out = (text: string) => ({ stream: "stdout" as const, text });

describe("parseRunSteps", () => {
  it("reads tool calls, statuses, prose and sub-agent steps as rows", () => {
    const steps = parseRunSteps([
      out("· claude-haiku-4-5-20251001"),
      out("Voy a mirar el store.\n⏵ Read: src/state/aiRunStore.ts"),
      out("↳ ⏵ Grep: cancelling"),
      out("· Compacting…"),
      { stream: "stderr", text: "⏵ not a tool: on stderr" },
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["text", "tool", "tool", "note", "text"]);
    expect(steps[1]).toMatchObject({ tool: "Read", arg: "src/state/aiRunStore.ts", sub: false });
    expect(steps[2]).toMatchObject({ tool: "Grep", arg: "cancelling", sub: true });
    expect(steps[4].error).toBe(true);
  });

  it("drops the model banner a run opens with, and only that one", () => {
    expect(parseRunSteps([out("· claude-opus-4-8")])).toEqual([]);
    expect(parseRunSteps([out("⏵ Bash: ls"), out("· claude-opus-4-8")])).toHaveLength(2);
  });

  it("takes a tool call with no argument", () => {
    expect(parseRunSteps([out("⏵ TodoWrite")])[0]).toMatchObject({ kind: "tool", tool: "TodoWrite", arg: "" });
  });
});

describe("phases", () => {
  it("names what a tool call means", () => {
    expect(phaseOfTool("Read")).toBe("read");
    expect(phaseOfTool("Grep")).toBe("search");
    expect(phaseOfTool("MultiEdit")).toBe("edit");
    expect(phaseOfTool("Bash")).toBe("run");
    expect(phaseOfTool("Task")).toBe("delegate");
    expect(phaseOfTool("TodoWrite")).toBe("plan");
    expect(phaseOfTool("mcp__github__create_issue")).toBe("tool");
  });

  it("follows the newest step, and starts before there is one", () => {
    expect(phaseOfSteps([])).toBe("start");
    expect(phaseOfSteps(parseRunSteps([out("⏵ Read: a.ts"), out("⏵ Edit: a.ts")]))).toBe("edit");
    expect(phaseOfSteps(parseRunSteps([out("⏵ Read: a.ts"), out("Listo, ya lo vi.")]))).toBe("work");
  });
});

describe("touchedFiles", () => {
  it("lists read and edited files once each, edited winning", () => {
    const steps = parseRunSteps([
      out("⏵ Read: src/a.ts"),
      out("⏵ Grep: cancelling"),
      out("⏵ Read: src/b.ts"),
      out("⏵ Edit: src/a.ts"),
      out("⏵ Bash: pnpm test"),
      out("⏵ Read: src/very/long/path/that/was/cut…"),
    ]);
    expect(touchedFiles(steps)).toEqual([
      { path: "src/a.ts", edited: true },
      { path: "src/b.ts", edited: false },
    ]);
  });
});
