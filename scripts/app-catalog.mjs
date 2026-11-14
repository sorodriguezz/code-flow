// The catalogue of CodeFlow's own commands a chat's model may call — `app_commands` / `app_call` on
// the map server (`src-tauri/src/app_gateway.rs`), which embeds `src-tauri/src/app_catalog.json`.
//
// Read off the source, never written by hand: every `#[tauri::command]` the IPC handler registers
// (`sharded_invoke_handler!` in `lib.rs`), with its doc's first sentence, the arguments the window
// would send (camelCase, as Tauri reads them; the ones Tauri injects — state, the app, the window —
// left out) and how risky it is, from its name:
//
// - `blocked`: it hands back or takes a secret (a token, a password, the keychain) — never callable.
// - `unsupported`: it streams through a `Channel`, which a call from outside the window cannot carry.
// - `destructive`: it deletes, drops, resets, force-pushes… — run only after the user's yes.
// - `write`: it changes something — a turn that may act runs it; a plan turn may not.
// - `read`: it only looks.
//
// `node scripts/app-catalog.mjs` rewrites the file; `src/appCatalog.test.ts` fails when it is stale.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src-tauri/src/", import.meta.url));
export const CATALOG_PATH = fileURLToPath(new URL("../src-tauri/src/app_catalog.json", import.meta.url));

/** Parameter types Tauri fills in itself. */
const INJECTED = /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow|Webview)\b|^tauri::(?:ipc::)?(?:Request|Invoke)|^&?(?:tauri::)?(?:AppHandle|Window|WebviewWindow|Webview)\b|^(?:tauri::)?ipc::Request/;

const SECRET = /(?:secret|(?:^|_)pats?(?:_|$)|token|password|passwd|credential|keychain|keyvault|key_vault|vault|llavero|oauth|private_key|api_key|apikey|decrypt|passphrase|mfa|totp|biometric|(?:^|_)otp(?:_|$)|(?:^|_)(?:anon_)?key$|_set_key|set_.*_key|reveal(?!_in_file_manager|_folder)|cookie|repo_env_(?:reveal|service_files|add_key)|service_env_files|parse_azure_connection|connection_string)/;

/** Commands that mint, hand back or spend a shared chat's single-use invitation (the link is the
 *  token). A model holding one could let somebody into the person's session. */
const INVITATION = /^collab_(?:share|invite|join|join_preview|take_join_link|live_connection)$/;

/** What a model must never call: the doors it is itself held at — answering its own approval,
 *  the window's replies to the app's questions, the interface it already drives through `ui_act`. */
const SELF = /^(?:agentcli_|flows_bridge_|codi_act_result|codi_register|codi_ui_|mcp_trust|log_frontend_error)/;

/** Changes to what a model is allowed to do, or to the app itself: run only after the user's yes. */
const GUARDED = new Set(["setting", "settings", "config", "configure", "trust", "permission", "permissions", "access", "policy", "allow", "automation", "mcp", "autostart", "updater", "update_app", "quit", "relaunch", "restart_app"]);

const DESTRUCTIVE = new Set([
  "delete", "remove", "rm", "drop", "purge", "wipe", "destroy", "reset", "erase", "truncate", "prune", "kill", "abandon", "revoke",
  "uninstall", "force", "discard", "clear", "forget", "evict", "nuke", "factory", "quit", "exit", "shutdown", "relaunch", "rollback",
  "revert", "squash", "rebase", "hard", "overwrite", "empty",
]);

const WRITE = new Set([
  "create", "new", "set", "save", "update", "upsert", "add", "write", "put", "post", "run", "start", "stop", "restart", "send", "push",
  "commit", "apply", "install", "import", "export", "open", "close", "move", "rename", "merge", "complete", "approve", "reply", "edit",
  "toggle", "enable", "disable", "sync", "upload", "download", "clone", "pull", "fetch", "checkout", "switch", "stage", "unstage",
  "stash", "tag", "cherry", "pick", "vote", "link", "unlink", "assign", "transition", "schedule", "trigger", "rerun", "retry", "cancel",
  "connect", "disconnect", "mount", "unmount", "attach", "detach", "spawn", "launch", "exec", "execute", "invoke", "record", "mark",
  "pin", "unpin", "archive", "restore", "duplicate", "copy", "paste", "insert", "generate", "build", "compile", "format", "fix",
  "refactor", "register", "claim", "release", "lock", "unlock", "grant", "share", "publish", "deploy", "scale", "rotate", "regenerate",
  "resize", "focus", "minimize", "maximize", "navigate", "emit", "notify", "ask", "answer", "accept", "reject", "dismiss", "snooze",
  "reopen", "submit", "train", "learn", "index", "reindex", "refresh", "reload", "warm", "prepare", "init", "setup", "seed", "migrate",
  "backup", "bump", "sort", "reorder", "nudge", "touch", "keep", "bind", "unbind", "watch", "unwatch", "track", "play", "pause",
  "resume", "speak", "dictate", "transcribe", "summarize", "ingest", "crawl", "harvest", "abort", "use", "extra", "upgrade", "reveal",
  "comment", "resolve", "review", "act", "decision", "drag", "drop_files", "split", "join", "join_meeting", "dock", "undock", "hold",
  "unhold", "pair", "unpair", "invite", "kick", "subscribe", "unsubscribe", "flag", "unflag", "rate", "label", "group", "ungroup",
  "save_as", "persist", "store", "cache", "stamp", "patch", "replace", "restore_backup", "verify_and_save", "test",
]);

const READ = new Set([
  "get", "list", "read", "load", "search", "find", "describe", "query", "count", "check", "detect", "preview", "peek", "probe",
  "inspect", "stat", "stats", "status", "show", "view", "lookup", "which", "whoami", "diff", "log", "logs", "blame", "explain", "is",
  "has", "can", "current", "known", "recent", "suggest", "validate", "verify", "parse", "measure", "estimate", "ping", "health", "info",
  "metrics", "usage", "history", "outline", "map", "tree", "catalog", "version", "about", "checks", "threads", "options", "detail",
  "details", "summary", "report", "rows", "projects", "repos", "items", "entries", "names", "exists", "overview", "topology", "events",
  "top", "pods", "resources", "last", "latest", "active", "authenticated", "user", "whoami", "disk", "used", "pending", "open_count", "schema", "tables", "columns", "runs", "jobs", "results", "findings", "issues", "vulnerabilities",
  "audit", "analyze", "analysis", "scan", "lint", "plan", "dry",
]);

/** The words that can only mean a change, whatever word comes first. */
const STRONG = new Set([
  "create", "set", "save", "update", "upsert", "add", "write", "put", "post", "send", "push", "commit", "apply", "install", "import",
  "merge", "complete", "approve", "start", "stop", "restart", "execute", "exec", "invoke", "upload", "publish", "deploy", "move",
  "rename", "insert", "replace", "patch", "submit", "reply", "vote", "assign", "transition", "trigger", "rerun", "retry", "cancel",
  "or",
]);

/** Nouns that read as verbs: `list_pull_requests` is not a pull, `get_work_items` not work. */
const NOUNS = [
  [/pull_requests?/g, "pr"],
  [/work_items?/g, "item"],
  [/pr_links?/g, "prlink"],
  [/(?:^|_)set_up(?=_|$)/g, "_setup"],
];

/** How risky a command is, from the words of its name — the area prefix (`ado_`, `db_`) says nothing. */
export function riskOf(name) {
  if (SECRET.test(name) || SELF.test(name) || INVITATION.test(name)) return "blocked";
  let plain = name;
  for (const [noun, word] of NOUNS) plain = plain.replace(noun, word);
  const words = plain.split("_").filter(Boolean);
  // A name that starts by looking (`list_review_runs`, `get_pr_link_checks`) looks, unless a word
  // that can only be a change follows (`get_or_create_…`, `list_and_delete_…`).
  const first = words.find((w) => READ.has(w) || WRITE.has(w) || DESTRUCTIVE.has(w));
  const strong = words.some((w) => STRONG.has(w) || DESTRUCTIVE.has(w));
  const changes = first !== undefined && READ.has(first) && !WRITE.has(first) && !strong ? false : words.some((w) => WRITE.has(w) || DESTRUCTIVE.has(w));
  // Reading what a model may do is reading; changing it is the user's call.
  if (words.some((w) => GUARDED.has(w)) && (changes || !words.some((w) => READ.has(w)))) return "destructive";
  if (words.some((w) => DESTRUCTIVE.has(w))) return "destructive";
  if (changes) return "write";
  if (words.some((w) => READ.has(w))) return "read";
  // Nothing in the name says it only looks: treated as changing something.
  return "write";
}

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...rustFiles(path));
    else if (entry.endsWith(".rs")) out.push(path);
  }
  return out;
}

/** Splits at top-level commas: nothing inside `<>`, `()` or `[]`. */
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if ("<([{".includes(c)) depth++;
    if (">)]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const camel = (snake) => snake.replace(/^_+/, "").replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** The registered command names, from the shards of `sharded_invoke_handler!`. */
export function registeredNames(libRs) {
  const start = libRs.indexOf("\nsharded_invoke_handler! {");
  if (start < 0) throw new Error("sharded_invoke_handler! not found in lib.rs");
  const end = libRs.indexOf("\n}", start);
  const body = libRs.slice(start, end);
  const names = new Set();
  for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+)\s*,?/g)) {
    names.add(match[1].split("::").pop());
  }
  return names;
}

/** Every command in the source, as the catalogue lists it. */
export function buildCatalog() {
  const registered = registeredNames(readFileSync(join(SRC, "lib.rs"), "utf8"));
  const commands = [];
  for (const file of rustFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("#[tauri::command")) continue;
    const lines = text.split("\n");
    const area = relative(SRC, file)
      .split(sep)
      .join("/")
      .replace(/\.rs$/, "")
      .replace(/^commands\//, "")
      .replace(/_cmd$/, "")
      .replace(/\/mod$/, "");
    for (let i = 0; i < lines.length; i++) {
      const attr = lines[i].trim();
      if (!attr.startsWith("#[tauri::command")) continue;
      const snake = /rename_all\s*=\s*"snake_case"/.test(attr);
      // The doc above it (other attributes may sit between).
      const doc = [];
      for (let j = i - 1; j >= 0; j--) {
        const line = lines[j].trim();
        if (line.startsWith("///")) doc.unshift(line.replace(/^\/\/\/\s?/, ""));
        else if (line.startsWith("#[")) continue;
        else break;
      }
      // The signature: from `fn` to the parenthesis that closes its parameters.
      let k = i + 1;
      while (k < lines.length && lines[k].trim().startsWith("#[")) k++;
      let signature = "";
      for (; k < lines.length && k < i + 80; k++) {
        signature += lines[k] + "\n";
        if (/\)\s*(?:->[^{]*)?\{\s*$|\)\s*(?:->.*)?where\b/.test(lines[k]) || /\)\s*->[^{]*\{/.test(lines[k]) || /\)\s*\{/.test(lines[k])) break;
      }
      const head = signature.match(/fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^(]*>)?\s*\(/);
      if (!head) continue;
      const name = head[1];
      if (!registered.has(name)) continue;
      const open = signature.indexOf("(", head.index + head[0].length - 1);
      let depth = 0;
      let close = open;
      for (; close < signature.length; close++) {
        if (signature[close] === "(") depth++;
        if (signature[close] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      const params = splitTop(signature.slice(open + 1, close).replace(/\/\/[^\n]*/g, ""));
      const returns = (signature.slice(close + 1).match(/->\s*([^{]*?)\s*(?:where\b|\{|$)/) ?? [])[1]?.trim() ?? "()";
      const args = [];
      let unsupported = false;
      for (const param of params) {
        const colon = param.indexOf(":");
        if (colon < 0) continue;
        const raw = param.slice(0, colon).trim().replace(/^mut\s+/, "");
        const type = param.slice(colon + 1).trim().replace(/\s+/g, " ");
        if (INJECTED.test(type)) continue;
        if (/\bChannel\s*</.test(type)) unsupported = true;
        args.push({ name: snake ? raw.replace(/^_+/, "") : camel(raw), type, optional: /^Option\s*</.test(type) });
      }
      const sentence = doc.join(" ").replace(/\s+/g, " ").trim();
      const summary = (sentence.match(/^(.*?[.!?])(?:\s|$)/) ?? [null, sentence])[1].slice(0, 200);
      const risk = unsupported ? "unsupported" : riskOf(name);
      commands.push({ name, area, risk, args, returns, doc: summary });
    }
  }
  commands.sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name));
  // One entry per name: a name defined twice under `cfg`s is one command.
  const seen = new Set();
  return commands.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}

export function renderCatalog(commands) {
  return JSON.stringify(commands, null, 0).replace(/\},\{/g, "},\n{") + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const commands = buildCatalog();
  writeFileSync(CATALOG_PATH, renderCatalog(commands));
  const by = (risk) => commands.filter((c) => c.risk === risk).length;
  console.log(`${commands.length} commands: ${by("read")} read, ${by("write")} write, ${by("destructive")} destructive, ${by("blocked")} blocked, ${by("unsupported")} unsupported`);
}
