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
      return lines.length > 0 ? lines.join("\n") : null;
    }
    case "system":
      return event.subtype === "init" && typeof event.model === "string" ? `· ${event.model}` : null;
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
