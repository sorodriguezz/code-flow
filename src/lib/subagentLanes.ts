import { formatAgentLogLine, repeatsStatus } from "./agentLog";
import type { AiRunLine } from "../state/aiRunStore";

/**
 * A run's sub-agents as lanes: which ones it started, what each was asked (its short description),
 * the steps each took, and where in the run each began and ended.
 *
 * The log already marks a sub-agent's step with `↳`, but only as "not the main agent's": with three
 * running at once their steps interleave and nothing says whose is whose. Claude Code does say it —
 * every step of a sub-agent carries `parent_tool_use_id`, the id of the `Task`/`Agent` call that
 * started it — so each line is marked with the lane it belongs to while it is read (`readRunLine`),
 * and the lanes are rebuilt from the marked lines (`lanesOf`).
 *
 * The marks ride on the lines (`AiRunLine.lanes`) rather than in a structure of their own because
 * the lines already travel everywhere a run is shown — the live store, the copy kept with a
 * finished turn, a trace read back from disk, one fetched lazily — and the raw stream the marks are
 * read from exists only at the first step of each of those paths.
 *
 * A lane's position is counted in lines, not seconds: a stored trace keeps no clock, and a live run
 * and its reopened trace have to draw the same bars.
 *
 * # Per engine (each verified against the installed CLI, 2026-10-26)
 *
 * - **Claude Code**: `Task`/`Agent` calls, `task_*` system events, `parent_tool_use_id` on every
 *   sub-agent step. Live, with steps.
 * - **Codex** (0.163, `exec --json`, fake-API probe): `collab_tool_call` items — `spawn_agent` names
 *   the new thread in `receiver_thread_ids` and carries the brief as `prompt`; `wait`/`close_agent`
 *   report `agents_states[id].status`. Live, but the sub-agent's own steps are not in the stream, and
 *   there is no short description: the lane shows the brief's first line.
 * - **Cline** (3.0.73, `--json --auto-approve true`, fake-API probe): `hook_event` `agent_start` /
 *   `agent_end` with `agentId` and `parentAgentId`; the brief is the `task` of the `spawn_agent`
 *   call just before. Its `agent_event` lines carry no agent id, so a step belongs to whichever agent
 *   the last `hook_event` named. `-y` would not offer `spawn_agent` at all; the app does not pass it.
 * - **OpenCode** (1.18.35, read from its `run` command): `--format json` prints only the parent
 *   session, and a tool only once it is finished — so a `task` lane appears whole when it ends,
 *   with its description and type and no steps.
 * - **Grok** (1.0.62, `streaming-messages-json`, fake-API probe): Claude's stream shape, but a
 *   sub-agent's steps carry `parent_tool_use_id: null` like the main agent's. `spawn_subagent`
 *   opens the lane (its `description`); it runs in the background unless `background: false`. A
 *   foreground one ends with its call's result (`SubagentCompleted`); a background one's call
 *   answers at once with its `subagent_id`, and it ends in a `TaskOutput` (`status`) of
 *   `get_command_or_subagent_output`, or with the run. Its steps are told apart only while the main
 *   agent is blocked waiting on exactly one sub-agent — otherwise they stay in the main feed.
 * - **Antigravity (agy)** has sub-agents (`invoke_subagent`), but its `stream-json` as captured
 *   (`step_update`: index and state) names none, and it cannot be pointed at a fake API to check.
 * - **CodeFlow's own engine** has no sub-agents.
 */

/** What one raw line says about a lane. A line may say several things: one message can start two
 *  sub-agents at once. */
export type LaneMark =
  | { id: string; kind: "open"; description: string; type: string }
  | { id: string; kind: "step" }
  | { id: string; kind: "end"; failed: boolean };

/** What reading a run's lines in order has to remember: which lanes are open, which run in the
 *  background (whose tool result arrives at once and is not their end), and the task id each
 *  background one is reported under. */
export interface LaneReader {
  open: Set<string>;
  background: Set<string>;
  byTask: Map<string, string>;
  /** Cline: each sub-agent's parent, the agent the last `hook_event` named, the `spawn_agent` call
   *  waiting for its agent to start (and its brief), and which agent each call started. */
  parentOf: Map<string, string>;
  current: string | null;
  pending: { call: string; task: string } | null;
  agentOfCall: Map<string, string>;
  /** Grok: its lanes, the lane each `subagent_id` is, and the main agent's calls still waiting on
   *  lanes (a foreground spawn, a wait for output) — whose lanes own the steps meanwhile. */
  grok: Set<string>;
  laneOfSubagent: Map<string, string>;
  waiting: Map<string, string[]>;
}

export function newLaneReader(): LaneReader {
  return {
    open: new Set(),
    background: new Set(),
    byTask: new Map(),
    parentOf: new Map(),
    current: null,
    pending: null,
    agentOfCall: new Map(),
    grok: new Set(),
    laneOfSubagent: new Map(),
    waiting: new Map(),
  };
}

/** Grok's calls that block the main agent on a sub-agent's output. */
const GROK_WAITS = new Set(["get_command_or_subagent_output", "wait_commands_or_subagents"]);

/** The one open lane the main agent is waiting on, if it is waiting on exactly one. */
function waitedLane(reader: LaneReader): string | null {
  const lanes = new Set<string>();
  for (const ids of reader.waiting.values()) for (const id of ids) if (reader.open.has(id)) lanes.add(id);
  return lanes.size === 1 ? [...lanes][0] : null;
}

/** A tool result's text, whether it came as a string or as blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isRecord(block) ? str(block.text) : "")).join("\n");
}

/** A brief as a lane's name: its first line, cut short — for the engines that give no description. */
function short(text: string): string {
  const line = text.split("\n").find((row) => row.trim())?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Codex's sub-agent statuses that are an end; `shutdown` is one closed after it finished. */
const CODEX_ENDED = new Set(["completed", "shutdown", "errored", "interrupted", "not_found"]);

/** The statuses a sub-agent ends with — mirrors `track_subagent` in `ai.rs`. */
const DONE = new Set(["completed", "failed", "killed", "stopped", "cancelled", "error"]);
/** The tools that start a sub-agent: `Task` until Claude Code renamed it `Agent`. */
const DELEGATES = new Set(["Task", "Agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function laneMarksOf(reader: LaneReader, raw: string): LaneMark[] {
  // Most lines say nothing about sub-agents; skip the parse for them. Cline's `agent_event` lines
  // matter only once a sub-agent exists, or for the call that starts one.
  if (raw.includes('"agent_event"')) {
    if (reader.parentOf.size === 0 && !raw.includes("spawn_agent")) return [];
  } else if (
    !raw.includes("tool_use") &&
    !raw.includes('"task_') &&
    !raw.includes("tool_result") &&
    !raw.includes("collab_tool_call") &&
    !raw.includes('"hook_event"') &&
    // Grok: a sub-agent's prose while the main agent waits on it, and the run's end.
    !(reader.waiting.size > 0 && raw.includes('"assistant"')) &&
    !(reader.grok.size > 0 && raw.includes('"result"'))
  ) {
    return [];
  }
  let event: unknown;
  try {
    event = JSON.parse(raw.trim());
  } catch {
    return [];
  }
  if (!isRecord(event)) return [];

  if (event.type === "system") {
    const task = str(event.task_id);
    if (event.subtype === "task_started") {
      const id = str(event.tool_use_id) || task;
      if (!id) return [];
      if (task) reader.byTask.set(task, id);
      if (event.is_backgrounded === true) reader.background.add(id);
      reader.open.add(id);
      return [{ id, kind: "open", description: str(event.description), type: str(event.subagent_type) }];
    }
    if (event.subtype === "task_notification" || event.subtype === "task_updated") {
      const status = event.subtype === "task_updated" && isRecord(event.patch) ? event.patch.status : event.status;
      if (typeof status !== "string" || !DONE.has(status)) return [];
      const id = reader.byTask.get(task) ?? (str(event.tool_use_id) || task);
      if (!id) return [];
      reader.open.delete(id);
      return [{ id, kind: "end", failed: status !== "completed" }];
    }
    return [];
  }

  if (event.type === "item.started" || event.type === "item.completed") return codexMarks(reader, event);
  if (event.type === "hook_event") return clineHookMarks(reader, event);
  if (event.type === "agent_event") return clineEventMarks(reader, event);
  // OpenCode: a finished `task` call, start and end on the one line.
  if (event.type === "tool_use" && isRecord(event.part) && event.part.tool === "task") {
    const part = event.part;
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};
    const id = str(part.callID) || str(part.id);
    if (!id) return [];
    return [
      { id, kind: "open", description: short(str(input.description) || str(input.prompt)), type: str(input.subagent_type) },
      { id, kind: "end", failed: state.status === "error" },
    ];
  }

  const message = isRecord(event.message) ? event.message : null;
  const content = message && Array.isArray(message.content) ? message.content : [];
  const parent = str(event.parent_tool_use_id);

  if (event.type === "assistant") {
    if (parent) return [{ id: parent, kind: "step" }];
    const marks: LaneMark[] = [];
    let mainAgent = false;
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool_use" || !str(part.id)) continue;
      const name = str(part.name);
      const input = isRecord(part.input) ? part.input : {};
      const id = str(part.id);
      if (name === "spawn_subagent") {
        mainAgent = true;
        reader.grok.add(id);
        reader.open.add(id);
        if (input.background === false) reader.waiting.set(id, [id]);
        else reader.background.add(id);
        marks.push({ id, kind: "open", description: str(input.description) || short(str(input.prompt)), type: str(input.subagent_type) });
      } else if (GROK_WAITS.has(name) && reader.grok.size > 0) {
        mainAgent = true;
        // `timeout_ms` 0 (or none) on the output call returns at once: that is a look, not a wait.
        const blocks = name === "wait_commands_or_subagents" || (typeof input.timeout_ms === "number" && input.timeout_ms > 0);
        const ids = Array.isArray(input.task_ids) ? input.task_ids : [];
        const lanes = ids.map((sub) => reader.laneOfSubagent.get(str(sub)) ?? "").filter((lane) => reader.open.has(lane));
        if (blocks && lanes.length > 0) reader.waiting.set(id, lanes);
      } else if (DELEGATES.has(name)) {
        if (input.run_in_background === true) reader.background.add(id);
        reader.open.add(id);
        marks.push({ id, kind: "open", description: str(input.description), type: str(input.subagent_type) });
      }
    }
    // Grok's sub-agent steps have no parent: while the main agent waits on one lane, they are its.
    if (!mainAgent && marks.length === 0) {
      const lane = waitedLane(reader);
      if (lane) return [{ id: lane, kind: "step" }];
    }
    return marks;
  }

  // Grok's run is over, and with it every sub-agent it was still owed.
  if (event.type === "result" && reader.grok.size > 0) {
    const marks: LaneMark[] = [];
    for (const id of reader.grok) {
      if (!reader.open.delete(id)) continue;
      marks.push({ id, kind: "end", failed: event.is_error === true });
    }
    return marks;
  }

  // A foreground sub-agent ends when its call's result comes back to the main agent.
  if (event.type === "user" && !parent) {
    const marks: LaneMark[] = [];
    for (const part of content) {
      if (!isRecord(part) || part.type !== "tool_result") continue;
      const id = str(part.tool_use_id);
      reader.waiting.delete(id);
      if (reader.grok.size > 0) marks.push(...grokResultMarks(reader, id, resultText(part.content)));
      if (!reader.open.has(id) || reader.background.has(id)) continue;
      reader.open.delete(id);
      marks.push({ id, kind: "end", failed: part.is_error === true });
    }
    return marks;
  }
  return [];
}

/** What a tool result tells about grok's sub-agents: the id a spawn was given, and the ends a
 *  `TaskOutput` reports. */
function grokResultMarks(reader: LaneReader, call: string, text: string): LaneMark[] {
  if (reader.grok.has(call)) {
    const sub = /subagent_id\W+([0-9a-f][0-9a-f-]{15,})/i.exec(text)?.[1];
    if (sub) reader.laneOfSubagent.set(sub, call);
    return [];
  }
  if (!text.includes("TaskOutput")) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const result = isRecord(parsed) ? parsed.Result : null;
  const marks: LaneMark[] = [];
  for (const entry of Array.isArray(result) ? result : [result]) {
    if (!isRecord(entry)) continue;
    const lane = reader.laneOfSubagent.get(str(entry.task_id));
    const status = str(entry.status);
    if (!lane || !reader.open.has(lane) || status === "running" || status === "pending" || !status) continue;
    reader.open.delete(lane);
    marks.push({ id: lane, kind: "end", failed: status !== "completed" });
  }
  return marks;
}

function codexMarks(reader: LaneReader, event: Record<string, unknown>): LaneMark[] {
  const item = isRecord(event.item) ? event.item : null;
  if (!item || item.type !== "collab_tool_call") return [];
  const marks: LaneMark[] = [];
  // The thread exists once the call has completed; `item.started` names none yet.
  if (item.tool === "spawn_agent" && event.type === "item.completed" && Array.isArray(item.receiver_thread_ids)) {
    for (const id of item.receiver_thread_ids) {
      if (typeof id !== "string" || reader.open.has(id)) continue;
      reader.open.add(id);
      marks.push({ id, kind: "open", description: short(str(item.prompt)), type: "" });
    }
  }
  if (isRecord(item.agents_states)) {
    for (const [id, state] of Object.entries(item.agents_states)) {
      const status = isRecord(state) ? str(state.status) : "";
      if (!reader.open.has(id) || !CODEX_ENDED.has(status)) continue;
      reader.open.delete(id);
      marks.push({ id, kind: "end", failed: status !== "completed" && status !== "shutdown" });
    }
  }
  return marks;
}

function clineHookMarks(reader: LaneReader, event: Record<string, unknown>): LaneMark[] {
  const agent = str(event.agentId);
  if (!agent) return [];
  const parent = str(event.parentAgentId);
  if (event.hookEventName === "agent_start" && parent) {
    reader.parentOf.set(agent, parent);
    reader.current = agent;
    reader.open.add(agent);
    const pending = reader.pending;
    reader.pending = null;
    if (pending) reader.agentOfCall.set(pending.call, agent);
    return [{ id: agent, kind: "open", description: pending?.task ?? "", type: "" }];
  }
  if (event.hookEventName === "agent_end" && reader.parentOf.has(agent)) {
    reader.current = reader.parentOf.get(agent) ?? null;
    if (!reader.open.delete(agent)) return [];
    return [{ id: agent, kind: "end", failed: false }];
  }
  reader.current = agent;
  return [];
}

function clineEventMarks(reader: LaneReader, event: Record<string, unknown>): LaneMark[] {
  const inner = isRecord(event.event) ? event.event : null;
  if (!inner) return [];
  if (inner.contentType === "tool" && inner.toolName === "spawn_agent") {
    const call = str(inner.toolCallId);
    if (inner.type === "content_start") {
      const input = isRecord(inner.input) ? inner.input : {};
      reader.pending = { call, task: short(str(input.task)) };
      return [];
    }
    // The agent's own end says it stopped; the call's result says whether it finished its task.
    if (inner.type === "content_end") {
      const agent = reader.agentOfCall.get(call);
      const output = isRecord(inner.output) ? inner.output : {};
      const failed = !!inner.error || (typeof output.finishReason === "string" && output.finishReason !== "completed");
      return agent && failed ? [{ id: agent, kind: "end", failed: true }] : [];
    }
  }
  const current = reader.current;
  return current && reader.parentOf.has(current) ? [{ id: current, kind: "step" }] : [];
}

/**
 * One raw line as the log keeps it: formatted, and marked with the lanes it speaks of. `null` for a
 * line that renders as nothing and marks nothing — or only repeats the status line before it.
 *
 * A line that only ends a lane (a tool result, a task notification with nothing to print) is kept
 * with empty text: the steps skip it, and the lane needs to know where it ended.
 */
export function readRunLine(
  reader: LaneReader,
  stream: AiRunLine["stream"],
  raw: string,
  previousText: string | undefined,
): AiRunLine | null {
  const text = formatAgentLogLine(raw);
  // A step mark without anything printed has nothing to add to its lane.
  const marks = laneMarksOf(reader, raw).filter((mark) => mark.kind !== "step" || text !== null);
  if (marks.length === 0) {
    if (text === null || repeatsStatus(previousText, text)) return null;
    return { stream, text };
  }
  // A sub-agent's step reads as one wherever it came from — Claude marks its own, Cline does not.
  const sub = text !== null && marks.some((mark) => mark.kind === "step");
  const shown = sub ? text.split("\n").map((row) => (row.startsWith(SUB) ? row : `${SUB}${row}`)).join("\n") : text;
  return { stream, text: shown ?? "", lanes: marks };
}

export type LaneStatus = "live" | "done" | "failed";

export interface SubagentLane {
  /** The `Task`/`Agent` call's id. */
  id: string;
  /** What it was asked to do, in a few words; empty when its start fell out of the log. */
  description: string;
  /** Its `subagent_type` (Explore, general-purpose…); empty when not said. */
  type: string;
  status: LaneStatus;
  /** Line indexes: where it started and, once done, where it ended. */
  start: number;
  end: number | null;
  /** Its own steps, as the log prints them (without the `↳`). */
  steps: string[];
}

const SUB = "↳ ";
/** Steps kept per lane — enough to read back, bounded like the log itself. */
const MAX_LANE_STEPS = 300;

/** The lanes the marked `lines` describe, in the order they started, and how many lines there are
 *  — the span the bars are drawn against. */
export function lanesOf(lines: readonly AiRunLine[] | undefined): { lanes: SubagentLane[]; total: number } {
  const lanes: SubagentLane[] = [];
  if (!lines) return { lanes, total: 0 };
  const byId = new Map<string, SubagentLane>();
  const laneFor = (id: string, at: number): SubagentLane => {
    let lane = byId.get(id);
    if (!lane) {
      lane = { id, description: "", type: "", status: "live", start: at, end: null, steps: [] };
      byId.set(id, lane);
      lanes.push(lane);
    }
    return lane;
  };
  lines.forEach((line, at) => {
    for (const mark of line.lanes ?? []) {
      const lane = laneFor(mark.id, at);
      if (mark.kind === "open") {
        lane.description = mark.description || lane.description;
        lane.type = mark.type || lane.type;
        // Opened again: a background sub-agent's call returns at once, and its start comes after.
        lane.status = "live";
        lane.end = null;
      } else if (mark.kind === "end") {
        lane.status = mark.failed ? "failed" : "done";
        lane.end = at;
      } else {
        for (const row of line.text.split("\n")) {
          if (!row.trim()) continue;
          lane.steps.push(row.startsWith(SUB) ? row.slice(SUB.length) : row);
        }
        if (lane.steps.length > MAX_LANE_STEPS) lane.steps.splice(0, lane.steps.length - MAX_LANE_STEPS);
      }
    }
  });
  return { lanes, total: lines.length };
}
