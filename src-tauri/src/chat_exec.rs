//! What a chat's model may run in the shell without asking — the policy behind the permission
//! prompt CodeFlow answers for Claude Code (`codemap::mcp::answer_permission_prompt`).
//!
//! The user's call (2026-11-11): "que haga de todo tanto en el pc como en la app… y el modo plan
//! igual debería poder hacer de todo pero solo para ejecutar pruebas, ver cosas, etc. Pero no crear
//! cosas ni modificar."
//!
//! - **A turn that may act** runs every command unasked, except what `cf guard` holds as destructive
//!   (`shell_rules::dangerous`: `rm -rf`, a force-push, a dropped table…) — that one waits for the
//!   user's yes in the window, exactly as it does in a CodeFlow terminal.
//! - **A plan turn** (read-only) runs commands too — the tests, a `kubectl get`, a `curl` — but never
//!   one that changes something, and that is enforced twice:
//!   1. [`plan_refusal`] turns away the commands that change things somewhere a file sandbox cannot
//!      see — a push, a `kubectl apply`, an `az … delete`, a `curl -X POST`, an `INSERT` — with the
//!      reason the model reads.
//!   2. On macOS every command that passes runs under Seatbelt ([`sandboxed`]): **no file can be
//!      written** but in the temporary folders, the toolchains' caches and the repository's
//!      git-ignored build folders (`node_modules`, `target`, `coverage`…) — so a test run that
//!      writes its cache works and one that rewrites a tracked file fails. The network stays open: a
//!      test or a `curl` reaching a server is looking, not changing.
//!
//! Elsewhere (Windows, Linux) there is no sandbox here, and the plan turn has the first layer only.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Why a plan turn may not run `line`, or `None` when it may.
pub fn plan_refusal(line: &str) -> Option<String> {
    if let Some(reason) = crate::shell_rules::dangerous(line) {
        return Some(format!("it {reason}"));
    }
    for words in commands(line) {
        if let Some(reason) = changes(&words) {
            return Some(reason);
        }
    }
    None
}

/// The simple commands of a shell line, as words (quotes removed). Rough on purpose: the sandbox is
/// what stops a write; this only has to recognise the commands that change things elsewhere.
fn commands(line: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word = String::new();
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    let end_word = |word: &mut String, words: &mut Vec<String>| {
        if !word.is_empty() {
            words.push(std::mem::take(word));
        }
    };
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => word.push(c),
            None => match c {
                '\'' | '"' => quote = Some(c),
                '\\' => {
                    if let Some(next) = chars.next() {
                        word.push(next);
                    }
                }
                ' ' | '\t' => end_word(&mut word, &mut words),
                ';' | '|' | '&' | '\n' | '(' | ')' | '`' => {
                    end_word(&mut word, &mut words);
                    if !words.is_empty() {
                        out.push(std::mem::take(&mut words));
                    }
                }
                '$' if chars.peek() == Some(&'(') => {
                    chars.next();
                    end_word(&mut word, &mut words);
                    if !words.is_empty() {
                        out.push(std::mem::take(&mut words));
                    }
                }
                _ => word.push(c),
            },
        }
    }
    end_word(&mut word, &mut words);
    if !words.is_empty() {
        out.push(words);
    }
    // `sudo x`, `env A=1 x`, `time x`, `xargs x`: the command is what follows.
    out.into_iter()
        .map(|words| {
            let mut rest = words.as_slice();
            loop {
                match rest.first().map(|w| base(w)) {
                    Some("sudo" | "time" | "nice" | "nohup" | "command" | "exec" | "xargs" | "npx" | "bunx" | "pnpx") => rest = &rest[1..],
                    Some("env") => {
                        rest = &rest[1..];
                        while rest.first().is_some_and(|w| w.contains('=') || w.starts_with('-')) {
                            rest = &rest[1..];
                        }
                    }
                    Some(w) if w.contains('=') && !w.starts_with('=') => rest = &rest[1..],
                    _ => break,
                }
            }
            rest.to_vec()
        })
        .filter(|words| !words.is_empty())
        .collect()
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// The words after the program that are not flags.
fn verbs(words: &[String]) -> Vec<&str> {
    words.iter().skip(1).map(String::as_str).filter(|w| !w.starts_with('-')).collect()
}

fn has(words: &[String], flags: &[&str]) -> bool {
    words.iter().any(|w| flags.iter().any(|f| w == f || (f.starts_with("--") && w.starts_with(&format!("{f}=")))))
}

/// Why one simple command changes something, or `None`.
fn changes(words: &[String]) -> Option<String> {
    let program = base(words.first()?);
    let verbs = verbs(words);
    let first = verbs.first().copied().unwrap_or_default();
    let refuse = |what: &str| Some(format!("{what} changes something, and this is plan mode: look, test and read, but change nothing"));
    match program {
        "git" => {
            const READS: &[&str] = &[
                "status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "describe",
                "grep", "shortlog", "reflog", "cat-file", "for-each-ref", "name-rev", "merge-base", "whatchanged", "help", "version",
                "check-ignore", "count-objects", "var",
            ];
            // `-C <dir>` and `-c k=v` come before the verb.
            let mut rest = words.iter().skip(1).map(String::as_str);
            let mut verb = "";
            while let Some(w) = rest.next() {
                if w == "-C" || w == "-c" {
                    rest.next();
                } else if !w.starts_with('-') {
                    verb = w;
                    break;
                }
            }
            let read_branch = verb == "branch" && !has(words, &["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--set-upstream-to", "-u", "--unset-upstream"]);
            let read_remote = verb == "remote" && verbs.get(1).is_none_or(|v| matches!(*v, "show" | "get-url"));
            let read_config = verb == "config" && has(words, &["--get", "--get-all", "--list", "-l", "--get-regexp", "--show-origin"]);
            let read_stash = verb == "stash" && verbs.get(1).is_some_and(|v| matches!(*v, "list" | "show"));
            let read_tag = verb == "tag" && (verbs.len() == 1 || has(words, &["-l", "--list"]));
            if verb.is_empty() || READS.contains(&verb) || read_branch || read_remote || read_config || read_stash || read_tag {
                None
            } else {
                refuse(&format!("git {verb}"))
            }
        }
        "kubectl" | "oc" => {
            const READS: &[&str] = &["get", "describe", "logs", "top", "explain", "api-resources", "api-versions", "version", "cluster-info", "events", "diff", "wait"];
            let read_config = first == "config" && verbs.get(1).is_some_and(|v| matches!(*v, "view" | "get-contexts" | "current-context" | "get-clusters" | "get-users"));
            let read_auth = first == "auth" && verbs.get(1) == Some(&"can-i");
            let read_rollout = first == "rollout" && verbs.get(1).is_some_and(|v| matches!(*v, "status" | "history"));
            if READS.contains(&first) || read_config || read_auth || read_rollout {
                None
            } else {
                refuse(&format!("kubectl {first}"))
            }
        }
        "helm" => {
            const READS: &[&str] = &["list", "ls", "status", "get", "history", "show", "inspect", "template", "version", "search", "lint", "env", "dependency"];
            let read_repo = first == "repo" && verbs.get(1) == Some(&"list");
            if READS.contains(&first) && !(first == "dependency" && verbs.get(1) != Some(&"list")) || read_repo {
                None
            } else {
                refuse(&format!("helm {first}"))
            }
        }
        "az" => {
            const WRITES: &[&str] = &[
                "create", "delete", "update", "set", "add", "remove", "start", "stop", "restart", "deploy", "purge", "import", "upload",
                "assign", "scale", "swap", "reset", "sync", "invoke", "run-command", "revoke", "regenerate", "renew", "rotate", "apply",
                "move", "rename", "enable", "disable", "attach", "detach", "approve", "reject", "cancel", "activate", "deactivate",
                "up", "login", "logout", "install", "uninstall", "push", "import-image", "replace",
            ];
            match verbs.iter().find(|v| WRITES.contains(*v)) {
                Some(verb) => refuse(&format!("az … {verb}")),
                None => None,
            }
        }
        "docker" | "podman" | "nerdctl" => {
            const READS: &[&str] = &["ps", "images", "logs", "inspect", "stats", "top", "version", "info", "history", "diff", "port", "events", "search"];
            let sub = verbs.get(1).copied().unwrap_or_default();
            let read_group = matches!(first, "network" | "volume" | "image" | "container" | "context" | "system")
                && matches!(sub, "ls" | "list" | "inspect" | "df" | "show" | "history" | "logs");
            let read_compose = first == "compose" && matches!(sub, "ps" | "logs" | "config" | "ls" | "images" | "top" | "version" | "port" | "events");
            if READS.contains(&first) || read_group || read_compose {
                None
            } else {
                refuse(&format!("{program} {first}"))
            }
        }
        "docker-compose" => {
            if matches!(first, "ps" | "logs" | "config" | "images" | "top" | "version" | "port") {
                None
            } else {
                refuse(&format!("docker-compose {first}"))
            }
        }
        "terraform" | "tofu" | "terragrunt" => {
            let read_state = first == "state" && verbs.get(1).is_some_and(|v| matches!(*v, "list" | "show" | "pull"));
            if matches!(first, "plan" | "show" | "validate" | "output" | "version" | "providers" | "graph" | "console") || read_state || (first == "fmt" && has(words, &["-check"])) {
                None
            } else {
                refuse(&format!("{program} {first}"))
            }
        }
        "pulumi" => {
            if matches!(first, "preview" | "stack" | "config" | "about" | "version" | "whoami" | "logs") && !verbs.iter().any(|v| matches!(*v, "set" | "rm" | "init" | "select")) {
                None
            } else {
                refuse(&format!("pulumi {first}"))
            }
        }
        "curl" => {
            let method = words.windows(2).find(|pair| pair[0] == "-X" || pair[0] == "--request").map(|pair| pair[1].to_ascii_uppercase());
            let method = method.or_else(|| words.iter().find_map(|w| w.strip_prefix("--request=").or_else(|| w.strip_prefix("-X").filter(|m| !m.is_empty())).map(str::to_ascii_uppercase)));
            let sends = has(words, &["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"])
                || words.iter().any(|w| w.starts_with("-d") && w.len() > 2 && !w.starts_with("--"));
            match method.as_deref() {
                Some("GET" | "HEAD" | "OPTIONS") | None if !sends => None,
                Some(m) => refuse(&format!("curl -X {m}")),
                None => refuse("curl with a body"),
            }
        }
        "wget" => {
            if has(words, &["--post-data", "--post-file", "--method", "--body-data", "--body-file"]) {
                refuse("wget sending data")
            } else {
                None
            }
        }
        "http" | "https" | "xh" => {
            // HTTPie: `http POST url`, or a body item (`a=1`, `a:=1`, `@file`).
            let method = verbs.first().map(|v| v.to_ascii_uppercase()).filter(|v| v.chars().all(|c| c.is_ascii_uppercase()));
            let body = verbs.iter().skip(1).any(|v| v.contains('=') || v.starts_with('@'));
            match method.as_deref() {
                Some("GET" | "HEAD" | "OPTIONS") if !body => None,
                Some(m) if !matches!(m, "GET" | "HEAD" | "OPTIONS") => refuse(&format!("{program} {m}")),
                _ if body => refuse(&format!("{program} with a body")),
                _ => None,
            }
        }
        "psql" | "mysql" | "mariadb" | "sqlite3" | "sqlcmd" | "mongosh" | "mongo" | "cqlsh" | "clickhouse-client" | "duckdb" => {
            let text = words.join(" ").to_ascii_uppercase();
            const WRITES: &[&str] = &[
                "INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ", "TRUNCATE ", "GRANT ", "REVOKE ", "MERGE ", "REPLACE ",
                "UPSERT ", "COPY ", "VACUUM", "REINDEX", "CALL ", "EXEC ", "EXECUTE ", ".INSERTONE", ".INSERTMANY", ".UPDATEONE",
                ".UPDATEMANY", ".DELETEONE", ".DELETEMANY", ".DROP(", ".REPLACEONE", ".FINDONEANDUPDATE", ".FINDONEANDDELETE",
                ".CREATEINDEX", ".RENAMECOLLECTION",
            ];
            // A script from a file or stdin cannot be read here: it may do anything.
            if has(words, &["-f", "--file", "--eval-file"]) || words.iter().any(|w| w == "<") {
                return refuse(&format!("{program} running a script"));
            }
            match WRITES.iter().find(|w| text.contains(*w)) {
                Some(w) => refuse(&format!("{program} {}", w.trim().trim_start_matches('.'))),
                None => None,
            }
        }
        "redis-cli" | "valkey-cli" => {
            const READS: &[&str] = &[
                "get", "mget", "keys", "scan", "type", "ttl", "pttl", "exists", "strlen", "hget", "hgetall", "hkeys", "hvals", "hlen",
                "hmget", "hexists", "lrange", "llen", "lindex", "smembers", "scard", "sismember", "zrange", "zrangebyscore", "zcard",
                "zscore", "info", "ping", "dbsize", "memory", "object", "xrange", "xlen", "xinfo", "client", "config", "slowlog",
                "monitor", "pubsub", "time", "echo", "lastsave", "role", "cluster",
            ];
            let words_lower: Vec<String> = words.iter().skip(1).map(|w| w.to_ascii_lowercase()).collect();
            // The command is the first word that is not a flag or a flag's value.
            let mut i = 0;
            while i < words_lower.len() && words_lower[i].starts_with('-') {
                i += if matches!(words_lower[i].as_str(), "-h" | "-p" | "-a" | "-n" | "-u" | "--user" | "--pass") { 2 } else { 1 };
            }
            match words_lower.get(i) {
                None => refuse(&format!("{program} as an interactive session")),
                Some(cmd) if READS.contains(&cmd.as_str()) && !(cmd == "config" && words_lower.get(i + 1).is_some_and(|w| w != "get")) => None,
                Some(cmd) => refuse(&format!("{program} {cmd}")),
            }
        }
        "gh" => {
            const WRITES: &[&str] = &[
                "create", "merge", "close", "reopen", "edit", "delete", "comment", "review", "ready", "lock", "unlock", "transfer",
                "archive", "unarchive", "rename", "upload", "set", "remove", "add", "cancel", "rerun", "run", "enable", "disable", "sync",
                "fork", "pin", "unpin", "develop", "checkout", "login", "logout", "refresh", "setup-git", "install", "upgrade", "deploy-key",
            ];
            if first == "api" {
                let method = words.windows(2).find(|pair| pair[0] == "-X" || pair[0] == "--method").map(|pair| pair[1].to_ascii_uppercase());
                let fields = has(words, &["-f", "-F", "--field", "--raw-field", "--input"]);
                return match method.as_deref() {
                    Some("GET") | None if !fields => None,
                    _ => refuse("gh api writing"),
                };
            }
            match verbs.iter().skip(1).find(|v| WRITES.contains(*v)) {
                Some(verb) => refuse(&format!("gh {first} {verb}")),
                None => None,
            }
        }
        "glab" => match verbs.iter().skip(1).find(|v| matches!(**v, "create" | "merge" | "close" | "reopen" | "update" | "delete" | "note" | "approve" | "revoke" | "retry" | "cancel" | "run" | "set")) {
            Some(verb) => refuse(&format!("glab {first} {verb}")),
            None => None,
        },
        "npm" | "pnpm" | "yarn" | "bun" => {
            if matches!(first, "publish" | "unpublish" | "deprecate" | "version" | "login" | "logout" | "adduser" | "owner" | "dist-tag" | "access" | "token" | "link" | "unlink") {
                refuse(&format!("{program} {first}"))
            } else {
                None
            }
        }
        "cargo" => {
            if matches!(first, "publish" | "yank" | "login" | "logout" | "owner" | "install" | "uninstall") {
                refuse(&format!("cargo {first}"))
            } else {
                None
            }
        }
        "pip" | "pip3" | "pipx" | "brew" | "apt" | "apt-get" | "yum" | "dnf" | "port" | "gem" | "go" => {
            let installs = matches!(first, "install" | "uninstall" | "remove" | "upgrade" | "update" | "reinstall" | "link" | "unlink" | "tap" | "untap" | "cleanup" | "autoremove" | "purge" | "get")
                && !(program == "go" && first != "install" && first != "get");
            if installs {
                refuse(&format!("{program} {first}"))
            } else {
                None
            }
        }
        // Commands on another machine, or the user's desktop: nothing here can say what they do.
        "ssh" | "scp" | "sftp" | "rsync" | "ftp" | "telnet" | "osascript" | "shortcuts" | "launchctl" | "systemctl" | "service" | "crontab" | "defaults" | "killall" | "pkill" | "kill" | "shutdown" | "reboot" => {
            refuse(program)
        }
        "open" if !has(words, &["-R"]) => refuse("open"),
        // `cf`'s verbs that act, in a terminal of the app.
        "cf" => {
            const READS: &[&str] = &["help", "status", "logs", "wait", "term", "symbol", "usages", "outline", "map", "search", "recall", "llm", "curl", "k8s", "azure", "containers", "ask", "choose"];
            if first.is_empty() || READS.contains(&first) || (first == "ui" && verbs.get(1).is_none_or(|v| matches!(*v, "state" | "actions" | "list"))) {
                None
            } else {
                refuse(&format!("cf {first}"))
            }
        }
        _ => None,
    }
}

/// The headless browser's server, as a turn's MCP config names it — and so the
/// `mcp__playwright__…` prefix of its tools. See [`browser_server`].
pub const BROWSER_SERVER: &str = "playwright";

/// The browser's tools that only look: a plan turn may open and read pages, never act on one.
const BROWSER_READS: &[&str] = &[
    "browser_navigate", "browser_navigate_back", "browser_navigate_forward", "browser_snapshot", "browser_take_screenshot",
    "browser_console_messages", "browser_network_requests", "browser_wait_for", "browser_tabs", "browser_close",
    "browser_resize", "browser_pdf_save", "browser_hover", "browser_scroll",
];

/// The pinned release of Microsoft's Playwright MCP server the chats browse with.
const BROWSER_PACKAGE: &str = "@playwright/mcp@0.0.83";

/// A headless browser for a Claude chat turn — Playwright's MCP server through `npx`, a profile of
/// its own each run (`--isolated`), so nothing of the user's browser is read — or `None` without
/// `npx`. Its tools are not pre-approved: every call reaches the permission prompt, where
/// [`browser_allows`] lets a plan turn read pages and not act on them.
pub fn browser_server() -> Option<crate::mcp_registry::LiveServer> {
    let npx = crate::containers::cli::find("npx")?;
    Some(crate::mcp_registry::LiveServer {
        name: BROWSER_SERVER.to_string(),
        transport: "stdio".to_string(),
        command: npx.to_string_lossy().into_owned(),
        args: ["-y", BROWSER_PACKAGE, "--headless", "--isolated"].iter().map(|a| a.to_string()).collect(),
        env: Vec::new(),
        url: String::new(),
        headers: Vec::new(),
    })
}

/// Whether a turn may call `tool` of the headless browser — `None` for a tool that is not the browser's.
pub fn browser_allows(tool: &str, acts: bool) -> Option<bool> {
    let name = tool.strip_prefix(&format!("mcp__{BROWSER_SERVER}__"))?;
    Some(acts || BROWSER_READS.contains(&name))
}

/// `command` to run under the plan turn's Seatbelt profile for `root`, or `command` itself where
/// there is no sandbox to run it in.
pub fn sandboxed(command: &str, root: &str) -> String {
    if !crate::tool_gateway::sandbox_available() {
        return command.to_string();
    }
    let Some(profile) = profile_file(Path::new(root)) else { return command.to_string() };
    format!("/usr/bin/sandbox-exec -f {} /bin/bash -c {}", quote(&profile.to_string_lossy()), quote(command))
}

/// A single-quoted shell word.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// The profile files written so far, by repository, and when: the ignored folders are read again
/// after a while, since a build creates new ones.
static PROFILES: LazyLock<Mutex<HashMap<PathBuf, (Instant, PathBuf)>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const PROFILE_FRESH: Duration = Duration::from_secs(120);

fn profile_file(root: &Path) -> Option<PathBuf> {
    let mut held = PROFILES.lock().ok()?;
    if let Some((at, path)) = held.get(root) {
        if at.elapsed() < PROFILE_FRESH && path.is_file() {
            return Some(path.clone());
        }
    }
    let text = plan_profile(root, &ignored_dirs(root), dirs::home_dir().as_deref());
    let name = format!("codeflow-plan-{:016x}.sb", {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        root.hash(&mut hasher);
        hasher.finish()
    });
    let path = std::env::temp_dir().join(name);
    std::fs::write(&path, text).ok()?;
    held.insert(root.to_path_buf(), (Instant::now(), path.clone()));
    Some(path)
}

/// Build folders a test may create, allowed wherever git ignores them.
const BUILD_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", "coverage", ".nyc_output", ".next", ".nuxt", ".svelte-kit", ".turbo",
    ".cache", ".vite", ".parcel-cache", ".pytest_cache", "__pycache__", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv",
    ".gradle", "bin", "obj", "tmp", "test-results", "playwright-report", "storybook-static", ".angular", ".expo", ".dart_tool",
];

/// The repository's git-ignored folders: those that exist, as git lists them, and the usual build
/// folders git would ignore if a test created them.
fn ignored_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let listed = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])
        .output();
    if let Ok(output) = listed.as_ref().map_err(|_| ()).and_then(|o| if o.status.success() { Ok(o) } else { Err(()) }) {
        for entry in output.stdout.split(|b| *b == 0) {
            let entry = String::from_utf8_lossy(entry);
            if let Some(dir) = entry.strip_suffix('/') {
                found.push(root.join(dir));
            }
        }
    }
    let candidates: Vec<&str> = BUILD_DIRS.iter().copied().filter(|d| !found.iter().any(|f| f == &root.join(d))).collect();
    if !candidates.is_empty() {
        let checked = std::process::Command::new("git").arg("-C").arg(root).arg("check-ignore").args(&candidates).output();
        if let Ok(output) = checked {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                found.push(root.join(line.trim().trim_end_matches('/')));
            }
        }
    }
    found.sort();
    found.dedup();
    found
}

/// The Seatbelt profile of a plan turn's command: everything may be read and the network reached;
/// files are written only in the temporary folders, the toolchains' caches, the repository's ignored
/// folders and git's index (a `git status` refreshes it).
fn plan_profile(root: &Path, ignored: &[PathBuf], home: Option<&Path>) -> String {
    fn esc(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")
    }
    let mut allowed: Vec<String> = vec![
        "(subpath \"/private/tmp\")".into(),
        "(subpath \"/private/var/folders\")".into(),
        format!("(subpath \"{}\")", esc(&std::env::temp_dir())),
        "(literal \"/dev/null\")".into(),
        "(literal \"/dev/zero\")".into(),
        "(literal \"/dev/tty\")".into(),
        "(literal \"/dev/dtracehelper\")".into(),
        "(regex #\"^/dev/fd/\")".into(),
        "(regex #\"^/dev/ttys\")".into(),
        format!("(literal \"{}\")", esc(&root.join(".git/index"))),
        format!("(literal \"{}\")", esc(&root.join(".git/index.lock"))),
    ];
    if let Some(home) = home {
        const CACHES: &[&str] = &[
            "Library/Caches", ".cache", ".npm", ".pnpm-store", "Library/pnpm", ".yarn", ".bun", ".cargo/registry", ".cargo/git",
            ".rustup/tmp", ".gradle", ".m2/repository", "go/pkg", ".nuget/packages", ".dotnet", ".kube/cache", ".kube/http-cache",
            ".azure", ".docker", ".config/gcloud", ".aws/cli/cache", ".aws/sso/cache", ".deno", ".local/share/pnpm", ".node-gyp",
            "Library/Application Support/Code/User/workspaceStorage", ".claude",
        ];
        for cache in CACHES {
            allowed.push(format!("(subpath \"{}\")", esc(&home.join(cache))));
        }
    }
    for dir in ignored {
        allowed.push(format!("(subpath \"{}\")", esc(dir)));
    }
    format!("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n    {})\n", allowed.join("\n    "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(line: &str) -> bool {
        plan_refusal(line).is_some()
    }

    #[test]
    fn looking_runs() {
        for line in [
            "git status && git log --oneline -5",
            "git diff HEAD~1 -- src",
            "git -C ../other log",
            "kubectl get pods -n api",
            "kubectl logs deploy/api --tail 100",
            "az containerapp logs show -n api -g rg",
            "az containerapp show -n api -g rg",
            "docker ps -a",
            "docker compose logs api",
            "curl -s https://example.com/health",
            "curl -X GET https://example.com",
            "psql -c 'select * from users limit 5'",
            "redis-cli -h localhost get key",
            "npm test",
            "pnpm vitest run",
            "cargo test",
            "gh pr view 12",
            "gh api repos/a/b/pulls",
            "terraform plan",
            "ls -la | grep x",
            "cf logs api",
        ] {
            assert!(!refused(line), "{line}: {:?}", plan_refusal(line));
        }
    }

    #[test]
    fn changing_is_turned_away() {
        for line in [
            "git commit -m x",
            "git push",
            "git checkout main",
            "git branch -D old",
            "git stash",
            "kubectl apply -f x.yaml",
            "kubectl delete pod api-1",
            "kubectl rollout restart deploy/api",
            "az containerapp update -n api -g rg --image x",
            "az group delete -n rg",
            "docker rm -f api",
            "docker run alpine",
            "curl -X POST https://example.com",
            "curl -d a=1 https://example.com",
            "curl --json '{}' https://example.com",
            "psql -c 'delete from users'",
            "mysql -e \"UPDATE users SET a=1\"",
            "redis-cli set k v",
            "gh pr merge 12",
            "gh api -X DELETE repos/a/b",
            "npm publish",
            "terraform apply",
            "ssh host ls",
            "sudo kubectl delete ns x",
            "FOO=1 git push",
            "echo $(git commit -m x)",
            "cf restart api",
        ] {
            assert!(refused(line), "{line}");
        }
    }

    #[test]
    fn the_profile_writes_only_where_it_says() {
        let root = Path::new("/Users/me/repo");
        let profile = plan_profile(root, &[root.join("node_modules")], Some(Path::new("/Users/me")));
        assert!(profile.contains("(deny file-write*)"));
        assert!(profile.contains("(subpath \"/Users/me/repo/node_modules\")"));
        assert!(profile.contains("(literal \"/Users/me/repo/.git/index\")"));
        assert!(!profile.contains("(subpath \"/Users/me/repo\")"));
        assert!(!profile.contains("deny network"));
    }

    #[test]
    fn a_plan_turn_reads_pages_and_does_not_act_on_them() {
        assert_eq!(browser_allows("mcp__playwright__browser_snapshot", false), Some(true));
        assert_eq!(browser_allows("mcp__playwright__browser_click", false), Some(false));
        assert_eq!(browser_allows("mcp__playwright__browser_click", true), Some(true));
        assert_eq!(browser_allows("Bash", false), None);
    }

    #[test]
    fn a_wrapped_command_keeps_its_quotes() {
        assert_eq!(quote("echo 'a b'"), "'echo '\\''a b'\\'''");
    }
}
