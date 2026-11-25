/**
 * A CodeFlow script (`app_run`) as the run log tells it — the records `app_script::run` writes into
 * the run's log while the script runs (`src-tauri/src/app_script.rs`, `MARK`):
 *
 * - `start`: the title the model gave it, its code, and whether the run may change things;
 * - `call`: one `app.call`, as it finishes — command, short arguments, outcome, time;
 * - `end`: how it went, where it stopped, and a preview of what it returned.
 *
 * Written by the app and not by the CLI, so the card is the same whichever provider ran the turn.
 */

export const SCRIPT_MARK = "⎔ ";

export interface ScriptCall {
  command: string;
  /** The arguments, short — empty when there were none worth saying. */
  about: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface AppScript {
  id: string;
  title: string;
  code: string;
  /** The run may change things; a plan turn's script only reads. */
  acts: boolean;
  calls: ScriptCall[];
  /** The `end` record arrived. */
  done: boolean;
  ok: boolean;
  ms?: number;
  error?: string;
  /** The call the script stopped at, 0-based. */
  failedAt?: number;
  /** Stopped or out of time, rather than failing. */
  interrupted: boolean;
  returned?: string;
  logs?: string;
  /** Bytes of every answer the script read — what single calls would have handed the model. */
  readBytes?: number;
  /** Bytes of what reached the model: the return value and the trace. */
  returnedBytes?: number;
}

export type ScriptStatus = "running" | "ok" | "partial" | "failed" | "stopped" | "timeout";

/** Whether a tool step is the script tool, however the CLI spells its server's prefix. */
export function isScriptTool(tool: string): boolean {
  return /(^|__|[.:/])app_run$/.test(tool.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function callOf(value: unknown): ScriptCall | null {
  if (!isRecord(value) || typeof value.command !== "string") return null;
  return {
    command: value.command,
    about: str(value.about) ?? "",
    ok: value.ok === true,
    ms: num(value.ms) ?? 0,
    ...(str(value.error) ? { error: str(value.error) } : {}),
  };
}

/**
 * Applies one record line to the scripts seen so far (by id), and returns the script it was about —
 * `null` for a line that is not a record, or one that does not parse. A call or an end for a script
 * whose start was dropped (the log keeps its last 300 lines) still makes a card, without its code.
 */
export function applyScriptRecord(scripts: Map<string, AppScript>, raw: string): { script: AppScript; started: boolean } | null {
  if (!raw.startsWith(SCRIPT_MARK)) return null;
  let record: unknown;
  try {
    record = JSON.parse(raw.slice(SCRIPT_MARK.length));
  } catch {
    return null;
  }
  if (!isRecord(record) || typeof record.id !== "string") return null;
  const id = record.id;
  let script = scripts.get(id);
  const started = !script;
  if (!script) {
    script = { id, title: "", code: "", acts: true, calls: [], done: false, ok: false, interrupted: false };
    scripts.set(id, script);
  }
  switch (record.phase) {
    case "start":
      script.title = str(record.title) ?? script.title;
      script.code = str(record.code) ?? script.code;
      script.acts = record.acts !== false;
      break;
    case "call": {
      const call = callOf(record.call);
      const index = num(record.index);
      if (call) {
        if (index !== undefined && index >= 0 && index <= script.calls.length) script.calls[index] = call;
        else script.calls.push(call);
      }
      break;
    }
    case "end":
      script.done = true;
      script.ok = record.ok === true;
      script.ms = num(record.ms);
      script.error = str(record.error);
      script.failedAt = num(record.failedAt);
      script.interrupted = record.interrupted === true;
      script.returned = str(record.returned);
      script.logs = str(record.logs);
      script.readBytes = num(record.readBytes);
      script.returnedBytes = num(record.returnedBytes);
      break;
    default:
      return null;
  }
  return { script, started };
}

/** How a script stands, for its pill. */
export function scriptStatus(script: AppScript): ScriptStatus {
  if (!script.done) return "running";
  if (script.ok) return script.calls.some((call) => !call.ok) ? "partial" : "ok";
  if (script.interrupted) return /time/i.test(script.error ?? "") ? "timeout" : "stopped";
  return "failed";
}

/**
 * Bytes to tokens, roughly — the backend's rule (`usage_stats::BYTES_PER_TOKEN`). An estimate: the
 * providers bill the turn, not one tool result.
 */
export function estimateTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / 4);
}

/** What a finished script read and what of it reached the model, in estimated tokens — `null` before
 *  it ends, or for a record from before these were counted. */
export function scriptTokens(script: AppScript): { read: number; returned: number } | null {
  if (!script.done || script.readBytes === undefined || script.returnedBytes === undefined) return null;
  return { read: estimateTokens(script.readBytes), returned: estimateTokens(script.returnedBytes) };
}

/** A window of `ai_scripts` counters (Settings › Estadísticas' rows), as what scripts save. */
export interface ScriptSavings {
  runs: number;
  calls: number;
  /** Estimated tokens the scripts read. */
  read: number;
  /** Estimated tokens the scripts handed the model. */
  returned: number;
  directCalls: number;
  /** Estimated tokens single calls handed the model. */
  direct: number;
}

export function scriptSavings(rows: { kind: string; key: string; count: number; tokens: number }[]): ScriptSavings {
  const of = (key: string) => rows.find((row) => row.kind === "ai_scripts" && row.key === key);
  return {
    runs: of("script.runs")?.count ?? 0,
    calls: of("script.calls")?.count ?? 0,
    read: of("script.read")?.tokens ?? 0,
    returned: of("script.returned")?.tokens ?? 0,
    directCalls: of("direct.calls")?.count ?? 0,
    direct: of("direct.returned")?.tokens ?? 0,
  };
}

/** The calls that failed — what a `partial` pill counts. */
export function failedCalls(script: AppScript): number {
  return script.calls.filter((call) => !call.ok).length;
}

export type CodeToken = { text: string; kind: "plain" | "keyword" | "string" | "comment" | "number" | "call" };

const KEYWORDS = new Set([
  "const", "let", "var", "for", "of", "in", "if", "else", "return", "await", "async", "function", "try", "catch", "finally",
  "throw", "new", "while", "do", "break", "continue", "switch", "case", "default", "typeof", "true", "false", "null", "undefined",
]);

/**
 * The script's code as tokens for a light highlight: comments, strings, numbers, keywords, and the
 * calls into the app (`app.call`), which are what the reader is looking for. Not a parser — a
 * regex over JavaScript is wrong somewhere, and wrong here only costs a colour.
 */
export function highlightScript(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const pattern = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\bapp\.call\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) tokens.push({ text: code.slice(last, at), kind: "plain" });
    const [text, comment, string, call, number, word] = match;
    const kind: CodeToken["kind"] = comment
      ? "comment"
      : string
        ? "string"
        : call
          ? "call"
          : number
            ? "number"
            : word && KEYWORDS.has(word)
              ? "keyword"
              : "plain";
    const previous = tokens[tokens.length - 1];
    if (kind === "plain" && previous?.kind === "plain") previous.text += text;
    else tokens.push({ text, kind });
    last = at + text.length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last), kind: "plain" });
  return tokens;
}
