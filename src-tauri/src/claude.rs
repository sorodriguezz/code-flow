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
//! system prompt goes to a temp file via `--append-system-prompt-file` — verified against the
//! installed CLI (`claude --append-system-prompt-file <path>` reads it; confirmed against 2.1.226).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use tokio::process::Command;

use crate::ai::{
    quota_signal, refusal_reply, AiDelta, AiDeltaKind, AiEngine, AiInvocation, AiRateLimit, AiRun,
    AiUsage, QUOTA_MARKER,
};

/// Commit-message generation always runs on Haiku regardless of the user's configured review
/// model — it's a small, mechanical task that doesn't need a bigger model.
const COMMIT_MESSAGE_MODEL: &str = "claude-haiku-4-5-20251001";

/// Single-line, ASCII, shim-safe stand-in for an ask this engine can't put on the command line as
/// given — mirrors `codex.rs`'s `POINTER`. The real ask rides on stdin instead, ahead of the usual
/// skills note and data.
const PROMPT_POINTER: &str =
    "Your instructions for this turn are in the input provided via stdin. Read all of it and carry it out.";

/// Whether `prompt` is unsafe to hand to `-p` as-is on Windows (see the module docs).
fn needs_stdin_prompt(prompt: &str) -> bool {
    prompt.contains('\n')
}

/// Writes the system prompt to a temp file for `--append-system-prompt-file`, so a multi-paragraph
/// prompt never has to survive the `.cmd` shim as a single argument. `None` on a failed write, so
/// the caller can fall back to passing it inline rather than losing the system prompt outright.
fn write_system_prompt_file(sp: &str) -> Option<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("codeflow-claude-system-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&path, sp).ok()?;
    Some(path)
}

pub struct ClaudeEngine;

impl AiEngine for ClaudeEngine {
    /// The only engine that does: it reads `<cwd>/.claude/skills` itself, so describing them in the
    /// payload would be telling it something it already knows.
    fn reads_claude_skills(&self) -> bool {
        true
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
        if let Some(sp) = inv.system_prompt {
            match write_system_prompt_file(sp) {
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
        if !inv.allowed_tools.is_empty() {
            cmd.arg("--allowedTools").arg(inv.allowed_tools.join(","));
        }
        if inv.auto_approve_edits {
            cmd.arg("--permission-mode").arg("acceptEdits");
        }
        if let Some(id) = inv.resume_session_id {
            cmd.arg("--resume").arg(id);
        }
        if let Some(dir) = inv.cwd {
            cmd.current_dir(dir);
        }
        cmd
    }

    /// Claude's scale is this app's scale — `--effort low|medium|high|xhigh|max`. The two extra
    /// steps it offers above `high` are why the neutral scale tops out at `max` rather than at
    /// `high`: this is the one CLI that would have lost a level to a three-step vocabulary.
    /// Claude Code's read-only set, which is the one this app's `--allowedTools` actually enforces.
    fn read_only_tools(&self) -> Vec<String> {
        ["Read", "Grep", "Glob", "WebFetch", "WebSearch"].iter().map(|s| s.to_string()).collect()
    }


    fn effort_args(&self, effort: &str) -> Vec<String> {
        vec!["--effort".into(), effort.into()]
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

/// What the most recent `claude` run said about itself beyond its answer.
///
/// **Why a cache and not two more fields on [`AiRun`]**: `AiRun` is built with struct literals by
/// all six engines, so a field added to it is a compile error in five files this change does not
/// own. The contract asked for `AiRun.rate_limit` and `AiRun.slash_commands`; this is the closest
/// shape that keeps the tree building, and it is also what the only consumer actually wants — the
/// provider-command menu asks "what does this install support", which is a property of the CLI and
/// not of any one turn, and the quota meter asks "how full am I now".
#[derive(Debug, Clone, Default)]
pub struct ClaudeRunMeta {
    /// How full the plan windows were when the last run finished, if it said. Free here; the same
    /// number costs `ai_quota.rs` a keychain read and an HTTPS call.
    pub rate_limit: Option<AiRateLimit>,
    /// Every slash command this install offers, **as reported — with no leading `/`** (114 of them
    /// on the machine this was verified against, plugins and user commands included). A caller
    /// building a menu row adds the slash.
    pub slash_commands: Vec<String>,
}

fn meta_cell() -> &'static Mutex<ClaudeRunMeta> {
    static META: OnceLock<Mutex<ClaudeRunMeta>> = OnceLock::new();
    META.get_or_init(Mutex::default)
}

/// The last plan windows each **account** reported, with when — keyed by
/// [`crate::ai_accounts::AccountEnv::key`] (`claude` for the system account).
///
/// Kept apart from [`meta_cell`] because the two answer different questions. The command list is
/// a fact about the installed binary, and the latest run of any account is as good as another. The
/// windows are a fact about one account's plan, and reporting the work account's week under the
/// personal one would be a wrong number on the one panel whose only value is being trusted.
fn limits_cell() -> &'static Mutex<std::collections::HashMap<String, (AiRateLimit, String)>> {
    static LIMITS: OnceLock<Mutex<std::collections::HashMap<String, (AiRateLimit, String)>>> = OnceLock::new();
    LIMITS.get_or_init(Mutex::default)
}

/// The most recent run's report. Empty before the first `claude` run of this process, which is a
/// real state and the reason the command menu renders app commands alone until then rather than
/// asserting this install has none.
pub fn last_run_meta() -> ClaudeRunMeta {
    meta_cell().lock().map(|m| m.clone()).unwrap_or_default()
}

/// The plan windows `account_key` last reported and the instant it did, if it has run in this
/// process. What an added account's row in the limits panel is drawn from — this app reads no
/// token for an account it added; the CLI tells it on every run. See `ai_quota::claude`.
pub fn last_rate_limit(account_key: &str) -> Option<(AiRateLimit, String)> {
    limits_cell().lock().ok()?.get(account_key).cloned()
}

/// Files what a finished run reported about itself.
///
/// **Each half is only replaced by a run that actually said something.** A run that failed to
/// launch, or one whose output was cut short, prints neither the init event nor a rate-limit one;
/// letting that overwrite a good answer with an empty one would make the command menu flicker
/// empty on the first failed turn and stay that way.
fn record_run_meta(stdout: &str) {
    let rate_limit = parse_rate_limit(stdout);
    let slash_commands = parse_slash_commands(stdout);
    if let Some(limit) = rate_limit {
        // Filed under the account the run was — `interpret` is called inside `with_account` by an
        // engine bound to one, and outside it for the system account.
        let key = crate::ai_accounts::current().map(|env| env.key()).unwrap_or_else(|| "claude".to_string());
        if let Ok(mut limits) = limits_cell().lock() {
            limits.insert(key, (limit, chrono::Utc::now().to_rfc3339()));
        }
    }
    let Ok(mut meta) = meta_cell().lock() else { return };
    if rate_limit.is_some() {
        meta.rate_limit = rate_limit;
    }
    if !slash_commands.is_empty() {
        meta.slash_commands = slash_commands;
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
/// only one current answer.
fn parse_rate_limit(stdout: &str) -> Option<AiRateLimit> {
    let mut found = None;
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
        found = Some(AiRateLimit {
            five_hour_pct: windows.five_hour.utilization * 100.0,
            seven_day_pct: windows.seven_day.utilization * 100.0,
            five_hour_resets_at: windows.five_hour.resets_at,
            seven_day_resets_at: windows.seven_day.resets_at,
        });
    }
    found
}

/// The `slash_commands` array of the `system`/`init` event — every command this install can
/// expand, including the ones plugins and the user added, which is why it is read from the run
/// instead of curated here.
///
/// The first init wins: a run emits exactly one, and it is the eighth line or so of a stream whose
/// first entries are hook events.
fn parse_slash_commands(stdout: &str) -> Vec<String> {
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') || !line.contains("\"slash_commands\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<InitEvent>(line) else { continue };
        if event.event_type != "system" || event.subtype.as_deref() != Some("init") {
            continue;
        }
        if !event.slash_commands.is_empty() {
            return event.slash_commands;
        }
    }
    Vec::new()
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
    match reported.is_empty() {
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
    let result_text = parsed
        .as_ref()
        .and_then(|p| p.result.as_deref())
        .map(str::trim)
        .filter(|t| !t.is_empty());

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
        let model = parsed.as_ref().and_then(model_used);
        let usage = parsed.as_ref().and_then(usage_of);
        return Ok(AiRun {
            text: text.to_string(),
            session_id: parsed.and_then(|p| p.session_id),
            model,
            usage,
            context_tokens: last_step_context(stdout),
        });
    }

    if !success {
        if quota_signal(stderr) {
            return Err(format!("{QUOTA_MARKER}{}", stderr.trim()));
        }
        if quota_signal(stdout) {
            return Err(format!("{QUOTA_MARKER}{}", stdout.trim()));
        }
        // Neither stream carried a usable message — report the exit status rather than an
        // error string that trails off into nothing.
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("sin salida en stdout ni stderr");
        return Err(format!("claude exited with an error ({status_label}): {detail}"));
    }

    let fallback = stdout.trim();
    if fallback.is_empty() {
        return Err("claude produced no output".to_string());
    }
    if refusal_reply(fallback, None) {
        return Err(format!("{QUOTA_MARKER}{fallback}"));
    }
    Ok(AiRun { text: fallback.to_string(), session_id: None, model: None, usage: None, context_tokens: None })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(parse_slash_commands(stdout), vec!["compact", "model", "deep-research"]);
        // …and the same buffer still yields the rate limit, since both scans are independent.
        assert!(parse_rate_limit(stdout).is_some());
    }

    /// An older CLI, or a run that died before it printed its banner. The menu then shows the
    /// app's own commands alone, which is honest; asserting this install has none is not.
    #[test]
    fn a_run_without_an_init_event_reports_no_commands() {
        assert!(parse_slash_commands(STREAM_JSON_STDOUT).is_empty());
        assert!(parse_slash_commands("").is_empty());
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
