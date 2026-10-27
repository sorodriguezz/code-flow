import { describe, expect, it } from "vitest";
import { lanesOf, newLaneReader, readRunLine } from "./subagentLanes";
import { parseRunSteps } from "./runSteps";
import type { AiRunLine } from "../state/aiRunStore";

/** Reads raw stream-json lines the way the store and a stored trace do. */
function read(raws: string[]): AiRunLine[] {
  const reader = newLaneReader();
  const lines: AiRunLine[] = [];
  let last: string | undefined;
  for (const raw of raws) {
    const line = readRunLine(reader, "stdout", raw, last);
    if (!line) continue;
    lines.push(line);
    if (line.text) last = line.text;
  }
  return lines;
}

const delegate = (calls: { id: string; description: string; type?: string; background?: boolean }[]) =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: "Agent",
        input: { description: call.description, prompt: "…", subagent_type: call.type ?? "Explore", run_in_background: call.background },
      })),
    },
  });
const step = (parent: string, command: string) =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id: `s-${command}`, name: "Bash", input: { command } }] },
  });
const result = (id: string, isError = false) =>
  JSON.stringify({
    type: "user",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: "ok" }] },
  });
const mainRead = JSON.stringify({
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id: "m1", name: "Read", input: { file_path: "a.ts" } }] },
});

describe("sub-agent lanes", () => {
  it("give each sub-agent started together its own lane and its own steps", () => {
    const lines = read([
      mainRead,
      delegate([
        { id: "t1", description: "Buscar el flujo", type: "Explore" },
        { id: "t2", description: "Comparar contratos", type: "general-purpose" },
      ]),
      step("t1", "grep agenda"),
      step("t2", "ls src"),
      step("t1", "cat Slots.cs"),
      result("t1"),
      result("t2", true),
    ]);
    const { lanes, total } = lanesOf(lines);
    expect(total).toBe(lines.length);
    expect(lanes.map((lane) => [lane.description, lane.type, lane.status])).toEqual([
      ["Buscar el flujo", "Explore", "done"],
      ["Comparar contratos", "general-purpose", "failed"],
    ]);
    expect(lanes[0].steps).toEqual(["⏵ Bash: grep agenda", "⏵ Bash: cat Slots.cs"]);
    expect(lanes[1].steps).toEqual(["⏵ Bash: ls src"]);
    // Started on the same line, so their bars start together; t2 ended last.
    expect(lanes[0].start).toBe(lanes[1].start);
    expect(lanes[1].end!).toBeGreaterThan(lanes[0].end!);
  });

  it("keep a lane open while it has no end, and mark lines that only end one without printing them", () => {
    const lines = read([delegate([{ id: "t1", description: "Revisar" }]), step("t1", "pwd")]);
    expect(lanesOf(lines).lanes[0]).toMatchObject({ status: "live", end: null });
    const ended = read([delegate([{ id: "t1", description: "Revisar" }]), step("t1", "pwd"), result("t1")]);
    expect(ended[ended.length - 1].text).toBe("");
    // The empty line is not a step, and the sub-agent's steps still read as sub-agent steps.
    expect(parseRunSteps(ended).map((s) => [s.tool, s.sub])).toEqual([
      ["Agent", false],
      ["Bash", true],
    ]);
  });

  it("do not end a background sub-agent on its call's immediate result, only on its notification", () => {
    const lines = read([
      delegate([{ id: "toolu_task1", description: "Revisar archivos", background: true }]),
      result("toolu_task1"),
      `{"type":"system","subtype":"task_started","task_id":"a2d4","tool_use_id":"toolu_task1","description":"Revisar archivos","subagent_type":"general-purpose","is_backgrounded":true}`,
      step("toolu_task1", "echo hola"),
    ]);
    expect(lanesOf(lines).lanes).toMatchObject([{ id: "toolu_task1", status: "live", type: "general-purpose" }]);
    const done = read([
      `{"type":"system","subtype":"task_started","task_id":"a2d4","tool_use_id":"toolu_task1","description":"Revisar archivos","is_backgrounded":true}`,
      step("toolu_task1", "echo hola"),
      `{"type":"system","subtype":"task_notification","task_id":"a2d4","status":"completed","summary":"listo"}`,
    ]);
    expect(lanesOf(done).lanes).toMatchObject([{ status: "done", steps: ["⏵ Bash: echo hola"] }]);
  });

  it("are not drawn for a long Bash, which Claude Code reports as a task too", () => {
    const lines = read([
      `{"type":"system","subtype":"task_started","task_id":"b7","tool_use_id":"toolu_bash","description":"pnpm test --run","task_type":"local_bash"}`,
      mainRead,
      `{"type":"system","subtype":"task_notification","task_id":"b7","tool_use_id":"toolu_bash","status":"completed"}`,
    ]);
    expect(lanesOf(lines).lanes).toEqual([]);
    expect(lines.map((line) => line.text).some((text) => /Sub-agent|Subagente/.test(text))).toBe(false);
  });

  it("are not there for a run that never delegated", () => {
    const lines = read([mainRead, "plain text from another engine"]);
    expect(lines.every((line) => !line.lanes)).toBe(true);
    expect(lanesOf(lines).lanes).toEqual([]);
  });

  it("read Codex's collab calls: the brief names the lane, the wait's state ends it (captured, 0.163)", () => {
    const lines = read([
      `{"type":"item.started","item":{"id":"item_1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"T0","receiver_thread_ids":[],"prompt":"SUBTAREA revisar archivos","agents_states":{},"status":"in_progress"}}`,
      `{"type":"item.completed","item":{"id":"item_1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"T0","receiver_thread_ids":["T1"],"prompt":"SUBTAREA revisar archivos","agents_states":{"T1":{"status":"pending_init","message":null}},"status":"completed"}}`,
      `{"type":"item.started","item":{"id":"item_2","type":"collab_tool_call","tool":"wait","sender_thread_id":"T0","receiver_thread_ids":["T1"],"prompt":null,"agents_states":{},"status":"in_progress"}}`,
    ]);
    expect(lanesOf(lines).lanes).toMatchObject([{ id: "T1", description: "SUBTAREA revisar archivos", status: "live", steps: [] }]);
    const done = read([
      `{"type":"item.completed","item":{"id":"item_1","type":"collab_tool_call","tool":"spawn_agent","sender_thread_id":"T0","receiver_thread_ids":["T1","T2"],"prompt":"Revisar\\nlos archivos","agents_states":{},"status":"completed"}}`,
      `{"type":"item.completed","item":{"id":"item_2","type":"collab_tool_call","tool":"wait","sender_thread_id":"T0","receiver_thread_ids":["T1","T2"],"prompt":null,"agents_states":{"T1":{"status":"completed","message":"hecho sub"},"T2":{"status":"errored","message":null}},"status":"completed"}}`,
    ]);
    expect(lanesOf(done).lanes.map((lane) => [lane.id, lane.description, lane.status])).toEqual([
      ["T1", "Revisar", "done"],
      ["T2", "Revisar", "failed"],
    ]);
  });

  it("read Cline's agents: start and end by parent, the steps in between, the task as its name (captured, 3.0.73)", () => {
    const hook = (name: string, agent: string, parent: string | null) =>
      `{"ts":"t","type":"hook_event","hookEventName":"${name}","agentId":"${agent}","taskId":"c","parentAgentId":${parent ? `"${parent}"` : "null"}}`;
    const lines = read([
      hook("agent_start", "A0", null),
      `{"ts":"t","type":"agent_event","event":{"type":"content_start","contentType":"tool","toolName":"spawn_agent","toolCallId":"call_1","input":{"systemPrompt":"Eres un revisor","task":"SUBTAREA revisar archivos"}}}`,
      hook("tool_call", "A0", null),
      hook("agent_start", "A1", "A0"),
      hook("tool_call", "A1", "A0"),
      `{"ts":"t","type":"agent_event","event":{"type":"content_start","contentType":"tool","toolName":"run_commands","toolCallId":"call_2","input":{"commands":["echo sub"]}}}`,
      `{"ts":"t","type":"agent_event","event":{"type":"content_update","contentType":"tool","toolName":"run_commands","toolCallId":"call_2","update":{"stream":"stdout","chunk":"sub"}}}`,
      `{"ts":"t","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"hecho sub"}}`,
      hook("agent_end", "A1", "A0"),
      `{"ts":"t","type":"agent_event","event":{"type":"content_end","contentType":"tool","toolName":"spawn_agent","toolCallId":"call_1","output":{"text":"hecho sub","iterations":2,"finishReason":"completed"},"durationMs":13}}`,
      hook("tool_result", "A0", null),
      `{"ts":"t","type":"agent_event","event":{"type":"content_end","contentType":"text","text":"FIN"}}`,
    ]);
    expect(lanesOf(lines).lanes).toMatchObject([
      { id: "A1", description: "SUBTAREA revisar archivos", status: "done", steps: ["⏵ run_commands: echo sub", "hecho sub"] },
    ]);
    // The main agent's own lines read as its own; the sub-agent's are marked.
    expect(parseRunSteps(lines).map((step) => [step.text, step.sub])).toEqual([
      ["⏵ spawn_agent: SUBTAREA revisar archivos", false],
      ["⏵ run_commands: echo sub", true],
      ["hecho sub", true],
      ["FIN", false],
    ]);
  });

  it("read an OpenCode task whole when it is reported, finished", () => {
    const task = (status: string) =>
      `{"type":"tool_use","timestamp":1,"sessionID":"s","part":{"id":"p1","callID":"c1","type":"tool","tool":"task","state":{"status":"${status}","input":{"description":"Revisar archivos","prompt":"…","subagent_type":"explore"},"metadata":{"sessionId":"s2"}}}}`;
    expect(lanesOf(read([task("completed")])).lanes).toMatchObject([
      { id: "c1", description: "Revisar archivos", type: "explore", status: "done" },
    ]);
    expect(lanesOf(read([task("error")])).lanes[0].status).toBe("failed");
  });

  it("read grok's background sub-agent: its id from the spawn, its steps while the main agent waits, its end from TaskOutput (captured, 1.0.62)", () => {
    const lines = read([
      String.raw`{"type":"system","subtype":"init","session_id":"01a17978-a245-7410-bbb0-2bd7deee434b","model":"fake"}`,
      String.raw`{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"call_2","name":"spawn_subagent","input":{"prompt":"SUBTAREA revisar archivos","description":"Revisar archivos"}}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_2","content":"{\"type\":\"Text\",\"text\":\"Subagent started in background.\\nsubagent_id: 01a17978-a519-73e2-9760-8febe7e7e348\\ndescription: Revisar archivos\\n\\nWhen you need its result, use get_command_or_subagent_output with task_ids=[\\\"01a17978-a519-73e2-9760-8febe7e7e348\\\"] and a positive timeout_ms.\"}","is_error":false}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"call_3","name":"get_command_or_subagent_output","input":{"task_ids":["01a17978-a519-73e2-9760-8febe7e7e348"],"timeout_ms":20000}}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"call_5","name":"run_terminal_command","input":{"command":"echo sub","description":"eco"}}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_5","content":"{\"type\": \"Bash\", \"exit_code\": 0, \"command\": \"echo sub\"}","is_error":false}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"hecho sub"}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_3","content":"{\"type\": \"TaskOutput\", \"Result\": {\"task_id\": \"01a17978-a519-73e2-9760-8febe7e7e348\", \"status\": \"completed\", \"command\": \"[subagent:general-purpose] Revisar archivos\"}}","is_error":false}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"assistant","message":{"type":"message","role":"assistant","content":[{"type":"text","text":"FIN"}]},"parent_tool_use_id":null}`,
      String.raw`{"type":"result","subtype":"success","is_error":false,"result":"FIN","session_id":"01a17978-a245-7410-bbb0-2bd7deee434b"}`,
    ]);
    const { lanes } = lanesOf(lines);
    expect(lanes).toMatchObject([
      { id: "call_2", description: "Revisar archivos", status: "done", steps: ["⏵ run_terminal_command: echo sub", "hecho sub"] },
    ]);
    // The main agent's own steps stay its own.
    expect(parseRunSteps(lines).filter((step) => !step.sub).map((step) => step.text)).toEqual([
      "⏵ spawn_subagent: Revisar archivos",
      "⏵ get_command_or_subagent_output: 01a17978-a519-73e2-9760-8febe7e7e348",
      "FIN",
    ]);
  });

  it("read grok's foreground sub-agent, and end a background one still out when the run ends", () => {
    const call = (id: string, name: string, input: object) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] }, parent_tool_use_id: null });
    const said = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] }, parent_tool_use_id: null });
    const answer = (id: string, content: string) =>
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, parent_tool_use_id: null });
    const foreground = read([
      call("c1", "spawn_subagent", { prompt: "…", description: "Comparar contratos", background: false }),
      call("c2", "read_file", { path: "a.cs" }),
      said("listo"),
      answer("c1", JSON.stringify({ type: "SubagentCompleted", output: "listo", subagent_id: "01a17977-f153-7d02-a3e9" })),
      said("FIN"),
    ]);
    expect(lanesOf(foreground).lanes).toMatchObject([
      { description: "Comparar contratos", status: "done", steps: ["⏵ read_file: a.cs", "listo"] },
    ]);
    const leftOut = read([
      call("c1", "spawn_subagent", { prompt: "…", description: "Mirar logs" }),
      answer("c1", "Subagent started in background.\nsubagent_id: 01a17978-a519-73e2"),
      said("FIN"),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FIN" }),
    ]);
    const lane = lanesOf(leftOut).lanes[0];
    expect(lane).toMatchObject({ status: "done", steps: [] });
    // Not waited on, so the main agent's "FIN" is not the sub-agent's.
    expect(parseRunSteps(leftOut).map((step) => [step.text, step.sub])).toContainEqual(["FIN", false]);
  });
});
