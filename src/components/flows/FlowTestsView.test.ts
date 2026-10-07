import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlowRunNodeRow, FlowTest } from "../../lib/tauri/flowsCommands";

const saved: FlowTest[] = [];

vi.mock("../../lib/tauri/flowsCommands", () => ({
  flowsTestSave: vi.fn(async (test: FlowTest) => {
    saved.push(test);
    return test;
  }),
  flowsTestDelete: vi.fn(),
  flowsTestsList: vi.fn(async () => []),
  flowsTestsRun: vi.fn(async () => []),
}));
vi.mock("../../state/flowRunsStore", () => ({ useFlowRunsStore: { getState: () => ({ setPane: () => {} }) } }));
vi.mock("../../state/flowsStore", () => ({ useFlowsStore: () => undefined }));
vi.mock("../../state/languageStore", () => ({ useT: () => (key: string) => key, useLanguageStore: () => "es" }));

import { answeringNode, testFromRun } from "./FlowTestsView";

const node = (nodeId: string, seq: number, finishedAt: string | null, status: FlowRunNodeRow["status"] = "success", nodeType = "data.set") => ({
  nodeId,
  nodeType,
  status,
  seq,
  finishedAt,
});

const at = (ms: number) => `2026-10-07T10:00:00.${String(ms).padStart(3, "0")}Z`;

describe("the node a run answered with", () => {
  it("is the last to finish, even an IF that sent everything to its false branch", () => {
    const nodes = [node("trigger", 1, at(1), "success", "trigger.webhook"), node("set", 2, at(5)), node("if", 3, at(9), "success", "logic.if")];
    expect(answeringNode(nodes)?.nodeId).toBe("if");
  });

  it("goes by finishing time, not by start, and by start order within a millisecond", () => {
    // A slow branch that started first and finished last answers, as the engine sees it.
    expect(answeringNode([node("slow", 2, at(30)), node("fast", 3, at(12))])?.nodeId).toBe("slow");
    expect(answeringNode([node("fed", 3, at(7)), node("feeder", 2, at(7))])?.nodeId).toBe("fed");
  });

  it("never is a node that did not run here: reused, pinned, failed, skipped or picked up after a wait", () => {
    const nodes = [
      node("trigger", 1, at(1), "success", "trigger.manual"),
      node("reused", 0, null, "reused"),
      node("pinned", 0, null, "pinned"),
      node("failed", 2, at(4), "error"),
      node("skipped", 3, null, "skipped"),
      node("decided", 0, null),
    ];
    expect(answeringNode(nodes)?.nodeId).toBe("trigger");
    expect(answeringNode([])).toBeNull();
  });
});

describe("a test made from a run", () => {
  const run = { id: "run-1", triggerNode: "trigger", startedAt: at(0) };
  const outputs: Record<string, unknown[][]> = {
    trigger: [[{ pedido: 7 }]],
    set: [[{ total: 30 }]],
    if: [[], [{ total: 30 }]],
    loop: [[{ lote: 1 }], [{ hecho: true }]],
  };
  const readNode = vi.fn(async (_runId: string, nodeId: string) => (outputs[nodeId] ? { outputs: outputs[nodeId] } : null));

  beforeEach(() => {
    saved.length = 0;
    readNode.mockClear();
  });

  it("expects the first item of what the run answered with", async () => {
    const test = await testFromRun("f1", run, [node("trigger", 1, at(1), "success", "trigger.webhook"), node("set", 2, at(5))], "Pedido", readNode);
    expect(test).toMatchObject({ flowId: "f1", nodeId: "trigger", input: { pedido: 7 }, expected: { total: 30 }, matchMode: "contains" });
  });

  it("only that it runs when the run answered with nothing — an IF whose items went the other way", async () => {
    const nodes = [node("trigger", 1, at(1), "success", "trigger.webhook"), node("set", 2, at(5)), node("if", 3, at(9), "success", "logic.if")];
    const test = await testFromRun("f1", run, nodes, "Pedido", readNode);
    expect(test).toMatchObject({ expected: {}, matchMode: "runs" });
  });

  it("only that it runs when a loop finished last: its first output is empty by then", async () => {
    const nodes = [node("trigger", 1, at(1), "success", "trigger.webhook"), node("loop", 4, at(20), "success", "logic.loop")];
    const test = await testFromRun("f1", run, nodes, "Lotes", readNode);
    expect(test.matchMode).toBe("runs");
    expect(readNode).not.toHaveBeenCalledWith("run-1", "loop");
  });
});
