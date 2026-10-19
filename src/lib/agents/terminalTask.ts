/**
 * The bridge between a shell and the agent whose folder it is standing in.
 *
 * # Why a terminal needs this
 *
 * A shell opened in an agent's worktree is where the work is actually judged: you run the tests,
 * they fail, and the agent that wrote the code is one pane away with no idea. Copying the failure
 * into its composer by hand is the step this removes — the pane knows its own folder (`OSC 7`), the
 * task knows its worktree, and matching the two is all it takes to send the output where it can be
 * acted on.
 *
 * Pure, and separate from the pane: which task owns a folder is a path comparison with three
 * platform traps in it, and the message a failed command turns into is read by a model. Neither is
 * worth discovering from a screenshot.
 */

import type { AgentTask } from "../../types/domain";
import { fenceFor } from "./reviewNote";

/** A path in the one spelling this module compares: forward slashes, no trailing separator, and —
 *  because Windows paths are case-insensitive and arrive spelled both ways — lowercased. */
function normalize(path: string): string {
  return path.trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Whether `inner` is `outer` or sits inside it. Compared segment by segment, so `/wt/login` does
 *  not match `/wt/login-old`. */
function contains(outer: string, inner: string): boolean {
  if (outer === "" || inner === "") return false;
  return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The task whose worktree `cwd` is in, or `null`.
 *
 * The **longest** match wins: a worktree inside another folder that is itself a worktree (a
 * submodule, a nested checkout) belongs to the inner one, which is the one whose agent is editing
 * the file you are standing on.
 *
 * Only tasks with a worktree of their own are candidates. A task that runs in the repository's own
 * working copy is deliberately not matched: every shell opened anywhere in that repository would
 * "belong" to it, and a menu entry offering to send a stray `ls` to an agent is worse than no entry.
 */
export function taskForCwd(tasks: readonly AgentTask[], cwd: string): AgentTask | null {
  const here = normalize(cwd);
  if (here === "") return null;
  let best: AgentTask | null = null;
  let bestLength = 0;
  for (const task of tasks) {
    const root = normalize(task.worktree_path ?? "");
    if (!contains(root, here)) continue;
    if (root.length > bestLength) {
      best = task;
      bestLength = root.length;
    }
  }
  return best;
}

export interface CommandReportLabels {
  /** The opening line, e.g. «Corrí esto en tu worktree:» */
  intro: string;
  /** How the command ended: the caller formats the code into it. */
  exit: string;
  /** The heading above the output. */
  output: string;
}

/**
 * What a command and its output become when they are sent to an agent.
 *
 * The exit code is stated rather than left for the model to infer from the text: a build that fails
 * with a zero-length error and a build that succeeds in silence print the same thing, and the
 * difference is the whole message. The output is fenced with a fence long enough to hold it — a
 * test runner that prints Markdown would otherwise close the block early and the rest would read as
 * instructions (see `fenceFor`).
 *
 * Returns `""` when there is nothing to report, so no turn is spent on an empty send.
 */
export function buildCommandReport(
  { command, exit, output }: { command: string | null; exit: number | null; output: string },
  labels: CommandReportLabels,
): string {
  const text = output.replace(/\s+$/, "");
  const line = (command ?? "").trim();
  if (line === "" && text === "") return "";

  const parts = [labels.intro];
  if (line !== "") {
    const fence = fenceFor(line);
    parts.push(`${fence}\n${line}\n${fence}`);
  }
  if (exit !== null) parts.push(labels.exit);
  if (text !== "") {
    const fence = fenceFor(text);
    parts.push(`### ${labels.output}\n\n${fence}\n${text}\n${fence}`);
  }
  return parts.join("\n\n");
}

/** How many lines of output are worth sending: enough for a stack trace, short of a whole build
 *  log. The tail, because a failure is at the end. */
export const REPORT_LINES = 200;

/** The last {@link REPORT_LINES} lines of `text`. */
export function tailLines(text: string, lines = REPORT_LINES): string {
  const rows = text.replace(/\s+$/, "").split("\n");
  return rows.length <= lines ? rows.join("\n") : rows.slice(rows.length - lines).join("\n");
}
