import { describe, expect, it } from "vitest";
import { formatAgentLogLine, repeatsStatus, trackSubagents } from "./agentLog";

/** Lines from `claude -p /compact --output-format stream-json --verbose` on 2.1.266, trimmed. */
const COMPACTING = `{"type":"system","subtype":"status","status":"compacting","session_id":"cf5e83bd"}`;
const COMPACTED = `{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"cf5e83bd"}`;
const HOOK = `{"type":"system","subtype":"hook_started","hook_name":"SessionStart:resume","session_id":"cf5e83bd"}`;

function boundary(pre: number, post: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    compact_metadata: { trigger: "manual", pre_tokens: pre, post_tokens: post },
  });
}

describe("formatAgentLogLine — compaction", () => {
  it("says the conversation is being compacted, once per status", () => {
    const line = formatAgentLogLine(COMPACTING);
    expect(line).toMatch(/^· /);
    expect(repeatsStatus(line ?? undefined, formatAgentLogLine(COMPACTING) ?? "")).toBe(true);
  });

  it("keeps hooks and the bare status change out of the log", () => {
    expect(formatAgentLogLine(HOOK)).toBeNull();
    expect(formatAgentLogLine(COMPACTED)).toBeNull();
  });

  it("gives the shrink as a percentage only when the context really shrank", () => {
    const shrunk = formatAgentLogLine(boundary(152_000, 9_100)) ?? "";
    expect(shrunk).toContain("94");
    const grew = formatAgentLogLine(boundary(292, 808)) ?? "";
    expect(grew).toMatch(/^· /);
    expect(grew).not.toMatch(/\d/);
  });

  it("never folds what the model or a tool said, however often it repeats", () => {
    expect(repeatsStatus("⏵ Bash: npm test", "⏵ Bash: npm test")).toBe(false);
    expect(repeatsStatus("· claude-opus-4-8", "· claude-haiku-4-5")).toBe(false);
  });
});

/** Lines Claude Code 2.1.266 printed around a background `Task`, captured against a fake API. */
const STARTED = `{"type":"system","subtype":"task_started","task_id":"a2d4","tool_use_id":"toolu_task1","description":"Revisar archivos","subagent_type":"general-purpose","is_backgrounded":true}`;
const PROGRESS = `{"type":"system","subtype":"task_progress","task_id":"a2d4","tool_use_id":"toolu_task1","description":"Running eco","last_tool_name":"Bash"}`;
const SUB_STEP = `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_sub1","name":"Bash","input":{"command":"echo hola"}}]},"parent_tool_use_id":"toolu_task1"}`;
const DONE = `{"type":"system","subtype":"task_notification","task_id":"a2d4","tool_use_id":"toolu_task1","status":"completed","summary":"listo"}`;

describe("sub-agents", () => {
  it("are open from their start to their notification, with the step they reported last", () => {
    let open = trackSubagents({}, STARTED);
    expect(open).toEqual({ a2d4: { description: "Revisar archivos", progress: null } });
    open = trackSubagents(open, PROGRESS);
    expect(open.a2d4.progress).toBe("Running eco");
    expect(trackSubagents(open, SUB_STEP)).toBe(open);
    expect(trackSubagents(open, DONE)).toEqual({});
  });

  it("returns the same object for a line that says nothing about them", () => {
    const open = {};
    expect(trackSubagents(open, COMPACTING)).toBe(open);
    expect(trackSubagents(open, "plain text")).toBe(open);
  });

  it("show in the log as started and done, their own steps marked", () => {
    expect(formatAgentLogLine(STARTED)).toMatch(/^· .*Revisar archivos/);
    expect(formatAgentLogLine(PROGRESS)).toBeNull();
    expect(formatAgentLogLine(SUB_STEP)).toBe("↳ ⏵ Bash: echo hola");
    expect(formatAgentLogLine(DONE)).toMatch(/^· /);
  });
});

describe("CodeFlow's own engine", () => {
  const line = (event: Record<string, unknown>) => formatAgentLogLine(JSON.stringify({ type: "codeflow", ...event }));

  it("draws its tools under the names the run card already reads", () => {
    expect(line({ event: "tool", tool: "read_file", arg: "src/cart.js", ok: true })).toBe("⏵ Read: src/cart.js");
    expect(line({ event: "tool", tool: "edit_file", arg: "src/cart.js", ok: true })).toBe("⏵ Edit: src/cart.js");
    expect(line({ event: "tool", tool: "search", arg: "total", ok: true })).toBe("⏵ Grep: total");
    expect(line({ event: "tool", tool: "run_command", arg: "npm test", ok: true })).toBe("⏵ Bash: npm test");
  });

  it("reads the repository map's lookups as searches and listings, and says the map once", () => {
    expect(line({ event: "tool", tool: "find_symbol", arg: "applyDiscount", ok: true })).toBe("⏵ Grep: applyDiscount");
    expect(line({ event: "tool", tool: "find_usages", arg: "cartTotal", ok: true })).toBe("⏵ Grep: cartTotal");
    expect(line({ event: "tool", tool: "outline", arg: "src/cart.js", ok: true })).toBe("⏵ LS: src/cart.js");
    expect(line({ event: "map", files: 23, symbols: 30, parsed: 23, ms: 3 })).toMatch(/^· .*23.*3 ms$/);
  });

  it("keeps a failed call's reason off the path, on a line of its own", () => {
    expect(line({ event: "tool", tool: "edit_file", arg: "a.ts", ok: false, detail: "old_text was not found" })).toBe(
      "⏵ Edit: a.ts\n· old_text was not found",
    );
  });

  it("shows the model as the banner and its words as text", () => {
    expect(line({ event: "start", model: "qwen2.5-coder:7b" })).toBe("· qwen2.5-coder:7b");
    expect(line({ event: "text", text: "Voy a leer el archivo." })).toBe("Voy a leer el archivo.");
    expect(line({ event: "unknown" })).toBeNull();
  });
});
