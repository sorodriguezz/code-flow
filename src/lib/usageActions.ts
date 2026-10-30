/**
 * Which backend calls are worth a counter in Settings › Estadísticas, and under what name.
 *
 * Read by the observer in `usageTracker` that sees application commands — so actions are counted
 * where they reach the backend rather than in each of the components that start them. Every key
 * names a *kind* of thing (`api.send`, `api.method.POST`, `editor.save.ts`); none carries content:
 * no request URL, no SQL, no prompt, no file name — a file is reduced to its extension.
 */

import type { UsageKind } from "../types/domain";

export interface UsageHit {
  kind: UsageKind;
  key: string;
  /** For chat replies: the response time, booked as seconds. */
  seconds?: number;
}

type Args = Record<string, unknown>;
/** What a call counts as. `result` is `undefined` on failure. */
type Rule = { app: string; on: (args: Args, result: unknown) => string[] };

const word = (value: unknown) =>
  typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) : "";

/** A file's extension, the only part of its name a counter may keep. */
export function extensionOf(path: unknown): string {
  if (typeof path !== "string") return "none";
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? word(name.slice(dot + 1)) || "none" : "none";
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg"]);

const statusClass = (result: unknown) => {
  const status = (result as { status?: number } | undefined)?.status;
  return typeof status === "number" && status >= 100 ? `${Math.floor(status / 100)}xx` : null;
};

const simple = (app: string, action: string): Rule => ({ app, on: () => [action] });

/** Command → the actions it counts as, keyed `<app>.<action>`. */
const RULES: Record<string, Rule> = {
  // Cliente API
  api_send_http: { app: "api", on: (a, r) => httpKeys(a, r) },
  api_send_http_tracked: { app: "api", on: (a, r) => httpKeys(a, r) },
  api_grpc_call: simple("api", "grpc"),
  api_ws_connect: simple("api", "websocket"),
  api_socketio_connect: simple("api", "socketio"),
  api_mqtt_connect: simple("api", "mqtt"),
  api_create_request: simple("api", "request_created"),
  api_create_collection: simple("api", "collection_created"),
  api_import_tree: simple("api", "import"),
  // Bases de datos
  db_connect: simple("db", "connect"),
  db_execute: simple("db", "query"),
  db_explain: simple("db", "explain"),
  db_apply_edits: simple("db", "edits_committed"),
  db_import_csv: simple("db", "import"),
  db_export_rows: simple("db", "export"),
  db_backup_run: simple("db", "backup"),
  db_restore_run: simple("db", "restore"),
  db_ai_assist: simple("db", "ai_assist"),
  db_create_connection: simple("db", "connection_created"),
  // Flujos
  flows_run: simple("flows", "run"),
  flows_run_form: simple("flows", "run"),
  flows_retry_run: simple("flows", "retry"),
  flows_create_flow: simple("flows", "created"),
  flows_create_from_template: simple("flows", "created"),
  flows_build_with_ai: simple("flows", "ai_build"),
  // Notas
  notes_create_note: simple("notes", "created"),
  notes_save_note: simple("notes", "edited"),
  notes_write_with_ai: simple("notes", "ai_write"),
  notes_export_docx: simple("notes", "export"),
  // Diagramas
  diagrams_create_diagram: { app: "diagrams", on: (a) => ["created", `created.${word(a.format) || "other"}`] },
  diagrams_save_diagram: simple("diagrams", "edited"),
  diagrams_draw_with_ai: simple("diagrams", "ai_draw"),
  diagrams_archify_project: simple("diagrams", "archify"),
  // Terminal (commands come from the shell integration, see `shellIntegration.ts`)
  open_terminal: simple("terminal", "opened"),
  // Servicios
  services_start: simple("services", "start"),
  services_restart: simple("services", "restart"),
  services_stop: simple("services", "stop"),
  // Revisión de PR y Revisor
  review_pull_request: simple("review", "pr_review"),
  review_pr_from_link: simple("review", "pr_review"),
  preview_pr_review: simple("review", "pr_review"),
  resolve_finding_with_ai: simple("review", "finding_fixed"),
  discard_pr_finding: simple("review", "finding_discarded"),
  reviewer_run: simple("quality", "run"),
  // Tickets
  tickets_list: simple("tickets", "list"),
  tickets_start: simple("tickets", "start"),
  tickets_move: simple("tickets", "move"),
  // Remoto / SSH
  remote_open_session: simple("remote", "session"),
  remote_open_forward: simple("remote", "tunnel"),
  remote_open_screen: simple("remote", "screen"),
  remote_upload_file: simple("remote", "upload"),
  remote_download_file: simple("remote", "download"),
  // Contenedores
  containers_act: { app: "containers", on: (a) => [`act.${word(a.action) || "other"}`] },
  containers_run: simple("containers", "run"),
  containers_open_session: simple("containers", "shell"),
  containers_apply: simple("containers", "apply"),
  containers_analyze_logs: simple("containers", "ai_logs"),
  // Pipelines
  pipeline_run_detail: simple("pipelines", "viewed"),
  analyze_pipeline_failure: simple("pipelines", "ai_analyze"),
  // Llavero — when it is opened and used, never what is in it
  keyvault_unlock: simple("vault", "unlock"),
  keyvault_unlock_remembered: simple("vault", "unlock"),
  keyvault_copy_secret: simple("vault", "copy"),
  keyvault_create_item: simple("vault", "item_created"),
  keyvault_generate_password: simple("vault", "generate"),
  // Editor and explorer — the file's extension, never its name
  read_file_text: { app: "editor", on: (a) => ["open", `open.${extensionOf(a.relPath ?? a.path)}`] },
  write_editor_file: { app: "editor", on: (a) => ["save", `save.${extensionOf(a.relPath ?? a.path)}`] },
  write_file_text: { app: "editor", on: (a) => ["save", `save.${extensionOf(a.relPath ?? a.path)}`] },
  create_file: simple("explorer", "create"),
  rename_path: simple("explorer", "rename"),
  delete_path: simple("explorer", "delete"),
  // Codi, dictado, lectura en voz alta
  codi_talk: simple("codi", "talk"),
  codi_order: simple("codi", "order"),
  codi_research: simple("codi", "research"),
  codi_run_routine: simple("codi", "routine"),
  dictation_record_start: simple("dictation", "start"),
  speech_say: simple("speech", "read"),
  speech_say_voice: simple("speech", "read"),
  // Historias
  create_story_batch: simple("stories", "batch"),
  review_work_item: simple("stories", "review"),
  write_story_feature_file: simple("stories", "feature_file"),
  // Agentes y worktrees
  create_agent_task: simple("agents", "task"),
  create_story_chain: simple("agents", "chain"),
  add_worktree: simple("agents", "worktree"),
  remove_worktree: simple("agents", "worktree_removed"),
  // Git, for what fails: successes are counted by the backend (`usage_stats::git`)
  git_push: { app: "git", on: () => [] },
  git_push_branch: { app: "git", on: () => [] },
  git_pull: { app: "git", on: () => [] },
  git_clone: { app: "git", on: () => [] },
  commit: { app: "git", on: () => [] },
  merge_branch: { app: "git", on: () => [] },
};

function httpKeys(args: Args, result: unknown): string[] {
  const request = (args.request ?? {}) as { method?: unknown };
  const keys = ["send", `method.${word(request.method).toUpperCase() || "OTHER"}`];
  const status = statusClass(result);
  if (status) keys.push(`status.${status}`);
  return keys;
}

/** The surface a chat call came from. `quickAsk` is told apart by its window. */
export type ChatSurface = "repo" | "agents" | "chat" | "workspace" | "quickAsk";

/** The command a chat surface is created, sent, attached, branched… with. */
function chatHits(cmd: string, args: Args, result: unknown, surfaceOf: (args: Args) => ChatSurface): UsageHit[] | null {
  const reply = result as { provider?: string; model?: string | null; response_time_ms?: number } | undefined;
  const engine = (surface: ChatSurface): UsageHit[] =>
    reply?.provider
      ? [
          { kind: "chat", key: `${surface}.reply`, seconds: (reply.response_time_ms ?? 0) / 1000 },
          { kind: "chat_engine", key: `${word(reply.provider)}/${reply.model?.trim() || "default"}`.slice(0, 100) },
        ]
      : [];
  const attachment = (surface: ChatSurface, name: unknown) => [
    { kind: "chat" as const, key: `${surface}.${IMAGE.has(extensionOf(name)) ? "image" : "file"}` },
  ];
  switch (cmd) {
    case "chat_send": {
      const surface = surfaceOf(args);
      return [{ kind: "chat", key: `${surface}.sent` }, ...(result === undefined ? [] : engine(surface))];
    }
    case "send_chat_message": {
      const surface: ChatSurface = typeof args.agentPrompt === "string" && args.agentPrompt.trim() ? "agents" : "repo";
      return [{ kind: "chat", key: `${surface}.sent` }, ...(result === undefined ? [] : engine(surface))];
    }
    case "chat_create_conversation":
      return [{ kind: "chat", key: `${surfaceOf(args)}.created` }];
    case "chat_create_workspace_conversation":
      return [{ kind: "chat", key: "workspace.created" }];
    case "chat_attach_file":
    case "chat_attach_pending_file":
      return attachment(surfaceOf(args), args.path);
    case "chat_attach_bytes":
    case "chat_attach_pending_bytes":
      return attachment(surfaceOf(args), args.name ?? args.fileName);
    case "repo_chat_attach_file":
      return attachment("repo", args.path);
    case "repo_chat_attach_bytes":
      return attachment("repo", args.name ?? args.fileName);
    case "chat_branch_conversation":
      return [{ kind: "chat", key: `${surfaceOf(args)}.branch` }];
    case "chat_continue_in_new_thread":
      return [{ kind: "chat", key: `${surfaceOf(args)}.continue` }];
    case "chat_compact":
      return [{ kind: "chat", key: `${surfaceOf(args)}.compact` }];
    case "reset_chat_context":
      return [{ kind: "chat", key: "repo.clear" }];
    default:
      return null;
  }
}

/**
 * The counters one finished call adds: its actions on success, an `error` on failure. `null` for a
 * call nobody counts — which is nearly all of them, and returns at the first lookup.
 */
export function usageHitsFor(
  cmd: string,
  args: Args,
  ok: boolean,
  result: unknown,
  surfaceOf: (args: Args) => ChatSurface,
): UsageHit[] | null {
  const chat = chatHits(cmd, args, ok ? result : undefined, surfaceOf);
  if (chat) {
    if (ok) return chat;
    const sent = chat.find((hit) => hit.key.endsWith(".sent"));
    return sent ? [sent, { kind: "error", key: `chat.${sent.key.split(".")[0]}` }] : [{ kind: "error", key: "chat.other" }];
  }
  const rule = RULES[cmd];
  if (!rule) return null;
  if (!ok) {
    // A response that came back 4xx/5xx resolves; only a transport failure rejects.
    // Named like its success where the rule names one (`db.query`), else after the command.
    const action =
      rule.on(args, undefined)[0] ?? cmd.replace(/^(api|db|flows|notes|diagrams|services|remote|containers|keyvault|codi|tickets|reviewer|git)_/, "");
    return [{ kind: "error", key: `${rule.app}.${action}` }];
  }
  return rule.on(args, result).map((action) => ({ kind: "action", key: `${rule.app}.${action}` }));
}

/** A palette row as a counter: catalogue rows by their id, anything named by data by its group. */
export function paletteKey(group: string, key: string): string {
  const [head, second] = key.split(":");
  switch (group) {
    case "workspaces":
    case "projects":
    case "branches":
      return group;
    case "views":
      return `view:${second ?? head}`;
    case "actions":
      return `action:${second ?? head}`;
    default:
      return key.split(":").slice(0, 3).join(":").slice(0, 100);
  }
}
