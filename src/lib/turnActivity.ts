import type { RunStep } from "./runSteps";

/**
 * Where a finished turn went for what it said, beyond the repository's files: the memories it
 * recalled, the notes and documents it searched, the reference repositories it read, the web, the
 * commands it ran, the app around it (services, terminals, clusters…) and any other connector
 * (user, 2026-11-09: «que diga a dónde fue para que el usuario sepa de dónde sacó la información o
 * qué ejecutó o hizo»).
 *
 * Read off the same steps the run card draws (`parseRunSteps`) — nothing here is reported by the
 * engine separately. The files it read or edited are not repeated: `touchedFiles` already lists them
 * as their own chips. A memory file the engine read or wrote by path (Claude Code's own memory
 * directory) counts as a memory, not a file.
 */

export type ActivityKind = "memory" | "notes" | "reference" | "chats" | "web" | "command" | "app" | "connector";

export interface ActivityGroup {
  kind: ActivityKind;
  /** What each call was about — a topic, a query, a URL, a command — in first-seen order, once each. */
  items: string[];
  /** How many calls, repeats included. */
  count: number;
  /** For `connector`, the connector's name (`Gmail`, `Supabase`). */
  source?: string;
}

/** CodeFlow's own MCP server, whose tools carry this prefix in Claude Code's log. */
const CODEFLOW_PREFIX = /^mcp__codeflow_map__/;
const MCP = /^mcp__(.+?)__(.+)$/;

const BY_TOOL: Record<string, ActivityKind> = {
  recall: "memory",
  propose_memory: "memory",
  flag_memory: "memory",
  search_knowledge: "notes",
  read_note: "notes",
  write_note: "notes",
  read_reference_file: "reference",
  reference_repos: "reference",
  chat_list: "chats",
  chat_read: "chats",
  artifact_list: "chats",
  artifact_read: "chats",
  websearch: "web",
  webfetch: "web",
  web_search: "web",
  web_fetch: "web",
  bash: "command",
  shell: "command",
  run_command: "command",
  run_terminal_cmd: "command",
  exec: "command",
  service_logs: "app",
  service_restart: "app",
  service_wait: "app",
  terminal_output: "app",
  containers: "app",
  kubernetes: "app",
  azure: "app",
  pipelines: "app",
  api_requests: "app",
  http_request: "app",
  run_with_secret: "app",
  local_llm: "app",
  ui_state: "app",
  ui_act: "app",
  ui_actions: "app",
  notify: "app",
  open_in_editor: "app",
  add_task: "app",
};

/** A path inside an engine's memory directory (Claude Code: `…/projects/<repo>/memory/<name>.md`). */
const MEMORY_FILE = /[\\/]memory[\\/][^\\/]+\.md$/i;
const FILE_TOOLS = /^(read|write|edit|multiedit|view|read_file|create)$/i;

/** The readable name of a connector out of its MCP server id: `claude_ai_Google_Drive` → `Google Drive`. */
function connectorName(server: string): string {
  return server.replace(/^claude_ai_/, "").replace(/_/g, " ").trim() || server;
}

function classify(step: RunStep): { kind: ActivityKind; tool: string; source?: string } | null {
  if (step.kind !== "tool") return null;
  const raw = step.tool;
  if (FILE_TOOLS.test(raw) && MEMORY_FILE.test(step.arg)) return { kind: "memory", tool: raw };
  const own = raw.replace(CODEFLOW_PREFIX, "");
  const known = BY_TOOL[own.toLowerCase()];
  if (known) return { kind: known, tool: own };
  const mcp = MCP.exec(raw);
  if (mcp) return { kind: "connector", tool: mcp[2], source: connectorName(mcp[1]) };
  return null;
}

/** What one call was about, as a short line: the memory's name for a memory file, else the argument. */
function itemOf(step: RunStep, kind: ActivityKind, tool: string): string {
  const arg = step.arg.trim();
  if (kind === "memory" && MEMORY_FILE.test(arg)) return arg.split(/[\\/]/).pop()!.replace(/\.md$/i, "");
  if (kind === "connector") return arg ? `${tool}: ${arg}` : tool;
  return arg || tool;
}

const ORDER: ActivityKind[] = ["memory", "notes", "reference", "chats", "web", "connector", "app", "command"];

export function turnActivity(steps: readonly RunStep[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>();
  for (const step of steps) {
    const hit = classify(step);
    if (!hit) continue;
    const key = hit.kind === "connector" ? `connector:${hit.source}` : hit.kind;
    let group = groups.get(key);
    if (!group) {
      group = { kind: hit.kind, items: [], count: 0, ...(hit.source ? { source: hit.source } : {}) };
      groups.set(key, group);
    }
    group.count += 1;
    const item = itemOf(step, hit.kind, hit.tool);
    if (item && !group.items.includes(item)) group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** Whether a step is a memory file read or written by path — the file chips leave those out. */
export function isMemoryFileStep(step: RunStep): boolean {
  return step.kind === "tool" && FILE_TOOLS.test(step.tool) && MEMORY_FILE.test(step.arg);
}
