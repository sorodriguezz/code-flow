import type { AiRunLine } from "../state/aiRunStore";
import type { RunPhase } from "./thinking/activity";
import { PLAN_MARK } from "./runPlan";

/**
 * A run's log, read as steps — what the run card shows as rows and what its headline says.
 *
 * The lines are what `formatAgentLogLine` already made of the CLI's stream: `⏵ Read: src/a.ts` for
 * a tool call, `· …` for a status, plain prose for the model talking between tools, and `↳ ` in
 * front of anything a sub-agent did. Nothing here invents a step: a line is a row, and the phase is
 * the newest row's. Engines whose headless output is not that shape (their lines arrive as plain
 * text) simply read as "working".
 */

export type RunStepKind = "tool" | "note" | "text";

export interface RunStep {
  kind: RunStepKind;
  /** The tool's name, for a `tool` step. */
  tool: string;
  /** What it was called on — a path, a command, a pattern. */
  arg: string;
  /** The whole line, as printed. */
  text: string;
  /** Done by a sub-agent rather than the main one. */
  sub: boolean;
  /** Printed on stderr. */
  error: boolean;
  /** When it was received (ms since the epoch), when the log was stamped. */
  at?: number;
  /** How long it took: until the next step began (see [`withDurations`]). */
  ms?: number;
}

/**
 * Fills each step's `ms` from the arrival times: a step lasted until the next one began, and the
 * last one until `end` (the run's finish, or now while it is live). Steps without a stamp stay
 * without one — a duration invented from nothing would put a bar on a row that never measured it.
 * Pauses between a step and the next are the model thinking, which is time the step cost the person.
 */
export function withDurations(steps: RunStep[], end: number): RunStep[] {
  return steps.map((step, i) => {
    if (step.at === undefined) return step;
    const next = steps.slice(i + 1).find((later) => later.at !== undefined)?.at ?? end;
    return { ...step, ms: Math.max(0, next - step.at) };
  });
}

const TOOL = /^⏵ ([^:]+?)(?:: (.*))?$/;
const NOTE = /^· (.*)$/;
const SUB = "↳ ";

export function parseRunSteps(lines: readonly AiRunLine[] | undefined): RunStep[] {
  const steps: RunStep[] = [];
  if (!lines) return steps;
  for (const line of lines) {
    for (const raw of line.text.split("\n")) {
      if (!raw.trim()) continue;
      // The plan's own line (`runPlan`) is drawn as a checklist, never as a step.
      if (raw.startsWith(PLAN_MARK)) continue;
      const sub = raw.startsWith(SUB);
      const text = sub ? raw.slice(SUB.length) : raw;
      const error = line.stream === "stderr";
      const tool = error ? null : TOOL.exec(text);
      if (tool) {
        steps.push({ kind: "tool", tool: tool[1].trim(), arg: (tool[2] ?? "").trim(), text, sub, error, ...(line.at === undefined ? {} : { at: line.at }) });
        continue;
      }
      const note = error ? null : NOTE.exec(text);
      // The first status a Claude run prints is the model it started on — the engine chip says
      // that already, so it is not a step.
      if (note && steps.length === 0 && !/\s/.test(note[1])) continue;
      steps.push({ kind: note ? "note" : "text", tool: "", arg: note ? note[1] : text, text, sub, error, ...(line.at === undefined ? {} : { at: line.at }) });
    }
  }
  return steps;
}

/** What calling `tool` means the run is doing. Unknown tools (and every MCP one) are "using tools". */
export function phaseOfTool(tool: string): RunPhase {
  const name = tool.toLowerCase();
  if (/^(read|notebookread|ls|view|cat|read_file|list_dir)$/.test(name)) return "read";
  if (/^(grep|glob|search|websearch|webfetch|web_search|web_fetch|toolsearch|find)$/.test(name)) return "search";
  if (/^(edit|multiedit|write|notebookedit|apply_patch|str_replace_editor|search_replace|create)$/.test(name)) return "edit";
  if (/^(bash|bashoutput|shell|killshell|exec|run_terminal_cmd|run_terminal_command)$/.test(name)) return "run";
  if (/^(task|agent|spawn_subagent|spawn_agent)$/.test(name)) return "delegate";
  if (/^(todowrite|exitplanmode|todo)$/.test(name)) return "plan";
  return "tool";
}

/** The phase the newest step puts the run in. No steps yet is "starting". */
export function phaseOfSteps(steps: readonly RunStep[]): RunPhase {
  const last = steps[steps.length - 1];
  if (!last) return "start";
  return last.kind === "tool" ? phaseOfTool(last.tool) : "work";
}

const READS = /^(read|notebookread|view|read_file)$/i;
const EDITS = /^(edit|multiedit|write|notebookedit|create|search_replace)$/i;

/**
 * The files a run read or changed, in the order it first touched them — the "sources" a finished
 * turn lists under its answer. A file both read and edited counts once, as edited.
 */
export function touchedFiles(steps: readonly RunStep[], limit = 8): { path: string; edited: boolean }[] {
  const files: { path: string; edited: boolean }[] = [];
  for (const step of steps) {
    if (step.kind !== "tool" || !step.arg) continue;
    const edited = EDITS.test(step.tool);
    if (!edited && !READS.test(step.tool)) continue;
    // A truncated argument (`…`) is not a path that can be opened.
    if (step.arg.endsWith("…")) continue;
    const known = files.find((f) => f.path === step.arg);
    if (known) known.edited ||= edited;
    else files.push({ path: step.arg, edited });
  }
  return files.slice(0, limit);
}
