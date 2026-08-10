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
use tokio::process::Command;

use crate::ai::{quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, AiUsage, QUOTA_MARKER};

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

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }
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
        // message that is nothing but the refusal counts. See `refusal_reply`.
        let refused = match failed {
            true => quota_signal(text),
            false => refusal_reply(text),
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
    if refusal_reply(fallback) {
        return Err(format!("{QUOTA_MARKER}{fallback}"));
    }
    Ok(AiRun { text: fallback.to_string(), session_id: None, model: None, usage: None })
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
}
