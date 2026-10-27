/** Turns one raw line of an AI CLI's output into something worth showing in the run log.
 *
 * The agentic CLIs stream structured events (Claude's `--output-format stream-json` emits one
 * JSON object per line), which carry exactly what the user wants to see while a run is in
 * flight — "it's reading App.tsx", "it's running the tests" — but only if the JSON is unwrapped
 * first. Anything that isn't a recognized event is passed through untouched, so the engines that
 * just print plain text keep working with no special-casing.
 *
 * Returning `null` hides the line: some events (tool results, token bookkeeping, the final
 * verdict that's about to be rendered as the answer itself) are pure noise in a live log.
 */

import { translate } from "../state/languageStore";

/** Fields that usually hold the interesting argument of a tool call, in order of preference. */
const TOOL_ARG_KEYS = ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "prompt"];

const MAX_TEXT = 160;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TEXT ? `${oneLine.slice(0, MAX_TEXT)}…` : oneLine;
}

function toolCallLabel(name: string, input: unknown): string {
  if (!isRecord(input)) return name;
  // A sub-agent is named by its short description; its prompt is the long brief behind it. Cline's
  // `spawn_agent` has no description, only its `task`.
  if ((name === "Task" || name === "Agent" || name === "spawn_subagent") && typeof input.description === "string" && input.description.trim()) {
    return `${name}: ${truncate(input.description)}`;
  }
  if (name === "spawn_agent" && typeof input.task === "string" && input.task.trim()) return `${name}: ${truncate(input.task)}`;
  // Cline's tools take lists (`commands`, `paths`): the first item is what it is doing.
  for (const value of Object.values(input)) {
    if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim() && !TOOL_ARG_KEYS.some((key) => typeof input[key] === "string")) {
      return `${name}: ${truncate(value[0])}`;
    }
  }
  for (const key of TOOL_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return `${name}: ${truncate(value)}`;
  }
  return name;
}

/** Summarizes an assistant turn: its prose, plus a line per tool it decided to call. */
function assistantLines(message: unknown): string[] {
  if (!isRecord(message)) return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const lines: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      lines.push(truncate(part.text));
    } else if (part.type === "tool_use" && typeof part.name === "string") {
      lines.push(`⏵ ${toolCallLabel(part.name, part.input)}`);
    }
  }
  return lines;
}

/** How a line about the run itself starts — as opposed to the model's words or a tool it called. */
const STATUS_MARK = "· ";
/** How a sub-agent's own step starts, so it does not read as the main agent's. */
const SUBAGENT_MARK = "↳ ";

/** The statuses a sub-agent ends with — mirrors `track_subagent` in `ai.rs`. */
const SUBAGENT_DONE = new Set(["completed", "failed", "killed", "stopped", "cancelled", "error"]);

/** The `task_type`s that are a sub-agent — mirrors `AGENT_TASKS` in `ai.rs`. */
const AGENT_TASKS = new Set(["local_agent", "remote_agent", "in_process_teammate"]);

/**
 * Whether a `task_started` is a sub-agent. Claude Code reports a long or background `Bash` the same
 * way (`task_type: "local_bash"`, the command as its description); only an agent task, or one that
 * names a `subagent_type`, is a sub-agent. No `task_type` at all is an older CLI, where only
 * sub-agents were tasks.
 */
export function isAgentTask(event: Record<string, unknown>): boolean {
  if (typeof event.subagent_type === "string" && event.subagent_type) return true;
  return typeof event.task_type !== "string" || AGENT_TASKS.has(event.task_type);
}

/** One sub-agent still working: what it was asked to do, and the step it reported last. */
export interface SubagentState {
  description: string;
  progress: string | null;
}

/**
 * The run's open sub-agents after one raw line of its output — the same object when the line says
 * nothing about them, so a caller can skip the write.
 *
 * Claude Code (2.1.266, captured against a fake API) runs a `Task` sub-agent in the background and
 * says so in `system` events: `task_started` with its description, `task_progress` per step, and
 * `task_notification` (or `task_updated` with a terminal `patch.status`) when it is done. Between
 * them the main stream can be silent for minutes — which is the run working, and what the card has
 * to say instead of "no output".
 */
export function trackSubagents(open: Record<string, SubagentState>, raw: string): Record<string, SubagentState> {
  if (!raw.includes('"task_')) return open;
  let event: unknown;
  try {
    event = JSON.parse(raw.trim());
  } catch {
    return open;
  }
  if (!isRecord(event) || event.type !== "system" || typeof event.task_id !== "string") return open;
  const id = event.task_id;
  const description = typeof event.description === "string" ? event.description : "";
  switch (event.subtype) {
    case "task_started":
      return isAgentTask(event) ? { ...open, [id]: { description, progress: null } } : open;
    case "task_progress":
      return open[id] ? { ...open, [id]: { ...open[id], progress: description || open[id].progress } } : open;
    case "task_notification":
    case "task_updated": {
      const status = event.subtype === "task_updated" && isRecord(event.patch) ? event.patch.status : event.status;
      if (typeof status !== "string" || !SUBAGENT_DONE.has(status) || !open[id]) return open;
      const { [id]: _done, ...rest } = open;
      return rest;
    }
    default:
      return open;
  }
}

/**
 * The few `system` events worth a line: which model answered, and Claude summarising the
 * conversation — on `/compact`, or by itself when the window fills mid-turn. A summary can take a
 * minute, and without these the log said nothing at all for that minute.
 */
function systemLine(event: Record<string, unknown>): string | null {
  if (event.subtype === "init") return typeof event.model === "string" ? `${STATUS_MARK}${event.model}` : null;
  if (event.subtype === "status" && event.status === "compacting") return `${STATUS_MARK}${translate("chat.compacting")}…`;
  // A sub-agent starting and finishing; its steps arrive as its own `assistant` lines, marked `↳`.
  if (event.subtype === "task_started" && typeof event.description === "string" && isAgentTask(event)) {
    return `${STATUS_MARK}${translate("ai.subagentStarted", { task: event.description })}`;
  }
  if (event.subtype === "task_notification" && typeof event.status === "string" && SUBAGENT_DONE.has(event.status)) {
    return `${STATUS_MARK}${translate(event.status === "completed" ? "ai.subagentDone" : "ai.subagentFailed")}`;
  }
  if (event.subtype === "compact_boundary") {
    const meta = isRecord(event.compact_metadata) ? event.compact_metadata : {};
    const before = typeof meta.pre_tokens === "number" ? meta.pre_tokens : 0;
    const after = typeof meta.post_tokens === "number" ? meta.post_tokens : 0;
    // Only a real shrink is worth a figure: a short conversation's summary can outweigh it.
    const percent = before > 0 && after > 0 && after < before ? Math.round((1 - after / before) * 100) : 0;
    return `${STATUS_MARK}${percent > 0 ? translate("chat.compactedBy", { percent }) : translate("chat.compactedReply")}`;
  }
  return null;
}

/**
 * Whether `text` only repeats the status line right before it. Claude says `compacting` again every
 * few seconds while a summary is written; the log says it once. Lines from the model or a tool are
 * never folded — the same command run twice ran twice.
 */
export function repeatsStatus(previous: string | undefined, text: string): boolean {
  return text.startsWith(STATUS_MARK) && previous === text;
}

/**
 * The steps of CodeFlow's own engine (`local_agent` in Rust), drawn in the vocabulary the run card
 * already reads: its tools under the names Claude Code gives the same actions, so a step's phase
 * (`runSteps.phaseOfTool`) and the "files touched" chips work unchanged.
 */
const CODEFLOW_TOOLS: Record<string, string> = {
  read_file: "Read",
  list_files: "LS",
  find_files: "Glob",
  search: "Grep",
  edit_file: "Edit",
  write_file: "Write",
  run_command: "Bash",
  // The repository map's tools (`codemap`): looking a name up reads as a search, a file's outline
  // as a listing — neither is a file the run read.
  find_symbol: "Grep",
  find_usages: "Grep",
  outline: "LS",
  // Knowledge and memories are searches too; the app's own tools (service logs, a note, a saved
  // request) keep their names — none of them is a file of the repository the chips could name.
  search_knowledge: "Grep",
  recall: "Grep",
};

function codeflowLine(event: Record<string, unknown>): string | null {
  switch (event.event) {
    case "start":
      // The model, like Claude's `init` line: the first spaceless note is the banner.
      return typeof event.model === "string" ? `${STATUS_MARK}${event.model}` : null;
    case "tool": {
      const name = typeof event.tool === "string" ? event.tool : "";
      const label = CODEFLOW_TOOLS[name] ?? name;
      const arg = typeof event.arg === "string" ? event.arg.trim() : "";
      const line = arg ? `⏵ ${label}: ${truncate(arg)}` : `⏵ ${label}`;
      // A failed call says why on the next line, so the arg stays a clean path for the chips.
      if (event.ok === false && typeof event.detail === "string" && event.detail.trim()) {
        return `${line}\n${STATUS_MARK}${truncate(event.detail)}`;
      }
      return line;
    }
    case "text":
      return typeof event.text === "string" && event.text.trim() ? truncate(event.text) : null;
    case "note":
      return typeof event.text === "string" ? `${STATUS_MARK}${event.text}` : null;
    // The repository map the run was handed, said once at its start.
    case "map":
      return typeof event.files === "number" && typeof event.ms === "number"
        ? `${STATUS_MARK}${translate("codemap.logLine", { files: event.files, ms: event.ms })}`
        : null;
    default:
      return null;
  }
}

/**
 * Cline's `--json` (3.0.73): a tool call as it starts, and the model's prose once a block is done.
 * The deltas and usage between them are noise in a live log.
 */
function clineLine(event: unknown): string | null {
  if (!isRecord(event)) return null;
  if (event.type === "content_start" && event.contentType === "tool" && typeof event.toolName === "string") {
    return `⏵ ${toolCallLabel(event.toolName, event.input)}`;
  }
  if (event.type === "content_end" && event.contentType === "text" && typeof event.text === "string" && event.text.trim()) {
    return truncate(event.text);
  }
  return null;
}

export function formatAgentLogLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // A partial line (the process was killed mid-write) or plain text that merely starts with a
    // brace — showing it raw beats dropping output the user might need.
    return raw;
  }
  if (!isRecord(event)) return raw;

  switch (event.type) {
    case "assistant": {
      const lines = assistantLines(event.message);
      if (lines.length === 0) return null;
      // A sub-agent's own steps carry the `Task` call they belong to; marked so they do not read as
      // the main agent's.
      const sub = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id !== "";
      return (sub ? lines.map((line) => `${SUBAGENT_MARK}${line}`) : lines).join("\n");
    }
    case "system":
      return systemLine(event);
    case "agent_event":
      return clineLine(event.event);
    case "codeflow":
      return codeflowLine(event);
    // The tool results the model reads back, and the final verdict, which the caller renders as
    // the actual answer a beat later.
    case "user":
    case "result":
      return null;
    default:
      // Any other tagged event (rate-limit notices, turn summaries, whatever a CLI version adds
      // next) is bookkeeping: hidden rather than dumped as raw JSON, which would bury the lines
      // that actually say what the agent is doing. Untagged JSON is something else entirely —
      // an engine printing a plain object — so that still comes through.
      return typeof event.type === "string" ? null : raw;
  }
}
