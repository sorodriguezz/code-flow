import { describe, expect, it } from "vitest";
import { applyScriptRecord, highlightScript, isScriptTool, scriptSavings, scriptStatus, scriptTokens, SCRIPT_MARK, type AppScript } from "./appScript";
import { parseRunSteps } from "./runSteps";
import { formatAgentLogLine } from "./agentLog";
import { turnActivity } from "./turnActivity";
import type { AiRunLine } from "../state/aiRunStore";

const rec = (value: object) => `${SCRIPT_MARK}${JSON.stringify(value)}`;
const start = (id: string, title = "Revisar servicios") => rec({ id, phase: "start", title, code: 'return app.call("list_services", {});', acts: true });
const call = (id: string, index: number, command: string, ok = true, error?: string) =>
  rec({ id, phase: "call", index, call: { command, about: "", ok, ms: 12, ...(error ? { error } : {}) } });
const end = (id: string, extra: object = {}) => rec({ id, phase: "end", ok: true, ms: 40, error: null, failedAt: null, interrupted: false, returned: "[]", ...extra });
const lines = (...texts: string[]): AiRunLine[] => texts.map((text, i) => ({ stream: "stdout", text, at: 1000 + i * 100 }) as AiRunLine);

describe("a CodeFlow script's records", () => {
  it("build one script from its start, its calls and its end", () => {
    const scripts = new Map<string, AppScript>();
    expect(applyScriptRecord(scripts, start("s1"))?.started).toBe(true);
    applyScriptRecord(scripts, call("s1", 0, "list_services"));
    applyScriptRecord(scripts, call("s1", 1, "services_restart", false, "port taken"));
    const done = applyScriptRecord(scripts, end("s1"))?.script;
    expect(done?.calls.map((c) => c.command)).toEqual(["list_services", "services_restart"]);
    expect(done && scriptStatus(done)).toBe("partial");
    expect(done?.returned).toBe("[]");
  });

  it("say how a script ended", () => {
    const base: AppScript = { id: "x", title: "", code: "", acts: true, calls: [], done: false, ok: false, interrupted: false };
    expect(scriptStatus(base)).toBe("running");
    expect(scriptStatus({ ...base, done: true, ok: true })).toBe("ok");
    expect(scriptStatus({ ...base, done: true, error: "boom" })).toBe("failed");
    expect(scriptStatus({ ...base, done: true, interrupted: true, error: "The script ran out of time (300 s)." })).toBe("timeout");
    expect(scriptStatus({ ...base, done: true, interrupted: true, error: "The script was stopped." })).toBe("stopped");
  });

  it("ignore lines that are not records", () => {
    const scripts = new Map<string, AppScript>();
    expect(applyScriptRecord(scripts, "⏵ Read: a.ts")).toBeNull();
    expect(applyScriptRecord(scripts, `${SCRIPT_MARK}{not json`)).toBeNull();
    expect(applyScriptRecord(scripts, rec({ phase: "start" }))).toBeNull();
  });

  it("know the tool however a CLI prefixes it", () => {
    expect(isScriptTool("mcp__codeflow_map__app_run")).toBe(true);
    expect(isScriptTool("codeflow_map.app_run")).toBe(true);
    expect(isScriptTool("app_run")).toBe(true);
    expect(isScriptTool("app_runner")).toBe(false);
    expect(isScriptTool("mcp__codeflow_map__app_call")).toBe(false);
  });
});

describe("a script in the run's steps", () => {
  it("joins the CLI's line for the call when the line comes first (Claude Code)", () => {
    const steps = parseRunSteps(lines("⏵ mcp__codeflow_map__app_run: Revisar servicios", start("s1"), call("s1", 0, "list_services"), end("s1"), "Listo."));
    expect(steps).toHaveLength(2);
    expect(steps[0].tool).toBe("mcp__codeflow_map__app_run");
    expect(steps[0].script?.calls).toHaveLength(1);
    expect(steps[0].script?.done).toBe(true);
    expect(steps[1].kind).toBe("text");
  });

  it("joins the line when it comes after the records (the local agent logs a call once it ran)", () => {
    const steps = parseRunSteps(lines(start("s1"), call("s1", 0, "list_services"), end("s1"), "⏵ app_run: Revisar servicios"));
    expect(steps).toHaveLength(1);
    expect(steps[0].script?.title).toBe("Revisar servicios");
  });

  it("keeps two scripts apart, and a refused call without a record does not take the next one's", () => {
    const steps = parseRunSteps(
      lines(
        "⏵ mcp__codeflow_map__app_run: Uno",
        "⏵ mcp__codeflow_map__app_run: Dos",
        start("b", "Dos"),
        end("b"),
      ),
    );
    expect(steps).toHaveLength(2);
    expect(steps[0].script).toBeUndefined();
    expect(steps[1].script?.id).toBe("b");
  });

  it("shows a script live, before it ends", () => {
    const steps = parseRunSteps(lines("⏵ mcp__codeflow_map__app_run: Revisar", start("s1", "Revisar"), call("s1", 0, "list_services")));
    expect(steps[0].script && scriptStatus(steps[0].script)).toBe("running");
  });

  it("is named by its title in the CLI's line, and counts as CodeFlow under the answer", () => {
    const line = formatAgentLogLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__codeflow_map__app_run", input: { title: "Revisar servicios", code: "return 1;" } }] } }),
    );
    expect(line).toBe("⏵ mcp__codeflow_map__app_run: Revisar servicios");
    const groups = turnActivity(parseRunSteps(lines(line!, start("s1"), end("s1"), "⏵ mcp__codeflow_map__app_call: list_services")));
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("app");
    expect(groups[0].count).toBe(2);
  });
});

describe("the script's code, highlighted", () => {
  it("marks the app's calls, strings, keywords and comments, and keeps every character", () => {
    const code = 'const s = app.call("list_services", {}); // all\nreturn s.length > 2;';
    const tokens = highlightScript(code);
    expect(tokens.map((t) => t.text).join("")).toBe(code);
    expect(tokens.find((t) => t.kind === "call")?.text).toBe("app.call");
    expect(tokens.find((t) => t.kind === "string")?.text).toBe('"list_services"');
    expect(tokens.find((t) => t.kind === "comment")?.text).toBe("// all");
    expect(tokens.filter((t) => t.kind === "keyword").map((t) => t.text)).toEqual(["const", "return"]);
  });
});

describe("what a script saves", () => {
  it("reads the bytes the end record carries as estimated tokens", () => {
    const scripts = new Map<string, AppScript>();
    applyScriptRecord(scripts, start("t1"));
    const running = scripts.get("t1")!;
    expect(scriptTokens(running)).toBeNull();
    const done = applyScriptRecord(scripts, end("t1", { readBytes: 40_000, returnedBytes: 801 }))?.script;
    expect(done && scriptTokens(done)).toEqual({ read: 10_000, returned: 201 });
    // A record written before these were counted has none to show.
    const old = applyScriptRecord(new Map(), end("t2"))?.script;
    expect(old && scriptTokens(old)).toBeNull();
  });

  it("adds up a window's counters, scripts beside single calls", () => {
    const rows = [
      { kind: "ai_scripts", key: "script.runs", count: 3, tokens: 0 },
      { kind: "ai_scripts", key: "script.calls", count: 41, tokens: 0 },
      { kind: "ai_scripts", key: "script.read", count: 0, tokens: 90_000 },
      { kind: "ai_scripts", key: "script.returned", count: 0, tokens: 1_200 },
      { kind: "ai_scripts", key: "direct.calls", count: 5, tokens: 0 },
      { kind: "ai_scripts", key: "direct.returned", count: 0, tokens: 7_500 },
      { kind: "ai", key: "script.read", count: 0, tokens: 1 },
    ];
    expect(scriptSavings(rows)).toEqual({ runs: 3, calls: 41, read: 90_000, returned: 1_200, directCalls: 5, direct: 7_500 });
    expect(scriptSavings([]).runs).toBe(0);
  });
});
