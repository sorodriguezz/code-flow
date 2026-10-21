//! The Claude Code CLI engine.
//!
//! Everything provider-neutral (run plumbing, templates, high-level ops) lives in [`crate::ai`];
//! this module is only what's specific to the `claude` CLI: its flags and how it reports results
//! under `--output-format json`.
//!
//! **Windows `.cmd` shim can't take newline args.** When `claude` is installed via npm the binary
//! is `claude.cmd`, which `std::process` runs through `cmd.exe` — and cmd.exe rejects any argument
//! containing a newline ("batch file arguments are invalid"), same failure mode already worked
//! around in `opencode.rs`/`codex.rs`. Two arguments here can carry one: the ask (`-p`), when it's
//! short but multi-line (long asks already move to stdin — see `ai::chat_with_repo`'s
//! `INLINE_ASK_LIMIT` — but that swap is keyed on length, not on newlines), and the system prompt
//! (`--append-system-prompt`), several of whose fixed templates in `ai.rs` are themselves
//! multi-paragraph. [`ClaudeEngine::build_command`] routes both off the command line when that's
//! the case: the ask goes to stdin behind a fixed pointer (mirrors [`PROMPT_POINTER`]), and the
//! system prompt goes to a file via `--append-system-prompt-file` — verified against the installed
//! CLI (`claude --append-system-prompt-file <path>` reads it; confirmed against 2.1.226). The file
//! is private and deleted when the run ends; see `crate::ai_prompt_files`.
//!
//! **Read-only is enforced here, not requested.** For an invocation marked
//! [`AiInvocation::read_only`], `--tools` names the only built-in tools that *exist* for the run —
//! `--allowedTools` merely pre-approves some, and anything the user's own settings allow (an
//! `Edit` rule, `Bash(npm test:*)`) would still run beside them — and `--strict-mcp-config` with no
//! `--mcp-config` loads no MCP server, so no server's tools can write either. Both verified against
//! `claude --help` on 2.1.266.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;

use crate::ai::{
    quota_signal, refusal_reply, AiDelta, AiDeltaKind, AiEngine, AiInvocation, AiRateLimit, AiRun,
    AiUsage, QUOTA_MARKER,
};

/// Commit-message generation always runs on Haiku regardless of the user's configured review
/// model — it's a small, mechanical task that doesn't need a bigger model. The newest Haiku: this
/// sat on 4.5 after 5.5 shipped (2026-10-07), so an inheriting commit row ran an older Haiku than a
/// base model of Haiku 5.5. Keep it in step with `commitMessageModel` in `src/lib/aiProviders.ts`.
const COMMIT_MESSAGE_MODEL: &str = "claude-haiku-5-5";

/// Single-line, ASCII, shim-safe stand-in for an ask this engine can't put on the command line as
/// given — mirrors `codex.rs`'s `POINTER`. The real ask rides on stdin instead, ahead of the usual
/// skills note and data.
const PROMPT_POINTER: &str =
    "Your instructions for this turn are in the input provided via stdin. Read all of it and carry it out.";

/// Whether `prompt` is unsafe to hand to `-p` as-is on Windows (see the module docs).
fn needs_stdin_prompt(prompt: &str) -> bool {
    prompt.contains('\n')
}

/// Writes the system prompt to a private file for `--append-system-prompt-file`, so a
/// multi-paragraph prompt never has to survive the `.cmd` shim as a single argument. `None` on a
/// failed write, so the caller can fall back to passing it inline rather than losing the system
/// prompt outright. Deleted when the run ends — see `crate::ai_prompt_files`.
fn write_system_prompt_file(inv: &AiInvocation, sp: &str) -> Option<std::path::PathBuf> {
    inv.prompt_files.write("claude-system", "txt", sp)
}

/// The whole system prompt of a text-only run whose task brings none of its own: those tasks say
/// everything in the ask, and Claude Code's own prompt is written for an agent this run is not.
/// Every engine that can replace its CLI's prompt uses this one (`codex.rs` too).
pub(crate) const TEXT_ONLY_SYSTEM_PROMPT: &str = "Eres un asistente integrado en CodeFlow. Sigue al pie de la letra las \
    instrucciones del mensaje y responde solo con lo que piden.";

/// The settings a run adds over the user's own, as JSON, or `None` when it adds nothing.
///
/// - **Text-only:** no hooks. A plugin's `SessionStart` hook is context injected into every session
///   (Vercel's is ~8,500 characters), and a run with no tools has nothing for the others to watch.
/// - **Plugins kept out of the chats:** each one `false` in `enabledPlugins`, which drops its skills,
///   servers and hooks for this run. Verified on 2.1.304 with the init event and the token counts.
fn run_settings(inv: &AiInvocation) -> Option<String> {
    let mut settings = serde_json::Map::new();
    if inv.text_only {
        settings.insert("disableAllHooks".to_string(), serde_json::Value::Bool(true));
    }
    if !inv.disabled_plugins.is_empty() {
        let off: serde_json::Map<String, serde_json::Value> =
            inv.disabled_plugins.iter().map(|id| (id.clone(), serde_json::Value::Bool(false))).collect();
        settings.insert("enabledPlugins".to_string(), serde_json::Value::Object(off));
    }
    (!settings.is_empty()).then(|| serde_json::Value::Object(settings).to_string())
}

/// Where the plugins the user keeps out of CodeFlow's chats are stored: a JSON array of the ids
/// Claude Code knows them by (`name@marketplace`). Their own Claude Code is not touched.
pub const CHAT_PLUGINS_OFF_KEY: &str = "claude_chat_plugins_off";

/// The plugins kept out of CodeFlow's chats — see [`CHAT_PLUGINS_OFF_KEY`]. Empty when unset or
/// unreadable, which is what every chat ran with before the setting existed.
pub fn chat_plugins_off() -> Vec<String> {
    crate::ai_usage::with_conn(|conn| crate::db::queries::get_setting(conn, CHAT_PLUGINS_OFF_KEY).ok().flatten())
        .flatten()
        .map(|raw| parse_plugin_ids(&raw))
        .unwrap_or_default()
}

fn parse_plugin_ids(raw: &str) -> Vec<String> {
    let ids: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
    ids.into_iter().map(|id| id.trim().to_string()).filter(|id| id.contains('@')).collect()
}

pub struct ClaudeEngine;

impl AiEngine for ClaudeEngine {
    /// It reads `<cwd>/.claude/skills` itself, so describing them in the payload would be telling
    /// it something it already knows.
    fn native_skills_dir(&self) -> Option<&'static str> {
        Some(".claude/skills")
    }

    fn id(&self) -> &'static str {
        "claude"
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn default_binary(&self) -> &'static str {
        "claude"
    }

    fn commit_message_model(&self) -> &'static str {
        COMMIT_MESSAGE_MODEL
    }

    fn fix_tools(&self) -> Vec<String> {
        ["Read", "Edit", "Write", "Grep", "Glob"].iter().map(|s| s.to_string()).collect()
    }

    fn stdin_payload(&self, inv: &AiInvocation) -> String {
        let mut payload = String::new();
        if needs_stdin_prompt(inv.prompt) {
            payload.push_str(inv.prompt);
            payload.push_str("\n\n");
        }
        payload.push_str(&inv.skills_note);
        payload.push_str(inv.stdin_content);
        payload
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = crate::proc::command(binary);
        if needs_stdin_prompt(inv.prompt) {
            cmd.arg("-p").arg(PROMPT_POINTER);
        } else {
            cmd.arg("-p").arg(inv.prompt);
        }
        // A text-only run replaces Claude Code's system prompt rather than adding to it: that prompt
        // is written for an agent with tools, and this run has none. The subscription accepts it.
        if inv.text_only {
            let sp = inv.system_prompt.filter(|sp| !sp.trim().is_empty()).unwrap_or(TEXT_ONLY_SYSTEM_PROMPT);
            match write_system_prompt_file(inv, sp) {
                Some(path) => cmd.arg("--system-prompt-file").arg(path),
                None => cmd.arg("--system-prompt").arg(sp),
            };
        } else if let Some(sp) = inv.system_prompt {
            match write_system_prompt_file(inv, sp) {
                Some(path) => cmd.arg("--append-system-prompt-file").arg(path),
                None => cmd.arg("--append-system-prompt").arg(sp),
            };
        }
        if !inv.model.trim().is_empty() {
            cmd.arg("--model").arg(inv.model);
        }
        // `stream-json` (which the CLI only accepts alongside `--verbose` in `-p` mode) emits one
        // JSON event per line *as the run happens*, instead of a single blob at the very end.
        // That's what the app streams into the run log — under plain `json` there is literally
        // nothing to show until the process exits. The final `result` event carries exactly the
        // payload the old format produced, so `interpret_output` reads the same fields.
        cmd.arg("--output-format").arg("stream-json").arg("--verbose");
        // Partial frames **only when somebody is watching them arrive.** The flag turns the event
        // log into one frame per token, several times the output volume of the same answer, and
        // every other flow through this engine — commit messages, PR reviews, the fix-one-finding
        // pass — throws that away unread. It needs `-p` and `--output-format stream-json
        // --verbose`, all three of which are already above, so the condition is the only thing
        // standing between this and being free.
        if inv.stream_deltas.is_some() {
            cmd.arg("--include-partial-messages");
        }
        // Read-only first, because it narrows what the line below approves: `--tools` decides which
        // built-in tools exist at all for this run, where `--allowedTools` only decides which of the
        // existing ones run without asking. See the module docs.
        //
        // A text-only run gets nothing at all: no built-in tools, no MCP server, and no skills or
        // commands, whose listing alone is thousands of tokens. `--json-schema` still works, since
        // its answer tool is the CLI's own and not one of the built-in set.
        if inv.text_only {
            cmd.arg("--tools").arg("");
            cmd.arg("--strict-mcp-config");
            cmd.arg("--disable-slash-commands");
        } else if inv.read_only {
            let mut tools = self.read_only_tools();
            // `Skill` only when the caller asked for it — the chat does, compaction and story
            // analysis do not. A skill is instructions: with no shell and no writer beside it here,
            // it can guide the answer and nothing else.
            if inv.allowed_tools.iter().any(|tool| tool == "Skill") {
                tools.push("Skill".to_string());
            }
            cmd.arg("--tools").arg(tools.join(","));
            cmd.arg("--strict-mcp-config");
        }
        // The app's own servers this run loads — in a read-only run only the repository map, the one
        // server that can do nothing but read (`codemap::mcp`).
        let app_servers =
            if inv.text_only { Vec::new() } else { crate::codemap::mcp::loadable(&inv.app_mcp, inv.read_only) };
        let mut allowed: Vec<String> = inv.allowed_tools.to_vec();
        if app_servers.iter().any(|server| server.name == crate::codemap::mcp::SERVER_NAME) {
            allowed.push(crate::codemap::mcp::allow_rule());
        }
        if !allowed.is_empty() {
            cmd.arg("--allowedTools").arg(allowed.join(","));
        }
        // The user's servers this conversation keeps out: denied by rule, which also takes their
        // tools off the list the model is shown — context a turn no longer pays for.
        if !inv.mcp_block.is_empty() && !inv.read_only && !inv.text_only {
            let rules: Vec<String> = inv.mcp_block.iter().map(|server| mcp_rule(server)).collect();
            cmd.arg("--disallowedTools").arg(rules.join(","));
        }
        // The app's own servers: a private document of `${VAR}`s, deleted with the run, and the
        // values in this process's environment — never on the command line, never in the file.
        // Additive to the user's own servers (no `--strict-mcp-config` here).
        if !app_servers.is_empty() {
            let (document, vars) = crate::mcp_registry::claude_config(&app_servers);
            if let Some(path) = inv.prompt_files.write("claude-mcp", "json", &document) {
                cmd.arg("--mcp-config").arg(path);
                for (name, value) in vars {
                    cmd.env(name, value);
                }
            }
        }
        // Settings for this run alone, layered over the user's (`--settings`), so nothing in their
        // Claude Code changes. A file rather than the JSON inline, for the same `.cmd` shim reason as
        // the system prompt: quotes do not survive it.
        if let Some(settings) = run_settings(inv) {
            match inv.prompt_files.write("claude-settings", "json", &settings) {
                Some(path) => cmd.arg("--settings").arg(path),
                None => cmd.arg("--settings").arg(&settings),
            };
        }
        if inv.auto_approve_edits && !inv.read_only {
            cmd.arg("--permission-mode").arg("acceptEdits");
        }
        if let Some(id) = inv.resume_session_id {
            cmd.arg("--resume").arg(id);
        }
        // The CLI validates the final answer against the schema and retries the model itself until
        // it conforms; the object arrives as the verdict's `structured_output`, which
        // `interpret_output` prefers over the prose `result`. Verified on 2.1.287's binary.
        if let Some(schema) = inv.json_schema {
            cmd.arg("--json-schema").arg(schema);
        }
        // `--add-dir` takes several values, so each one is attached with `=`: a bare value would let
        // the option swallow whatever positional argument came next as one more directory.
        for dir in inv.extra_dirs {
            cmd.arg(format!("--add-dir={dir}"));
        }
        if let Some(dir) = inv.cwd {
            cmd.current_dir(dir);
        }
        cmd
    }

    /// Claude Code's read-only set. Passed as both `--tools` (what exists) and `--allowedTools`
    /// (what runs unasked) on a read-only run — see the module docs.
    fn read_only_tools(&self) -> Vec<String> {
        ["Read", "Grep", "Glob", "WebFetch", "WebSearch"].iter().map(|s| s.to_string()).collect()
    }

    /// Enforced by the CLI: `--tools` leaves the write and shell tools out of the run entirely, and
    /// `--strict-mcp-config` loads no MCP server whose tools could write instead.
    fn supports_extra_dirs(&self) -> bool {
        true
    }

    fn enforces_read_only(&self) -> bool {
        true
    }

    /// Claude's scale is this app's scale — `--effort low|medium|high|xhigh|max`. The two extra
    /// steps it offers above `high` are why the neutral scale tops out at `max` rather than at
    /// `high`: this is the one CLI that would have lost a level to a three-step vocabulary.
    /// Every Claude model takes images, and Claude Code's `Read` returns a PNG or a JPEG to the model
    /// as an image — so a screenshot named in the message is one it looks at.
    fn model_reads_images(&self, _model: &str) -> bool {
        true
    }

    fn effort_args(&self, effort: &str) -> Vec<String> {
        vec!["--effort".into(), effort.into()]
    }

    /// A failed run still ends in a `result` event, and that event carries the turn's usage and
    /// cost — an `error_during_execution` after twelve tool calls says so. A refusal's are zeros,
    /// and an empty report is dropped by the caller.
    fn reported_usage(&self, stdout: &str, _stderr: &str) -> Option<AiUsage> {
        result_payload(stdout).as_ref().and_then(usage_of)
    }

    /// `total_cost_usd` is the session's, not the run's: a resumed run starts from the total the
    /// session's `cost-state` kept (2.1.305) — turn 2 of a Haiku chat reported turn 1's $0.00396
    /// plus its own $0.00115. The tokens beside it in `usage` are the run's own.
    fn session_cost(&self, stdout: &str) -> Option<(String, f64)> {
        let verdict = result_payload(stdout)?;
        Some((verdict.session_id?, verdict.total_cost_usd?))
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        // Filed before the verdict is judged, because the two are independent: a run that failed
        // still reported its plan windows and still listed the commands this install has, and a
        // failure is precisely when the first of those is worth having.
        record_run_meta(stdout);
        interpret_output(success, status_label, stdout, stderr)
    }

    /// The only engine that does. See [`AiEngine::streams_partial`] for what rests on that.
    fn streams_partial(&self) -> bool {
        true
    }

    fn parse_delta(&self, line: &str) -> Vec<AiDelta> {
        parse_delta_line(line)
    }
}

/// The permission rule covering every tool of one MCP server, as Claude Code names them.
///
/// The server name with anything outside `[A-Za-z0-9_-]` turned into `_` — and, for a claude.ai
/// connector (`claude.ai Gmail`), runs of `_` collapsed and the ends trimmed — behind `mcp__`. Read
/// out of the 2.1.266 binary rather than guessed, because a rule that misses by one character
/// allows nothing and says nothing: `claude.ai Gmail` is `mcp__claude_ai_Gmail`, not
/// `mcp__claude_ai__Gmail`.
pub fn mcp_rule(server: &str) -> String {
    let mut name: String = server
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if server.starts_with("claude.ai ") {
        let mut collapsed = String::with_capacity(name.len());
        for c in name.chars() {
            if c == '_' && collapsed.ends_with('_') {
                continue;
            }
            collapsed.push(c);
        }
        name = collapsed.trim_matches('_').to_string();
    }
    format!("mcp__{name}")
}

/// Pulls the text/thinking chunks out of one line of `--include-partial-messages` output.
///
/// The shape, captured verbatim from `claude 2.1.266` rather than assumed:
///
/// ```json
/// {"type":"stream_event","event":{"type":"content_block_delta","index":1,
///  "delta":{"type":"text_delta","text":"one"}}}
/// ```
///
/// Three things about it are worth writing down, because none is guessable:
///
/// 1. **The reply is not block 0.** On a thinking-capable model, index 0 is a `thinking` block and
///    its deltas arrive *before* the first `text_delta` of index 1. A reader that assumed the
///    first deltas it saw were the answer would paint the model's reasoning into the bubble.
/// 2. **`signature_delta` is dropped on the floor.** It carries the base64 attestation of the
///    thinking block — hundreds of characters of it, per block, in the same `content_block_delta`
///    envelope as real text. It is not prose, nobody can read it, and appending it to either
///    channel would dump a wall of base64 into the middle of a sentence.
/// 3. **The field is named after the kind.** `text_delta` carries `text`, `thinking_delta` carries
///    `thinking`. There is no shared key to read.
///
/// Every failure is silent and empty by construction: this runs per line inside the output pump,
/// and a newer CLI that renamed a field must cost this turn its typing, never the run.
fn parse_delta_line(line: &str) -> Vec<AiDelta> {
    let line = line.trim();
    if !line.starts_with('{') {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Vec::new();
    };
    if str_field(&value, "type") != Some("stream_event") {
        return Vec::new();
    }
    let Some(event) = value.get("event") else { return Vec::new() };
    if str_field(event, "type") != Some("content_block_delta") {
        return Vec::new();
    }
    let Some(delta) = event.get("delta") else { return Vec::new() };
    let (kind, key) = match str_field(delta, "type") {
        Some("text_delta") => (AiDeltaKind::Text, "text"),
        Some("thinking_delta") => (AiDeltaKind::Thinking, "thinking"),
        // `signature_delta` and anything a later version adds: not prose, not ours to render.
        _ => return Vec::new(),
    };
    match str_field(delta, key) {
        Some(text) => vec![AiDelta { kind, text: text.to_string() }],
        None => Vec::new(),
    }
}

/// One string field of a JSON object, borrowed. A free function rather than a closure so that it
/// hands back a `&str` tied to the value instead of a `String` per lookup — four allocations per
/// token, on the one path in this file that runs per token.
fn str_field<'v>(value: &'v serde_json::Value, key: &str) -> Option<&'v str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

/// The last plan windows each **account** reported, with when — keyed by
/// [`crate::ai_accounts::AccountEnv::key`] (`claude` for the system account).
///
/// Per account because the windows are a fact about one account's plan, and reporting the work
/// account's week under the personal one would be a wrong number on the one panel whose only value
/// is being trusted. Why a cache and not a field on [`AiRun`]: `AiRun` is built with struct
/// literals by all six engines, and the only consumer asks "how full am I now", a property of the
/// account rather than of any one turn.
fn limits_cell() -> &'static Mutex<std::collections::HashMap<String, (AiRateLimit, String)>> {
    static LIMITS: OnceLock<Mutex<std::collections::HashMap<String, (AiRateLimit, String)>>> = OnceLock::new();
    LIMITS.get_or_init(Mutex::default)
}

/// The plan windows `account_key` last reported and the instant it did, if it has run in this
/// process. What an added account's row in the limits panel is drawn from — this app reads no
/// token for an account it added; the CLI tells it on every run. See `ai_quota::claude`.
pub fn last_rate_limit(account_key: &str) -> Option<(AiRateLimit, String)> {
    if let Some(found) = limits_cell().lock().ok()?.get(account_key).cloned() {
        return Some(found);
    }
    // Not run since the app started: what the last run before it reported, if it was kept. The
    // caller drops windows that have rolled over since, so an old reading cannot pass as today's.
    let stored = crate::ai_usage::setting(&stored_rate_limit_key(account_key))?;
    serde_json::from_str::<StoredRateLimit>(&stored).ok().map(|kept| (kept.limit, kept.at))
}

/// Where an account's last reported windows are kept between launches — percentages and reset
/// times, nothing that identifies or authenticates anyone. Without it a restart left the limits
/// panel with nothing to fall back on until the engine ran again (user report, 2026-10-20).
fn stored_rate_limit_key(account_key: &str) -> String {
    format!("claude_last_rate_limit:{account_key}")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredRateLimit {
    limit: AiRateLimit,
    at: String,
}

/// Files what a finished run reported about itself: the windows it ran in and the context window
/// of each model it used. A run that failed to launch, or whose output was cut short, prints
/// neither — and replaces nothing. (What the install offers — skills, commands, servers — is filed
/// by [`record_install_from_run`], from chat turns only.)
fn record_run_meta(stdout: &str) {
    record_context_windows(stdout);
    // Filed under the account the run was — `interpret` is called inside `with_account` by an
    // engine bound to one, and outside it for the system account.
    if let Some(limit) = parse_rate_limit(stdout) {
        let key = crate::ai_accounts::current().map(|env| env.key()).unwrap_or_else(|| "claude".to_string());
        let previous = last_rate_limit(&key).map(|(old, _)| old);
        let merged = merge_rate_limit(previous.as_ref(), limit, chrono::Utc::now().timestamp());
        let at = chrono::Utc::now().to_rfc3339();
        if let Ok(stored) = serde_json::to_string(&StoredRateLimit { limit: merged, at: at.clone() }) {
            crate::ai_usage::with_conn(|conn| crate::db::queries::set_setting(conn, &stored_rate_limit_key(&key), &stored));
        }
        if let Ok(mut limits) = limits_cell().lock() {
            limits.insert(key, (merged, at));
        }
    }
}

/// Files the context window the CLI stated for each model it ran, so the chat's gauge and its
/// automatic compaction measure against the CLI's number rather than the family table's guess.
///
/// Claude Code builds every `modelUsage` entry with `contextWindow` (and `maxOutputTokens`) for the
/// model and the betas it actually used — read out of the 2.1.266 binary, where the entry is
/// `{...usage, contextWindow, maxOutputTokens}`. A run that reports none (an older CLI, a failure
/// before the first call) files nothing and the table keeps answering. See
/// [`crate::ai::record_context_window`].
fn record_context_windows(stdout: &str) {
    let Some(result) = result_payload(stdout) else { return };
    for (model, usage) in &result.model_usage {
        if let Some(window) = usage.get("contextWindow").and_then(serde_json::Value::as_i64) {
            crate::ai::record_context_window(model, window);
        }
    }
}

/// The `rate_limit_event` line, captured verbatim from a real run:
///
/// ```json
/// {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour",
///  "unifiedWindows":{"five_hour":{"utilization":0.31,"resetsAt":1789700400},
///                    "seven_day":{"utilization":0.53,"resetsAt":1790010000}}}}
/// ```
///
/// `utilization` is a **fraction**, not a percentage — 0.31 is 31% of the five-hour window spent.
/// It is converted here, once, so that [`AiRateLimit`] can hold the same 0–100 the rest of the app
/// means by "percent" and nothing downstream has to remember which source it came from.
///
/// The last such line wins: the CLI reports one per API call, and a turn that made several has
/// only one current answer. **Per window**, though: an event may carry only the window it is about
/// (`"unifiedWindows":{"five_hour":{…}}` alone, seen 2026-10-20), and a window it leaves out keeps
/// what an earlier event said — or stays at a `0` reset, which is how "not reported" reads
/// downstream, rather than becoming a week at 0%.
fn parse_rate_limit(stdout: &str) -> Option<AiRateLimit> {
    let mut found: Option<AiRateLimit> = None;
    for line in stdout.lines() {
        let line = line.trim();
        // Cheap gate first: this walks a log that can be megabytes of tool chatter, and a JSON
        // parse per line of it would cost more than the number is worth.
        if !line.starts_with('{') || !line.contains("\"rate_limit_event\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<RateLimitEvent>(line) else { continue };
        if event.event_type != "rate_limit_event" {
            continue;
        }
        let Some(windows) = event.rate_limit_info.and_then(|info| info.unified_windows) else {
            continue;
        };
        let mut next = found.unwrap_or_default();
        if windows.five_hour.resets_at > 0 {
            next.five_hour_pct = windows.five_hour.utilization * 100.0;
            next.five_hour_resets_at = windows.five_hour.resets_at;
        }
        if windows.seven_day.resets_at > 0 {
            next.seven_day_pct = windows.seven_day.utilization * 100.0;
            next.seven_day_resets_at = windows.seven_day.resets_at;
        }
        found = Some(next);
    }
    found
}

/// `fresh` over what the account reported before, window by window: a run whose events named only
/// the session keeps the week the previous run reported, as long as that week has not rolled over.
fn merge_rate_limit(previous: Option<&AiRateLimit>, fresh: AiRateLimit, now: i64) -> AiRateLimit {
    let Some(previous) = previous else { return fresh };
    let mut out = fresh;
    if out.five_hour_resets_at == 0 && previous.five_hour_resets_at > now {
        out.five_hour_pct = previous.five_hour_pct;
        out.five_hour_resets_at = previous.five_hour_resets_at;
    }
    if out.seven_day_resets_at == 0 && previous.seven_day_resets_at > now {
        out.seven_day_pct = previous.seven_day_pct;
        out.seven_day_resets_at = previous.seven_day_resets_at;
    }
    out
}

/// Both shapes are defaulted end to end on purpose: these events are telemetry riding along with
/// the answer, and a field the CLI renames next month must cost the meter its number, never the
/// turn its reply.
#[derive(Deserialize)]
struct RateLimitEvent {
    #[serde(rename = "type", default)]
    event_type: String,
    #[serde(default)]
    rate_limit_info: Option<RateLimitInfo>,
}

#[derive(Deserialize)]
struct RateLimitInfo {
    #[serde(rename = "unifiedWindows", default)]
    unified_windows: Option<UnifiedWindows>,
}

#[derive(Deserialize)]
struct UnifiedWindows {
    #[serde(default)]
    five_hour: RateWindow,
    #[serde(default)]
    seven_day: RateWindow,
}

#[derive(Default, Deserialize)]
struct RateWindow {
    /// 0–1, as the CLI reports it.
    #[serde(default)]
    utilization: f64,
    /// Seconds since the epoch.
    #[serde(rename = "resetsAt", default)]
    resets_at: i64,
}

#[derive(Deserialize)]
struct InitEvent {
    #[serde(rename = "type", default)]
    event_type: String,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    slash_commands: Vec<String>,
    /// The skills this run could use — the user's, the plugins' (`vercel:deploy`) and the ones built
    /// into the CLI, which exist nowhere on disk and are known only from here.
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    mcp_servers: Vec<McpServerState>,
    #[serde(default)]
    plugins: Vec<PluginRef>,
    /// The tools that existed for the run, which says whether its MCP list can be trusted: a run
    /// restricted with `--tools`/`--strict-mcp-config` reports no servers because it loaded none.
    #[serde(default)]
    tools: Vec<String>,
}

/// One MCP server as the `init` event reports it — `connected`, `pending`, `needs-auth`, `failed`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, serde::Serialize)]
pub struct McpServerState {
    pub name: String,
    #[serde(default)]
    pub status: String,
    /// Where the CLI got it: `plugin`, `claudeai`, the user's config — or `dynamic`, a server this
    /// app handed the run with `--mcp-config` (the repository map, the servers declared in CodeFlow).
    /// Read to leave those out of the report, never stored.
    #[serde(default, skip_serializing)]
    pub source: String,
}

/// An installed plugin as the `init` event names it: where its skills and commands live on disk.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, serde::Serialize)]
pub struct PluginRef {
    pub name: String,
    #[serde(default)]
    pub path: String,
    /// The id Claude Code knows it by — `vercel@claude-plugins-official`, `design@synced`,
    /// `…@builtin` for the ones that come with the CLI — which is what `enabledPlugins` is keyed by.
    /// Empty in a report filed before it was kept.
    #[serde(default)]
    pub source: String,
}

/// What a Claude Code install told the most recent **full** chat-capable run about itself, per
/// account — the half of `init` that describes the machine rather than the turn.
///
/// Kept per account because each `CLAUDE_CONFIG_DIR` has its own skills, plugins and servers, and
/// on disk in the cache root because a menu opened right after a restart should not be empty until
/// the next turn: this describes this machine, so it lives with the regenerable cache and never
/// travels in a backup.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
pub struct ClaudeInstallReport {
    #[serde(default)]
    pub slash_commands: Vec<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub plugins: Vec<PluginRef>,
    /// Installed plugins the chats keep out ([`CHAT_PLUGINS_OFF_KEY`]), so absent from `plugins` —
    /// remembered so Settings can still list them to switch back on.
    #[serde(default)]
    pub plugins_off: Vec<PluginRef>,
    /// `None` until a run that loaded the user's servers has reported them — a restricted run's
    /// empty list is not an answer, and must not erase one.
    #[serde(default)]
    pub mcp_servers: Option<Vec<McpServerState>>,
    /// When it was reported, RFC 3339.
    #[serde(default)]
    pub reported_at: String,
}

fn reports_cell() -> &'static Mutex<Option<BTreeMap<String, ClaudeInstallReport>>> {
    static REPORTS: OnceLock<Mutex<Option<BTreeMap<String, ClaudeInstallReport>>>> = OnceLock::new();
    REPORTS.get_or_init(|| Mutex::new(None))
}

/// The reports in `cell`, read from the cache file the first time.
fn loaded_reports(cell: &mut Option<BTreeMap<String, ClaudeInstallReport>>) -> &mut BTreeMap<String, ClaudeInstallReport> {
    cell.get_or_insert_with(|| {
        std::fs::read_to_string(reports_file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    })
}

fn reports_file() -> std::path::PathBuf {
    // Tests feed `interpret` fixtures that carry `init` events; none of them may reach the file the
    // app reads its menus from.
    #[cfg(test)]
    return std::env::temp_dir().join(format!("cf-claude-install-reports-{}.json", std::process::id()));
    #[cfg(not(test))]
    crate::paths::cache_dir().join("claude-install-reports.json")
}

/// What `account_key` (see `AccountEnv::key`, `claude` for the system account) last reported, if it
/// has ever run here — from memory, or from the cache file after a restart.
pub fn install_report(account_key: &str) -> Option<ClaudeInstallReport> {
    let mut cell = reports_cell().lock().ok()?;
    let reports = loaded_reports(&mut cell);
    reports.get(account_key).cloned()
}

/// Files a run's `init` under its account. Commands, skills and plugins are replaced by any run
/// that reported them; the server list only by a run that actually loaded the user's servers.
/// `kept_out` are the plugins the run switched off: missing from its list by choice, so whatever
/// was known about them moves to `plugins_off` rather than being forgotten.
fn record_install_report(account_key: &str, init: InitEvent, kept_out: &[String]) {
    let Ok(mut cell) = reports_cell().lock() else { return };
    let reports = loaded_reports(&mut cell);
    let entry = reports.entry(account_key.to_string()).or_default();
    if !init.slash_commands.is_empty() {
        entry.slash_commands = init.slash_commands;
    }
    if !init.skills.is_empty() {
        entry.skills = init.skills;
    }
    if !init.plugins.is_empty() {
        let loaded: std::collections::HashSet<String> = init.plugins.iter().map(|plugin| plugin.source.clone()).collect();
        let mut off: Vec<PluginRef> = Vec::new();
        for plugin in entry.plugins.iter().chain(entry.plugins_off.iter()) {
            let id = &plugin.source;
            if kept_out.contains(id) && !loaded.contains(id) && !off.iter().any(|known| &known.source == id) {
                off.push(plugin.clone());
            }
        }
        entry.plugins = init.plugins;
        entry.plugins_off = off;
    }
    // A run whose tool set was cut down (`--tools`, which the read-only paths use together with
    // `--strict-mcp-config`) loaded no servers by design; only one with the ordinary writers in hand
    // speaks for what the user has configured.
    let full_run = init.tools.iter().any(|tool| tool == "Edit" || tool == "Bash" || tool == "Write");
    // Not the servers this app passed the run itself (`dynamic`): they are not the user's, and listed
    // here they read as a server the user never pre-approved — so the next turn's plan kept them out
    // with `--disallowedTools`, and the repository map lost its tools from a conversation's second
    // turn on (user report, 2026-10-10: "codeflow_map ya no está disponible en esta sesión").
    if full_run {
        entry.mcp_servers = Some(init.mcp_servers.into_iter().filter(|server| server.source != "dynamic").collect());
    }
    entry.reported_at = chrono::Utc::now().to_rfc3339();
    if let Ok(text) = serde_json::to_string(&*reports) {
        let file = reports_file();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, text);
    }
}

/// Files what a chat turn's `init` said about the install, under `account_key`.
///
/// The project's own skills and commands are taken out first — the ones in `<cwd>/.claude` — since
/// the report stands for the *install*, and a repository's `.claude/skills` would otherwise be
/// listed in every other conversation as if it came with the CLI.
pub fn record_install_from_run(account_key: &str, cwd: Option<&str>, stdout: &str, kept_out: &[String]) {
    let Some(mut init) = parse_init(stdout) else { return };
    if let Some(cwd) = cwd {
        let project = std::path::Path::new(cwd).join(".claude");
        let names = |dir: &std::path::Path, strip_md: bool| -> std::collections::HashSet<String> {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().to_string())
                        .map(|name| if strip_md { name.trim_end_matches(".md").to_string() } else { name })
                        .collect()
                })
                .unwrap_or_default()
        };
        let skills = names(&project.join("skills"), false);
        let commands = names(&project.join("commands"), true);
        init.skills.retain(|name| !skills.contains(name));
        init.slash_commands.retain(|name| !skills.contains(name) && !commands.contains(name));
    }
    record_install_report(account_key, init, kept_out);
}

/// One of the user's Claude Code plugins, as Settings lists it for the chats.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPlugin {
    /// `name@marketplace` — the key `enabledPlugins` takes.
    pub id: String,
    pub name: String,
    /// Kept out of CodeFlow's chats.
    pub off: bool,
}

/// The plugins a chat could load, for Settings: every one a run on any account has reported —
/// loaded or kept out — then those `settings_json` (the system account's `settings.json`) enables,
/// for an install no chat has run on yet. The ones built into the CLI are left out: they are part
/// of Claude Code, not something the user installed.
pub fn chat_plugins(settings_json: Option<&str>) -> Vec<ChatPlugin> {
    let reported: Vec<PluginRef> = install_reports_all()
        .into_iter()
        .flat_map(|report| report.plugins.into_iter().chain(report.plugins_off))
        .collect();
    plugin_list(reported, settings_json, &chat_plugins_off())
}

fn plugin_list(reported: Vec<PluginRef>, settings_json: Option<&str>, off: &[String]) -> Vec<ChatPlugin> {
    let enabled: Vec<String> = settings_json
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("enabledPlugins").and_then(serde_json::Value::as_object).cloned())
        .map(|map| map.into_iter().filter(|(_, on)| on.as_bool() == Some(true)).map(|(id, _)| id).collect())
        .unwrap_or_default();
    let mut out: Vec<ChatPlugin> = Vec::new();
    let mut add = |id: String, name: String| {
        if id.is_empty() || id.ends_with("@builtin") || out.iter().any(|plugin| plugin.id == id) {
            return;
        }
        let off = off.contains(&id);
        out.push(ChatPlugin { id, name, off });
    };
    for plugin in reported {
        // A report filed before ids were kept: the id is found by name among the enabled ones.
        let id = if plugin.source.is_empty() {
            enabled.iter().find(|id| id.split('@').next() == Some(plugin.name.as_str())).cloned().unwrap_or_default()
        } else {
            plugin.source.clone()
        };
        add(id, plugin.name.clone());
    }
    for id in enabled {
        let name = id.split('@').next().unwrap_or(&id).to_string();
        add(id, name);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    out
}

/// Every account's report, from memory or the cache file.
fn install_reports_all() -> Vec<ClaudeInstallReport> {
    let Ok(mut cell) = reports_cell().lock() else { return Vec::new() };
    let reports = loaded_reports(&mut cell);
    reports.values().cloned().collect()
}

/// The `init` event of a run, whole. The first one wins — a run emits exactly one.
fn parse_init(stdout: &str) -> Option<InitEvent> {
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') || !line.contains("\"init\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<InitEvent>(line) else { continue };
        if event.event_type == "system" && event.subtype.as_deref() == Some("init") {
            return Some(event);
        }
    }
    None
}

#[derive(Deserialize)]
struct ClaudeCliResult {
    result: Option<String>,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    session_id: Option<String>,
    /// Token accounting keyed by the model id the CLI *actually* used. This is the only way to
    /// report a concrete version when no `--model` was passed and the CLI picked for itself.
    #[serde(default, rename = "modelUsage")]
    model_usage: BTreeMap<String, serde_json::Value>,
    /// The turn's own token counts, as the CLI reports them on its result envelope.
    #[serde(default)]
    usage: Option<ClaudeUsage>,
    #[serde(default)]
    total_cost_usd: Option<f64>,
    /// The answer as an object, when the run was given `--json-schema`. Already validated by the
    /// CLI; `null` or absent on every other run.
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
}

/// The `usage` object of a `--output-format json` result.
///
/// Every field is defaulted: the CLI has added fields to this object across versions and will add
/// more, and a strict shape here would turn "Claude reported its usage in a slightly newer format"
/// into "the whole turn failed to parse".
#[derive(Default, Deserialize)]
struct ClaudeUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    #[serde(default)]
    cache_read_input_tokens: i64,
    #[serde(default)]
    cache_creation_input_tokens: i64,
}

/// The model that wrote this run's answer: the last step of the main thread that a model took.
///
/// Read from the steps because `modelUsage` is the session's, like the cost — a conversation that
/// switched model mid-way lists both, and [`model_used`] then cannot say. A subagent's steps
/// (`parent_tool_use_id` set) are its own model's, and a CLI-answered command's are `<synthetic>`.
fn last_step_model(stdout: &str) -> Option<String> {
    stdout.lines().rev().map(str::trim).filter(|line| line.starts_with('{')).find_map(|line| {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
            return None;
        }
        if value.get("parent_tool_use_id").is_some_and(|parent| !parent.is_null()) {
            return None;
        }
        let model = value.get("message")?.get("model")?.as_str()?.trim();
        (!model.is_empty() && model != "<synthetic>").then(|| model.to_string())
    })
}

fn model_used(parsed: &ClaudeCliResult) -> Option<String> {
    match parsed.model_usage.len() {
        1 => parsed.model_usage.keys().next().cloned(),
        _ => None,
    }
}

fn usage_of(parsed: &ClaudeCliResult) -> Option<AiUsage> {
    let usage = parsed.usage.as_ref()?;
    let reported = AiUsage {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        cache_write_tokens: usage.cache_creation_input_tokens,
        cost_usd: parsed.total_cost_usd,
    };
    // A run that asked the model nothing — `/context` and `/usage`, answered by the CLI itself —
    // bills zero tokens and still carries `total_cost_usd`, which on a resumed session is the
    // session's spend so far (2.1.305). Recorded, every such command billed the turns before it
    // a second time.
    let asked_nothing = reported.input_tokens == 0
        && reported.output_tokens == 0
        && reported.cache_read_tokens == 0
        && reported.cache_write_tokens == 0;
    match reported.is_empty() || asked_nothing {
        true => None,
        false => Some(reported),
    }
}

/// How many tokens were in front of the model on the **final** step of this run.
///
/// # Why not the `result` event's usage
///
/// That object is the run's *bill*: it sums every API call the turn made, so an answer that read
/// four files reports roughly four prompts' worth of input. Correct for spend — `ai_usage` uses
/// exactly that — and badly wrong as an answer to "how full is the context", which is the question
/// the chat's meter asks. It would grow with the amount of tool use rather than with the length of
/// the conversation, and on a long agentic turn it would sail past the model's window while the
/// conversation itself was nowhere near it.
///
/// So this reads the **last** `assistant` event instead. Each one carries the usage of the single
/// API call that produced it, and the last one is the call that wrote the answer — by then holding
/// the whole conversation, the system prompt, the tool schemas and every tool result so far. That
/// is the occupancy figure, and it is one the app could not compute for itself at any price.
///
/// The three input fields are summed because a token served from cache takes up exactly as much of
/// the window as one that was not — the distinction that matters to a bill does not exist here.
///
/// `None` when no assistant event carried usage, which covers a run that failed before answering
/// and any future output format this does not recognise. The caller falls back to an estimate and
/// says that it has.
fn last_step_context(stdout: &str) -> Option<i64> {
    for line in stdout.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(usage) = value.get("message").and_then(|m| m.get("usage")) else {
            continue;
        };
        let field = |name: &str| usage.get(name).and_then(serde_json::Value::as_i64).unwrap_or(0);
        let total = field("input_tokens")
            + field("cache_read_input_tokens")
            + field("cache_creation_input_tokens");
        if total > 0 {
            return Some(total);
        }
    }
    None
}

/// Picks the payload to interpret out of the CLI's stdout.
///
/// Under `stream-json` stdout is one JSON event per line and the last `{"type":"result",…}` is
/// the run's verdict — the same object the old single-blob `json` format printed on its own.
/// Falling back to parsing the whole buffer keeps a CLI that ignored (or doesn't know) the flag
/// working exactly as before, so this is safe against both older and newer versions.
fn result_payload(stdout: &str) -> Option<ClaudeCliResult> {
    for line in stdout.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            if value.get("type").and_then(serde_json::Value::as_str) == Some("result") {
                return serde_json::from_value(value).ok();
            }
        }
    }
    serde_json::from_str::<ClaudeCliResult>(stdout).ok()
}

/// Turns one finished `claude` run into either its reply text (plus the session id) or an error
/// message for the frontend.
///
/// Under `--output-format json` the CLI reports its *own* failures on stdout — as
/// `{"is_error":true,"result":"<reason>"}` — and exits non-zero leaving stderr **empty**. So
/// stdout has to be parsed before the exit status is judged: branching on the status first and
/// reporting stderr discarded the only copy of the reason (expired auth, unknown model, …) and
/// left the user staring at a bare "claude exited with an error:" with nothing after it.
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<AiRun, String> {
    let parsed = result_payload(stdout);
    // A schema-constrained run's answer is the object, not the prose beside it. Only on a clean
    // verdict: a failed run's `result` is its reason, and that is what has to be reported.
    let structured = parsed
        .as_ref()
        .filter(|p| success && !p.is_error)
        .and_then(|p| p.structured_output.as_ref())
        .filter(|value| !value.is_null())
        .map(|value| value.to_string());
    let result_text = structured.as_deref().or_else(|| {
        parsed
            .as_ref()
            .and_then(|p| p.result.as_deref())
            .map(str::trim)
            .filter(|t| !t.is_empty())
    });

    if let Some(text) = result_text {
        let failed = !success || parsed.as_ref().is_some_and(|p| p.is_error);
        // Which question to ask depends on whether this text is a *reason* or an *answer*: on a
        // failed run any signal anywhere explains the failure, but on a successful one only a
        // message that is nothing but the refusal counts — and never one the model generated.
        // See `refusal_reply`.
        let generated = parsed.as_ref().and_then(|p| p.usage.as_ref()).map(|u| u.output_tokens);
        let refused = match failed {
            true => quota_signal(text),
            false => refusal_reply(text, generated),
        };
        if refused {
            return Err(format!("{QUOTA_MARKER}{text}"));
        }
        if failed {
            return Err(text.to_string());
        }
        let model = last_step_model(stdout).or_else(|| parsed.as_ref().and_then(model_used));
        let usage = parsed.as_ref().and_then(usage_of);
        return Ok(AiRun {
            text: text.to_string(),
            session_id: parsed.and_then(|p| p.session_id),
            model,
            usage,
            context_tokens: last_step_context(stdout),
        });
    }

    // A clean verdict with nothing to say is a command that *did* something instead of saying
    // something: `/compact` compacts the session in place, `/clear` swaps it for a new one — whose
    // id is the one the verdict carries. The reply is empty, which the chat shows as done. What it
    // must never be is the stream around it: the fallback below handed every line of stdout back as
    // the answer, init event and hooks included (`/compact` on 2.1.266, in the repository chat).
    // `result` present but empty — the whole-buffer fallback in `result_payload` reads any lone JSON
    // object as a verdict, and an `init` with nothing after it is not one.
    if let Some(verdict) = parsed.as_ref().filter(|p| success && !p.is_error && p.result.is_some()) {
        return Ok(AiRun {
            text: String::new(),
            session_id: verdict.session_id.clone(),
            model: last_step_model(stdout).or_else(|| model_used(verdict)),
            usage: usage_of(verdict),
            context_tokens: last_step_context(stdout),
        });
    }

    let readable = readable_stdout(stdout);
    if !success {
        if quota_signal(stderr) {
            return Err(format!("{QUOTA_MARKER}{}", stderr.trim()));
        }
        if quota_signal(stdout) {
            let reason = if readable.is_empty() { stdout.trim() } else { readable.as_str() };
            return Err(format!("{QUOTA_MARKER}{reason}"));
        }
        // Neither stream carried a usable message — report the exit status rather than an
        // error string that trails off into nothing.
        let detail = [stderr.trim(), readable.as_str()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("sin salida en stdout ni stderr");
        return Err(format!("claude exited with an error ({status_label}): {detail}"));
    }

    if readable.is_empty() {
        return Err("claude produced no output".to_string());
    }
    if refusal_reply(&readable, None) {
        return Err(format!("{QUOTA_MARKER}{readable}"));
    }
    Ok(AiRun { text: readable, session_id: None, model: None, usage: None, context_tokens: None })
}

/// What of stdout a person could read, for a run that left no verdict to read instead.
///
/// Plain text — a CLI that ignored the format flag — passes through as it is. An event stream is the
/// CLI's protocol and never prose: from it only the text of the last `assistant` message survives
/// (a synthetic refusal says what happened there), and nothing at all when there is none.
fn readable_stdout(stdout: &str) -> String {
    let first = stdout.lines().map(str::trim).find(|line| !line.is_empty());
    let is_event_stream = first.is_some_and(|line| {
        serde_json::from_str::<serde_json::Value>(line).is_ok_and(|value| str_field(&value, "type").is_some())
    });
    if !is_event_stream {
        return stdout.trim().to_string();
    }
    for line in stdout.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
        if str_field(&value, "type") != Some("assistant") {
            continue;
        }
        let Some(parts) = value.get("message").and_then(|m| m.get("content")).and_then(serde_json::Value::as_array) else {
            continue;
        };
        let text = parts
            .iter()
            .filter(|part| str_field(part, "type") == Some("text"))
            .filter_map(|part| str_field(part, "text"))
            .collect::<Vec<_>>()
            .join("\n");
        if !text.trim().is_empty() {
            return text.trim().to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `--json-schema` run of 2.1.287 in `-p` mode, captured against a fake API on
    /// 2026-10-02 and trimmed to the fields read: the CLI has the model call its `StructuredOutput`
    /// tool and hands the validated object back as `structured_output` (and, as text, in `result`).
    #[test]
    fn a_schema_bound_run_answers_with_its_structured_output() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"init","session_id":"99960bd9"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"stop_reason":"tool_use","session_id":"99960bd9","result":"{\"summary\":\"CSV helper\",\"tasks\":[]}","structured_output":{"summary":"CSV helper","tasks":[{"id":"t1","title":"csv","file":"src/csv.ts","action":"create","regions":[],"instruction":"Create toCsv.","context":[],"acceptance":["exports toCsv"],"depends_on":[],"difficulty":"easy"}],"checks":[],"risks":[]},"usage":{"input_tokens":120,"output_tokens":80},"modelUsage":{"claude-sonnet-4-5":{"outputTokens":80}}}"#,
            "\n",
        );
        let run = interpret_output(true, "exit 0", stdout, "").expect("an answer");
        // The object wins over the prose `result`, which here was deliberately made to differ.
        let plan = crate::hybrid::plan::parse(&run.text).expect("a plan");
        assert_eq!(plan.tasks.len(), 1);
        assert_eq!(plan.tasks[0].file, "src/csv.ts");
        assert_eq!(run.session_id.as_deref(), Some("99960bd9"));
    }

    #[test]
    fn a_failed_schema_run_reports_its_reason_not_a_stale_object() {
        let stdout = r#"{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"result":"structured output did not match the schema","structured_output":{"summary":"half"},"usage":{"input_tokens":10,"output_tokens":5}}"#;
        let error = interpret_output(false, "exit 1", stdout, "").expect_err("a failure");
        assert!(error.contains("did not match"), "{error}");
    }

    #[test]
    fn a_single_line_ask_stays_on_the_command_line() {
        assert!(!needs_stdin_prompt("fix the null check"));
    }

    /// Short but multi-line is exactly the shape a task description has — the case the
    /// length-only `INLINE_ASK_LIMIT` swap in `ai::chat_with_repo` doesn't catch.
    #[test]
    fn a_multiline_ask_is_routed_to_stdin() {
        assert!(needs_stdin_prompt("line one\nline two"));
    }

    #[test]
    fn a_multiline_ask_is_prepended_to_the_stdin_payload() {
        let mut inv = AiInvocation::new("line one\nline two", "the data");
        inv.skills_note = "skills: none\n".to_string();
        let payload = ClaudeEngine.stdin_payload(&inv);
        assert_eq!(payload, "line one\nline two\n\nskills: none\nthe data");
    }

    #[test]
    fn a_single_line_ask_is_left_out_of_the_stdin_payload() {
        let inv = AiInvocation::new("fix the null check", "the data");
        assert_eq!(ClaudeEngine.stdin_payload(&inv), "the data");
    }

    /// Real payload from a failing `claude -p … --output-format json` run on macOS: exit
    /// status 1, **empty stderr**, and the actual reason only present on stdout. The old
    /// status-first branch reported stderr here, which is what produced the truncated
    /// "claude exited with an error:" the user saw.
    const FAILED_RUN_STDOUT: &str = r#"{"is_error":true,"stop_reason":"stop_sequence",
        "session_id":"8c166654-4807-4d62-a1d7-33909c2efd55","subtype":"success",
        "result":"Failed to authenticate: OAuth session expired and could not be refreshed"}"#;

    #[test]
    fn surfaces_the_reason_json_carries_when_stderr_is_empty() {
        let err = interpret_output(false, "exit status: 1", FAILED_RUN_STDOUT, "").unwrap_err();
        assert_eq!(
            err,
            "Failed to authenticate: OAuth session expired and could not be refreshed"
        );
    }

    /// What `--output-format stream-json --verbose` actually prints: an init event, the
    /// assistant's turn (tool calls included), then the verdict. Only the last one is the run's
    /// result — parsing must skip everything before it rather than choke on the first line.
    const STREAM_JSON_STDOUT: &str = concat!(
        r#"{"type":"system","subtype":"init","session_id":"s-1","model":"claude-opus-4-8"}"#,
        "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"src/App.tsx"}}]},"session_id":"s-1"}"#,
        "\n",
        r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":"fix: guard the null case","modelUsage":{"claude-opus-4-8":{"outputTokens":9}}}"#,
        "\n",
    );

    #[test]
    fn reads_the_verdict_out_of_a_streamed_run() {
        let run = interpret_output(true, "exit status: 0", STREAM_JSON_STDOUT, "").unwrap();
        assert_eq!(run.text, "fix: guard the null case");
        assert_eq!(run.session_id.as_deref(), Some("s-1"));
        assert_eq!(run.model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn a_streamed_failure_reports_its_reason_not_the_exit_status() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"init","session_id":"s-2"}"#,
            "\n",
            r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Unknown model 'nope'"}"#,
            "\n",
        );
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert_eq!(err, "Unknown model 'nope'");
    }

    #[test]
    fn falls_back_to_the_exit_status_when_nothing_explains_the_failure() {
        let err = interpret_output(false, "exit status: 127", "", "").unwrap_err();
        assert_eq!(
            err,
            "claude exited with an error (exit status: 127): sin salida en stdout ni stderr"
        );
    }

    #[test]
    fn a_quota_failure_still_gets_the_marker_the_frontend_looks_for() {
        let stdout = r#"{"is_error":true,"result":"Claude usage limit reached, resets at 5pm"}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    /// The run behind a "usage limit" banner over a commit message, trimmed from a real `claude -p
    /// … --model claude-haiku-4-5-20251001 --output-format stream-json --verbose` on 2.1.266: the
    /// plan window `allowed`, a clean result, 547 tokens generated — and a message that is about
    /// rate limiting, because the diff was. That is an answer, not the provider saying no.
    #[test]
    fn a_generated_commit_message_about_rate_limiting_is_not_a_refusal() {
        let stdout = concat!(
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"feat: add rate limiting and idempotency to order creation","usage":{"input_tokens":9,"output_tokens":547},"modelUsage":{"claude-haiku-4-5-20251001":{}}}"#,
            "\n",
        );
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.text, "feat: add rate limiting and idempotency to order creation");
    }

    /// And the counts only ever clear an answer: a clean exit that generated nothing and says
    /// "limit reached" is still the refusal older CLIs reported that way.
    #[test]
    fn a_clean_exit_that_generated_nothing_can_still_be_a_refusal() {
        let stdout = r#"{"type":"result","is_error":false,"result":"Claude AI usage limit reached|1751234567","usage":{"input_tokens":0,"output_tokens":0}}"#;
        let err = interpret_output(true, "exit status: 0", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    /// Claude Code's real refusals — synthetic messages, zero tokens, `is_error: true` — in the
    /// wordings the CLI actually uses. None of them matched the old vocabulary, so a session limit
    /// reached the user as a raw red error. The provider's own words must survive intact: "resets
    /// 12am" is the one fact the user needs.
    #[test]
    fn claude_codes_own_limit_wordings_are_quota_refusals() {
        for text in [
            "You've hit your session limit · resets 12am (America/Santiago)",
            "You've hit your weekly limit · resets Mon 9am",
            "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage",
            "You're out of usage credits",
            "Your org is out of usage · ask your admin",
            "You\u{2019}ve reached your usage limit",
        ] {
            let stdout = format!(
                r#"{{"type":"result","subtype":"success","is_error":true,"result":"{text}","usage":{{"input_tokens":0,"output_tokens":0}}}}"#
            );
            let err = interpret_output(false, "exit status: 1", &stdout, "").unwrap_err();
            assert_eq!(err, format!("{QUOTA_MARKER}{text}"), "not recognised: {text}");
        }
    }

    /// The token-evidence rule holds for the new wordings too: an answer the model generated is an
    /// answer, even when it happens to open like a refusal.
    #[test]
    fn a_generated_answer_that_sounds_like_a_limit_is_still_an_answer() {
        let stdout = r#"{"type":"result","is_error":false,"result":"You've hit your session limit for this cache, so evict first.","usage":{"input_tokens":9,"output_tokens":31}}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert!(run.text.starts_with("You've hit your session limit"));
    }

    /// Ordinary English that shares an opening is not a limit, even on the failed path.
    #[test]
    fn an_opening_without_a_limit_is_just_an_error() {
        let stdout = r#"{"is_error":true,"result":"You've hit your stride; the build failed for another reason"}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(!err.starts_with(QUOTA_MARKER), "got {err}");
    }

    /// Read-only is a limit the CLI enforces: the tools that exist, and no MCP server — and never
    /// the edit auto-approval, whatever else the invocation says.
    #[test]
    fn a_read_only_run_is_limited_by_the_cli_itself() {
        let tools = ClaudeEngine.read_only_tools();
        let mut inv = AiInvocation::new("¿qué hace esto?", "");
        inv.allowed_tools = &tools;
        inv.read_only = true;
        inv.auto_approve_edits = true;
        let args = command_args(&ClaudeEngine.build_command("claude", &inv));
        assert!(args.windows(2).any(|pair| pair == ["--tools", "Read,Grep,Glob,WebFetch,WebSearch"]), "{args:?}");
        assert!(args.iter().any(|a| a == "--strict-mcp-config"), "{args:?}");
        assert!(!args.iter().any(|a| a == "acceptEdits"), "{args:?}");

        // An ordinary run is untouched by any of it.
        let plain = command_args(&ClaudeEngine.build_command("claude", &AiInvocation::new("hola", "")));
        assert!(!plain.iter().any(|a| a == "--tools" || a == "--strict-mcp-config"), "{plain:?}");
    }

    /// The repository map is the one server a read-only run still loads — read-only itself, and
    /// pre-approved so `-p` does not deny it. A user's server stays out.
    #[test]
    fn a_read_only_run_keeps_the_repository_map_and_nothing_else() {
        let server = |name: &str| crate::mcp_registry::LiveServer {
            name: name.to_string(),
            transport: "http".into(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            url: "http://127.0.0.1:47811/mcp/code".into(),
            headers: vec![("Authorization".into(), "Bearer t".into())],
        };
        let mut inv = AiInvocation::new("¿quién usa esto?", "");
        inv.read_only = true;
        inv.app_mcp = vec![server(crate::codemap::mcp::SERVER_NAME), server("trello")];
        let args = command_args(&ClaudeEngine.build_command("claude", &inv));
        let at = args.iter().position(|a| a == "--mcp-config").expect("the map's config");
        let config = std::fs::read_to_string(&args[at + 1]).unwrap();
        assert!(config.contains("codeflow_map") && !config.contains("trello"), "{config}");
        assert!(args.windows(2).any(|pair| pair[0] == "--allowedTools" && pair[1].contains("mcp__codeflow_map")), "{args:?}");
        assert!(args.iter().any(|a| a == "--strict-mcp-config"));
    }

    /// A text-only run carries nothing of the agent: no tools, no servers (not even the ones the app
    /// would hand it), no skills, no hooks, and its own system prompt in place of Claude Code's.
    #[test]
    fn a_text_only_run_loads_nothing_but_its_own_prompt() {
        let server = crate::mcp_registry::LiveServer {
            name: crate::codemap::mcp::SERVER_NAME.to_string(),
            transport: "http".into(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            url: "http://127.0.0.1:47811/mcp/code".into(),
            headers: Vec::new(),
        };
        let mut inv = AiInvocation::new("Escribe un título", "la pregunta");
        inv.text_only = true;
        inv.read_only = true;
        inv.app_mcp = vec![server];
        inv.mcp_block = vec!["trello".into()];
        inv.system_prompt = Some("Eres quien titula.");
        inv.json_schema = Some(r#"{"type":"object"}"#);
        let args = command_args(&ClaudeEngine.build_command("claude", &inv));
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]), "{args:?}");
        for flag in ["--strict-mcp-config", "--disable-slash-commands", "--json-schema"] {
            assert!(args.iter().any(|a| a == flag), "{flag}: {args:?}");
        }
        for flag in ["--mcp-config", "--disallowedTools", "--allowedTools", "--append-system-prompt-file", "--append-system-prompt"] {
            assert!(!args.iter().any(|a| a == flag), "{flag}: {args:?}");
        }
        assert_eq!(args.iter().filter(|a| *a == "--tools").count(), 1, "read-only adds no second list: {args:?}");
        let at = args.iter().position(|a| a == "--system-prompt-file").expect("its own prompt, replacing");
        assert_eq!(std::fs::read_to_string(&args[at + 1]).unwrap(), "Eres quien titula.");
        let at = args.iter().position(|a| a == "--settings").expect("run settings");
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[at + 1]).unwrap()).unwrap();
        assert_eq!(settings["disableAllHooks"], true);

        // A task with no system prompt of its own still replaces Claude Code's, with the neutral one.
        let mut bare = AiInvocation::new("Escribe un título", "la pregunta");
        bare.text_only = true;
        let args = command_args(&ClaudeEngine.build_command("claude", &bare));
        let at = args.iter().position(|a| a == "--system-prompt-file").expect("a prompt file");
        assert_eq!(std::fs::read_to_string(&args[at + 1]).unwrap(), TEXT_ONLY_SYSTEM_PROMPT);
    }

    /// Plugins a chat keeps out are switched off for the run alone, and nothing else changes; an
    /// ordinary run adds no settings at all.
    #[test]
    fn plugins_kept_out_are_switched_off_for_the_run() {
        let mut inv = AiInvocation::new("hola", "");
        inv.disabled_plugins = vec!["vercel@claude-plugins-official".into(), "design@synced".into()];
        let args = command_args(&ClaudeEngine.build_command("claude", &inv));
        let at = args.iter().position(|a| a == "--settings").expect("run settings");
        let settings: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&args[at + 1]).unwrap()).unwrap();
        assert_eq!(settings, serde_json::json!({"enabledPlugins": {"vercel@claude-plugins-official": false, "design@synced": false}}));
        assert!(!args.iter().any(|a| a == "--tools" || a == "--disable-slash-commands"), "{args:?}");

        let plain = command_args(&ClaudeEngine.build_command("claude", &AiInvocation::new("hola", "")));
        assert!(!plain.iter().any(|a| a == "--settings"), "{plain:?}");
    }

    /// A plugin a chat kept out is missing from that run's report by choice: it is remembered as
    /// off, so Settings can still offer it, and comes back once a run loads it again.
    #[test]
    fn a_plugin_kept_out_is_remembered_not_forgotten() {
        let account = format!("test-plugins-{}", uuid::Uuid::new_v4().simple());
        let both = r#"{"type":"system","subtype":"init","tools":["Edit"],"plugins":[{"name":"vercel","path":"/p/v","source":"vercel@official"},{"name":"warp","path":"/p/w","source":"warp@warp"}]}"#;
        let warp_only = r#"{"type":"system","subtype":"init","tools":["Edit"],"plugins":[{"name":"warp","path":"/p/w","source":"warp@warp"}]}"#;
        let ids = |plugins: &[PluginRef]| plugins.iter().map(|p| p.source.clone()).collect::<Vec<_>>();

        record_install_from_run(&account, None, both, &[]);
        record_install_from_run(&account, None, warp_only, &["vercel@official".to_string()]);
        let report = install_report(&account).unwrap();
        assert_eq!(ids(&report.plugins), vec!["warp@warp"]);
        assert_eq!(ids(&report.plugins_off), vec!["vercel@official"]);

        // Still off on the next turn, though that run's report never mentioned it.
        record_install_from_run(&account, None, warp_only, &["vercel@official".to_string()]);
        assert_eq!(ids(&install_report(&account).unwrap().plugins_off), vec!["vercel@official"]);

        record_install_from_run(&account, None, both, &[]);
        let report = install_report(&account).unwrap();
        assert_eq!(ids(&report.plugins), vec!["vercel@official", "warp@warp"]);
        assert!(report.plugins_off.is_empty());
    }

    /// Settings lists what the user installed — reported or only enabled in `settings.json` — and
    /// never the plugins built into the CLI; an old report without ids is matched by name.
    #[test]
    fn the_plugin_list_is_what_the_user_installed() {
        let plugin = |name: &str, source: &str| PluginRef { name: name.into(), path: "/p".into(), source: source.into() };
        let reported = vec![
            plugin("vercel", ""),
            plugin("design", "design@synced"),
            plugin("cc-plugin-telemetry", "cc-plugin-telemetry@builtin"),
        ];
        let settings = r#"{"enabledPlugins":{"vercel@claude-plugins-official":true,"warp@claude-code-warp":true,"old@x":false}}"#;
        let list = plugin_list(reported, Some(settings), &["design@synced".to_string()]);
        let rows: Vec<(&str, bool)> = list.iter().map(|p| (p.id.as_str(), p.off)).collect();
        assert_eq!(
            rows,
            vec![("design@synced", true), ("vercel@claude-plugins-official", false), ("warp@claude-code-warp", false)]
        );
    }

    #[test]
    fn plugin_ids_are_read_leniently() {
        assert_eq!(parse_plugin_ids(r#"["vercel@claude-plugins-official", " design@synced ", "junk"]"#), vec![
            "vercel@claude-plugins-official".to_string(),
            "design@synced".to_string()
        ]);
        assert!(parse_plugin_ids("not json").is_empty());
    }

    /// A failed run that spent tokens says so on its `result` event, and the meter now reads it.
    #[test]
    fn a_failed_run_still_reports_what_it_spent() {
        let stdout = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","usage":{"input_tokens":1200,"output_tokens":80},"total_cost_usd":0.02}"#;
        let usage = ClaudeEngine.reported_usage(stdout, "").expect("reported");
        assert_eq!((usage.input_tokens, usage.output_tokens), (1200, 80));
        assert_eq!(usage.cost_usd, Some(0.02));
        // A refusal reported zeros, which is nothing to record.
        let refusal = r#"{"type":"result","is_error":true,"result":"You've hit your session limit","usage":{"input_tokens":0,"output_tokens":0}}"#;
        assert!(ClaudeEngine.reported_usage(refusal, "").is_none());
    }

    /// The system prompt file is private and goes with the run.
    #[test]
    fn the_system_prompt_file_lives_as_long_as_the_invocation() {
        let mut inv = AiInvocation::new("hola", "");
        inv.system_prompt = Some("line one\nline two");
        let args = command_args(&ClaudeEngine.build_command("claude", &inv));
        let at = args.iter().position(|a| a == "--append-system-prompt-file").expect("a file");
        let path = std::path::PathBuf::from(&args[at + 1]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "line one\nline two");
        drop(inv);
        assert!(!path.exists(), "deleted with the invocation");
    }

    #[test]
    fn a_successful_run_still_returns_the_reply_and_session_id() {
        let stdout = r#"{"is_error":false,"session_id":"abc-123","result":"  feat: add thing  "}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id.as_deref(), Some("abc-123"));
    }

    #[test]
    fn non_json_stdout_on_a_clean_exit_is_passed_through() {
        let run = interpret_output(true, "exit status: 0", "plain text\n", "").unwrap();
        assert_eq!(run.text, "plain text");
        assert_eq!(run.session_id, None);
        assert_eq!(run.model, None);
    }

    /// `claude -p /compact --resume … --output-format stream-json --verbose` on 2.1.266, trimmed:
    /// the session's hooks, a `compacting` status for as long as the summary takes, the boundary,
    /// the replayed summary — and a clean verdict whose `result` is empty. That empty string sent
    /// the whole stream back to the repository chat as the answer.
    #[test]
    fn a_compaction_answers_with_nothing_rather_than_its_event_stream() {
        let stdout = [
            r#"{"type":"system","subtype":"hook_started","hook_id":"4f4a0a8d","hook_name":"SessionStart:resume","hook_event":"SessionStart","session_id":"cf5e83bd"}"#,
            r#"{"type":"system","subtype":"hook_response","hook_id":"4f4a0a8d","hook_name":"SessionStart:resume","hook_event":"SessionStart","output":"","stdout":"","session_id":"cf5e83bd"}"#,
            r#"{"type":"system","subtype":"status","status":"compacting","session_id":"cf5e83bd"}"#,
            r#"{"type":"system","subtype":"status","status":"compacting","session_id":"cf5e83bd"}"#,
            r#"{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"cf5e83bd"}"#,
            r#"{"type":"system","subtype":"init","session_id":"cf5e83bd","model":"claude-opus-4-8","tools":["Read"]}"#,
            r#"{"type":"system","subtype":"compact_boundary","session_id":"cf5e83bd","compact_metadata":{"trigger":"manual","pre_tokens":152000,"post_tokens":9100}}"#,
            r#"{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation."},"session_id":"cf5e83bd","isReplay":true}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Compacted </local-command-stdout>"},"session_id":"cf5e83bd","isReplay":true}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":"","session_id":"cf5e83bd","usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{"claude-opus-4-8":{"inputTokens":152000,"outputTokens":2400}}}"#,
        ]
        .join("\n");
        let run = interpret_output(true, "exit status: 0", &stdout, "").unwrap();
        assert_eq!(run.text, "");
        assert_eq!(run.session_id.as_deref(), Some("cf5e83bd"), "the compacted session goes on");
        assert_eq!(run.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// `/clear` is the same shape, and the session it hands on is the *new* one the verdict names —
    /// resuming the old id would quietly bring back everything that was just cleared.
    #[test]
    fn a_clear_hands_on_the_new_session() {
        let stdout = [
            r#"{"type":"conversation_reset","new_conversation_id":"0b71bc5b","session_id":"9eeb7d1d"}"#,
            r#"{"type":"system","subtype":"init","session_id":"ce0f1835"}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":"","session_id":"ce0f1835"}"#,
        ]
        .join("\n");
        let run = interpret_output(true, "exit status: 0", &stdout, "").unwrap();
        assert_eq!(run.text, "");
        assert_eq!(run.session_id.as_deref(), Some("ce0f1835"));
    }

    #[test]
    fn a_failure_with_no_reason_reports_the_status_and_not_the_stream() {
        let stdout = [
            r#"{"type":"system","subtype":"init","session_id":"s-3"}"#,
            r#"{"type":"system","subtype":"status","status":"compacting","session_id":"s-3"}"#,
        ]
        .join("\n");
        let err = interpret_output(false, "exit status: 1", &stdout, "").unwrap_err();
        assert_eq!(err, "claude exited with an error (exit status: 1): sin salida en stdout ni stderr");
    }

    /// A stream cut off before its verdict keeps the answer it had already written, and is an error
    /// when it had written none — never its own events read back as prose.
    #[test]
    fn a_stream_without_a_verdict_is_read_for_its_last_answer_only() {
        let answered = [
            r#"{"type":"system","subtype":"init","session_id":"s-4"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Listo, revisé el archivo."}]},"session_id":"s-4"}"#,
        ]
        .join("\n");
        assert_eq!(interpret_output(true, "exit status: 0", &answered, "").unwrap().text, "Listo, revisé el archivo.");

        let silent = r#"{"type":"system","subtype":"init","session_id":"s-5"}"#;
        assert_eq!(interpret_output(true, "exit status: 0", silent, "").unwrap_err(), "claude produced no output");
    }

    /// The whole point of reading `modelUsage`: with no `--model` passed the CLI picks its own
    /// model, and this is the only place the run says which one it actually was.
    #[test]
    fn reports_the_model_the_cli_actually_ran() {
        let stdout = r#"{"result":"ok","modelUsage":{"claude-opus-4-8":{"outputTokens":12}}}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model.as_deref(), Some("claude-opus-4-8"));
    }

    /// A turn that fanned out across models has no single honest answer, so it reports none
    /// and the UI falls back to whatever is configured.
    #[test]
    fn stays_silent_when_more_than_one_model_ran() {
        let stdout =
            r#"{"result":"ok","modelUsage":{"claude-opus-4-8":{},"claude-haiku-4-5-20251001":{}}}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model, None);
    }

    /// The rule has to be the CLI's own spelling or it allows nothing, silently.
    #[test]
    fn an_mcp_rule_names_the_server_the_way_claude_does() {
        assert_eq!(mcp_rule("trello"), "mcp__trello");
        assert_eq!(mcp_rule("my.server name"), "mcp__my_server_name");
        assert_eq!(mcp_rule("claude.ai Gmail"), "mcp__claude_ai_Gmail");
        assert_eq!(mcp_rule("claude.ai Google Drive"), "mcp__claude_ai_Google_Drive");
    }

    /// Kept-out servers are denied by rule; a read-only run loads none, so it says nothing.
    #[test]
    fn blocked_servers_are_denied_and_read_only_runs_leave_them_alone() {
        let mut inv = AiInvocation::new("hola", "");
        inv.mcp_block = vec!["trello".into(), "claude.ai Gmail".into()];
        let args: Vec<String> = ClaudeEngine
            .build_command("claude", &inv)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let at = args.iter().position(|a| a == "--disallowedTools").expect("denied");
        assert_eq!(args[at + 1], "mcp__trello,mcp__claude_ai_Gmail");
        inv.read_only = true;
        let args: Vec<String> = ClaudeEngine
            .build_command("claude", &inv)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(!args.iter().any(|a| a == "--disallowedTools"), "{args:?}");
    }

    /// The window a run states replaces the family table's guess for that model.
    #[test]
    fn the_window_a_run_reports_is_what_the_gauge_measures_against() {
        let model = "claude-sonnet-4-6-cf-reported-window-test";
        let stdout = format!(
            r#"{{"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{{"{model}":{{"outputTokens":3,"contextWindow":200000,"maxOutputTokens":64000}}}}}}"#
        );
        assert_eq!(crate::ai::context_window_for(model), Some(1_000_000), "the family table first");
        record_run_meta(&stdout);
        assert_eq!(crate::ai::context_window_for(model), Some(200_000), "then the CLI's own word");
    }

    /// Older/edge payloads simply omit the field — that must not break parsing.
    #[test]
    fn a_missing_model_usage_field_is_not_an_error() {
        let stdout = r#"{"result":"ok","session_id":"s1"}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.model, None);
        assert_eq!(run.text, "ok");
    }

    /// Verbatim from `claude -p "say ok" --model haiku --output-format stream-json --verbose
    /// --include-partial-messages` on 2.1.266, trimmed to the frames this module reads. Note the
    /// order: index 0 is a *thinking* block and its two deltas arrive before index 1 says a single
    /// word of the answer.
    const TEXT_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"one"}}}"#;
    const THINKING_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weighing it up","estimated_tokens":null}}}"#;
    const SIGNATURE_DELTA: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqsDCrIBCBEYAipAEFo9Brtx9J255x9KjthY"}}}"#;

    #[test]
    fn a_text_delta_becomes_one_chunk_of_the_reply() {
        assert_eq!(
            parse_delta_line(TEXT_DELTA),
            vec![AiDelta { kind: AiDeltaKind::Text, text: "one".to_string() }]
        );
    }

    /// Routed to the reasoning channel, not the answer's. Merging the two is irreversible: once
    /// concatenated, nothing in the text says where the thinking stopped.
    #[test]
    fn a_thinking_delta_goes_to_the_reasoning_channel() {
        assert_eq!(
            parse_delta_line(THINKING_DELTA),
            vec![AiDelta { kind: AiDeltaKind::Thinking, text: "weighing it up".to_string() }]
        );
    }

    /// Hundreds of characters of base64 attestation, in the same envelope as real text. Appending
    /// it to either channel would dump a wall of it into the middle of a sentence.
    #[test]
    fn a_signature_delta_is_dropped() {
        assert!(parse_delta_line(SIGNATURE_DELTA).is_empty());
    }

    /// The same stream carries block starts/stops and message envelopes. They are partial-message
    /// frames — the pump keeps them out of the trace ring — but they are not text.
    /// The meter's number is the **last** prompt, not the sum of every prompt in the turn.
    ///
    /// This is the one that would ship wrong and look right: both numbers are "tokens the engine
    /// reported", both grow over a conversation, and the cumulative one is what the `result` event
    /// hands you if you ask it for usage. The difference only shows on an agentic turn — where the
    /// sum is several times the context — which is exactly the turn where a gauge reading 98% on a
    /// twelve-message conversation sends the user off to compact something that was never full.
    #[test]
    fn the_context_figure_is_the_final_prompt_and_not_the_turn_total() {
        // Two steps: the model reads a file, then answers. Each assistant event carries the usage
        // of its own API call, and the `result` event carries the sum.
        let stdout = concat!(
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":8000,"cache_creation_input_tokens":0,"output_tokens":90}},"session_id":"s-1"}"#,
            "\n",
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"…"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"usage":{"input_tokens":40,"cache_read_input_tokens":8000,"cache_creation_input_tokens":1200,"output_tokens":300}},"session_id":"s-1"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","result":"listo","session_id":"s-1","usage":{"input_tokens":50,"cache_read_input_tokens":16000,"cache_creation_input_tokens":1200,"output_tokens":390}}"#,
        );

        // The last step: 40 + 8000 + 1200. The turn total would be 17 250 — more than twice as
        // much, and rising with every tool call rather than with the conversation.
        assert_eq!(last_step_context(stdout), Some(9_240));
    }

    /// Cache hits count. They are the cheap tokens on a bill and ordinary ones in a window.
    #[test]
    fn tokens_served_from_cache_still_occupy_the_window() {
        let cached = r#"{"type":"assistant","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":54000,"output_tokens":120}}}"#;
        assert_eq!(last_step_context(cached), Some(54_003));
    }

    /// A run with nothing to measure says so, rather than reporting zero.
    ///
    /// Zero and "unknown" are drawn differently by the meter — one is an empty gauge, the other
    /// falls back to estimating — so collapsing them here would show a thirty-turn conversation as
    /// carrying nothing the first time an output format changed.
    #[test]
    fn a_run_that_reported_no_usage_measures_nothing() {
        assert_eq!(last_step_context(""), None);
        assert_eq!(last_step_context("not json at all\nnor this"), None);
        // An assistant event with a usage block full of zeros is the same non-answer.
        assert_eq!(
            last_step_context(r#"{"type":"assistant","message":{"usage":{"input_tokens":0}}}"#),
            None,
        );
        // And the result event's own total is deliberately *not* read as a fallback: a number
        // that means something else is not a worse version of this one, it is a different one.
        assert_eq!(
            last_step_context(r#"{"type":"result","usage":{"input_tokens":900,"cache_read_input_tokens":12000}}"#),
            None,
        );
    }

    /// `/context` on a resumed session, as 2.1.305 prints it: a synthetic message, zero tokens, and
    /// the cost of the turns before it. Nothing of that was spent by this run.
    #[test]
    fn a_command_the_cli_answered_itself_costs_nothing() {
        let stdout = concat!(
            r#"{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Context Usage"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Context Usage","num_turns":0,"local_command":"context","session_id":"s1","total_cost_usd":0.0051,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},"modelUsage":{"claude-haiku-5-5":{"inputTokens":4,"outputTokens":37,"costUSD":0.0051}}}"#,
        );
        let run = interpret_output(true, "exit 0", stdout, "").unwrap();
        assert_eq!(run.text, "Context Usage");
        assert!(run.usage.is_none());
        // And it measured nothing either: the meter keeps the figure from before (`leavesContextAsIs`).
        assert_eq!(run.context_tokens, None);
    }

    /// The session and its running total, from the verdict — what the meter turns into the run's
    /// own cost. A verdict without either has nothing to offer.
    #[test]
    fn a_verdict_names_its_session_and_running_cost() {
        let engine = ClaudeEngine;
        let stdout = r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","total_cost_usd":0.0051,"usage":{"input_tokens":2,"output_tokens":4}}"#;
        assert_eq!(engine.session_cost(stdout), Some(("s1".to_string(), 0.0051)));
        assert_eq!(engine.session_cost(r#"{"type":"result","result":"ok","session_id":"s1"}"#), None);
        assert_eq!(engine.session_cost(""), None);
    }

    /// `modelUsage` lists every model the *session* used, so a chat that switched model mid-way
    /// named none. The run's last main-thread step says which one answered — not a subagent's, and
    /// not the CLI's own `<synthetic>` reply.
    #[test]
    fn the_model_is_the_one_that_took_the_last_step() {
        let stdout = concat!(
            r#"{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-opus-5-5","content":[],"usage":{"input_tokens":10}}}"#,
            "\n",
            r#"{"type":"assistant","parent_tool_use_id":"toolu_1","message":{"model":"claude-haiku-5-5","content":[],"usage":{"input_tokens":10}}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1","usage":{"input_tokens":20,"output_tokens":5},"modelUsage":{"claude-sonnet-5-5":{"inputTokens":9},"claude-opus-5-5":{"inputTokens":20}}}"#,
        );
        assert_eq!(interpret_output(true, "exit 0", stdout, "").unwrap().model.as_deref(), Some("claude-opus-5-5"));
        // A command the CLI answered itself falls back to the one model the session used.
        let command = concat!(
            r#"{"type":"assistant","message":{"model":"<synthetic>","content":[],"usage":{"input_tokens":0}}}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Context Usage","session_id":"s1","usage":{"input_tokens":0},"modelUsage":{"claude-haiku-5-5":{"inputTokens":4}}}"#,
        );
        assert_eq!(interpret_output(true, "exit 0", command, "").unwrap().model.as_deref(), Some("claude-haiku-5-5"));
    }

    #[test]
    fn a_stream_event_that_is_not_a_delta_yields_nothing() {
        let starts = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}"#;
        assert!(parse_delta_line(starts).is_empty());
        let stops = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
        assert!(parse_delta_line(stops).is_empty());
    }

    /// A truncated line is normal, not exceptional: the pump splits on newlines and a CLI can be
    /// killed mid-write. It must cost the turn its typing, never the run.
    #[test]
    fn malformed_json_never_panics() {
        assert!(parse_delta_line(r#"{"type":"stream_event","event":{"type":"content_bl"#).is_empty());
        assert!(parse_delta_line("{}").is_empty());
        assert!(parse_delta_line(r#"{"type":"stream_event"}"#).is_empty());
    }

    #[test]
    fn a_plain_text_line_is_not_a_delta() {
        assert!(parse_delta_line("Loading the model…").is_empty());
        assert!(parse_delta_line("").is_empty());
    }

    /// Verbatim from the same run. `utilization` is a fraction; this module reports percent.
    const RATE_LIMIT_LINE: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789700400,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.31,"resetsAt":1789700400},"seven_day":{"utilization":0.53,"resetsAt":1790010000}}},"uuid":"f8d76120","session_id":"6f6c67f1"}"#;

    #[test]
    fn reads_both_plan_windows_off_the_run_that_spent_them() {
        let limit = parse_rate_limit(RATE_LIMIT_LINE).expect("a rate limit event");
        assert!((limit.five_hour_pct - 31.0).abs() < 0.001, "got {limit:?}");
        assert!((limit.seven_day_pct - 53.0).abs() < 0.001, "got {limit:?}");
    }

    /// What is kept between launches reads back as it was written, per account.
    #[test]
    fn the_windows_kept_between_launches_read_back() {
        let limit = AiRateLimit { five_hour_pct: 12.0, five_hour_resets_at: 1_792_542_600, seven_day_pct: 40.0, seven_day_resets_at: 1_793_000_000 };
        let stored = serde_json::to_string(&StoredRateLimit { limit, at: "2026-10-20T22:00:00+00:00".into() }).unwrap();
        let back: StoredRateLimit = serde_json::from_str(&stored).unwrap();
        assert_eq!((back.limit, back.at.as_str()), (limit, "2026-10-20T22:00:00+00:00"));
        assert_ne!(stored_rate_limit_key("claude"), stored_rate_limit_key("claude|work"));
    }

    /// An event may name only the session (2.1.304, 2026-10-20). The week it leaves out is "not
    /// reported" — a `0` reset — and a later run that names only the session keeps the week an
    /// earlier one reported, until that week rolls over.
    #[test]
    fn a_window_an_event_leaves_out_is_not_reported_as_zero() {
        let only_session = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.03,"resetsAt":1792542600}}}}"#;
        let limit = parse_rate_limit(only_session).unwrap();
        assert!((limit.five_hour_pct - 3.0).abs() < 0.001 && limit.seven_day_resets_at == 0, "{limit:?}");

        // Two events in one run: the second's silence about the week keeps the first's.
        let limit = parse_rate_limit(&format!("{RATE_LIMIT_LINE}\n{only_session}")).unwrap();
        assert!((limit.seven_day_pct - 53.0).abs() < 0.001 && (limit.five_hour_pct - 3.0).abs() < 0.001, "{limit:?}");

        // Across runs: kept while the week is still open, dropped once it has rolled over.
        let previous = parse_rate_limit(RATE_LIMIT_LINE).unwrap();
        let fresh = parse_rate_limit(only_session).unwrap();
        let merged = merge_rate_limit(Some(&previous), fresh, 1_789_000_000);
        assert_eq!(merged.seven_day_resets_at, 1_790_010_000);
        let merged = merge_rate_limit(Some(&previous), fresh, 1_791_000_000);
        assert_eq!(merged.seven_day_resets_at, 0);
    }

    /// The common case by far: nothing in the log mentions a rate limit, which is "cannot tell"
    /// rather than "zero used".
    #[test]
    fn a_run_without_a_rate_limit_event_reports_nothing() {
        assert!(parse_rate_limit(STREAM_JSON_STDOUT).is_none());
        assert!(parse_rate_limit("not json at all").is_none());
    }

    #[test]
    fn reads_the_slash_commands_this_install_offers() {
        let stdout = format!(
            "{}\n{}\n{RATE_LIMIT_LINE}\n",
            r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#,
            r#"{"type":"system","subtype":"init","session_id":"s-1","model":"claude-haiku-4-5-20251001","slash_commands":["compact","model","deep-research"],"tools":["Read"]}"#,
        );
        let stdout = stdout.as_str();
        assert_eq!(parse_init(stdout).unwrap().slash_commands, vec!["compact", "model", "deep-research"]);
        // …and the same buffer still yields the rate limit, since both scans are independent.
        assert!(parse_rate_limit(stdout).is_some());
    }

    /// The servers the app hands a run (`--mcp-config`, reported as `dynamic`) are not the user's:
    /// filed as theirs, the next turn's plan blocked the repository map it was itself passing.
    #[test]
    fn the_app_s_own_servers_stay_out_of_the_install_report() {
        let account = format!("test-dynamic-{}", uuid::Uuid::new_v4().simple());
        let stdout = r#"{"type":"system","subtype":"init","tools":["Edit","Read"],"mcp_servers":[{"name":"github","status":"connected","source":"user"},{"name":"codeflow_map","status":"connected","source":"dynamic"},{"name":"claude.ai Gmail","status":"pending","source":"claudeai"}]}"#;
        record_install_from_run(&account, None, stdout, &[]);
        let names: Vec<String> = install_report(&account).unwrap().mcp_servers.unwrap().into_iter().map(|server| server.name).collect();
        assert_eq!(names, vec!["github", "claude.ai Gmail"]);
    }

    /// An older CLI, or a run that died before it printed its banner. The menu then shows the
    /// app's own commands alone, which is honest; asserting this install has none is not.
    #[test]
    fn a_run_without_an_init_event_reports_no_commands() {
        assert!(parse_init(STREAM_JSON_STDOUT).is_none_or(|init| init.slash_commands.is_empty()));
        assert!(parse_init("").is_none());
    }

    /// The flag is what turns the event log into one frame per token. Every non-chat flow through
    /// this engine throws those away unread, so it must not be paid for by default.
    #[test]
    fn partial_messages_are_only_asked_for_when_someone_is_streaming() {
        let quiet = AiInvocation::new("write a commit message", "the diff");
        let args = command_args(&ClaudeEngine.build_command("claude", &quiet));
        assert!(!args.iter().any(|a| a == "--include-partial-messages"), "{args:?}");

        let mut streaming = AiInvocation::new("hello", "");
        streaming.stream_deltas = Some(crate::ai::DeltaSink {
            conversation_id: "c-1".to_string(),
            message_id: "m-1".to_string(),
        });
        let args = command_args(&ClaudeEngine.build_command("claude", &streaming));
        assert!(args.iter().any(|a| a == "--include-partial-messages"), "{args:?}");
        // The flag only works alongside these, and this builder is what has to keep passing them.
        assert!(args.iter().any(|a| a == "--verbose"), "{args:?}");
        assert!(args.iter().any(|a| a == "stream-json"), "{args:?}");
    }

    fn command_args(cmd: &Command) -> Vec<String> {
        cmd.as_std().get_args().map(|a| a.to_string_lossy().to_string()).collect()
    }
}
