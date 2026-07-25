//! The Gemini CLI engine — **skeleton**.
//!
//! This targets Google's headless terminal agent driven by a Google-account OAuth login, so it
//! runs against a **Google AI Pro / Ultra subscription** (or the free Code Assist tier) the same
//! way [`crate::claude`] runs against Claude's own CLI login — no API key, no separate billing.
//! The user logs the CLI in once (`gemini`/`agy` auth), and CodeFlow just spawns it.
//!
//! ⚠️ Why "skeleton": the binary name and flags are in flux. Google folded the `gemini` CLI into
//! the Antigravity CLI (`agy`) for consumer/subscription users in mid-2026, and its headless
//! contract (the `--output-format` JSON envelope, session resume, non-TTY stdout behavior)
//! changed with it. Every flag below is the documented shape and is marked `TODO(verify)` where
//! it must be checked against the version actually installed (`gemini --help` / `agy --help`)
//! before this path is relied on. Until then it compiles and is wired end-to-end, but a real run
//! needs that verification pass. See the module notes in `ai.rs` and the design conversation.

use serde::Deserialize;
use tokio::process::Command;

use crate::ai::{quota_signal, AiEngine, AiInvocation, AiRun, QUOTA_MARKER};

/// Fast/cheap Gemini model for mechanical tasks (commit messages) — mirrors Claude using Haiku.
const COMMIT_MESSAGE_MODEL: &str = "gemini-2.5-flash";

/// Default binary. `gemini` is the classic name; on the Antigravity transition this becomes
/// `agy`. The user can always override the exact path in Settings, so this is only the fallback.
const DEFAULT_BINARY: &str = "gemini";

pub struct GeminiEngine;

impl AiEngine for GeminiEngine {
    fn label(&self) -> &'static str {
        "Gemini"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_BINARY
    }

    fn commit_message_model(&self) -> &'static str {
        COMMIT_MESSAGE_MODEL
    }

    fn fix_tools(&self) -> Vec<String> {
        // TODO(verify): Gemini/Antigravity name their built-in tools differently from Claude's
        // `Read/Edit/Write/Grep/Glob`. These are the documented gemini-cli tool names; confirm
        // against the installed CLI before trusting the "fix with AI" write path.
        ["read_file", "write_file", "replace", "glob", "search_file_content"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = Command::new(binary);
        // Headless one-shot: the ask goes as the prompt argument, data on stdin — same division
        // of labor as the Claude path.
        cmd.arg("-p").arg(inv.prompt);

        // TODO(verify): Claude uses `--append-system-prompt`; the Gemini CLI takes system
        // instructions via `--system-prompt` (older builds) — confirm the current flag.
        if let Some(sp) = inv.system_prompt {
            cmd.arg("--system-prompt").arg(sp);
        }

        // Gemini CLI selects the model with `-m` / `--model`.
        if !inv.model.trim().is_empty() {
            cmd.arg("-m").arg(inv.model);
        }

        // Structured output so `interpret_output` can read the reply and classify auth/quota
        // failures. NOTE: the Antigravity CLI reportedly dropped the JSON `--output-format`
        // envelope and has a non-TTY stdout bug — TODO(verify) this still holds on the installed
        // version; `interpret_output` below already falls back to raw stdout if the JSON is gone.
        cmd.arg("--output-format").arg("json");

        // Auto-approve edits: Gemini's equivalent of Claude's `--permission-mode acceptEdits` is
        // an approval-mode / "yolo" flag. TODO(verify) the exact flag + value on the installed CLI.
        if inv.auto_approve_edits {
            cmd.arg("--approval-mode").arg("yolo");
        }

        // TODO(verify): tool allow-listing flag (Claude: `--allowedTools a,b`). Passed as the
        // user's raw, provider-specific tool names (per the per-provider tools design). Left as a
        // documented gap rather than guessing an unverified flag that could error the whole run.
        // if !inv.allowed_tools.is_empty() { cmd.arg("--allowed-tools").arg(inv.allowed_tools.join(",")); }
        let _ = &inv.allowed_tools;

        // TODO(verify): MCP config flag (Claude: `--mcp-config PATH --strict-mcp-config`).
        let _ = &inv.mcp_config_path;

        // TODO(verify): session resume for multi-turn chat (Claude: `--resume ID`). Headless
        // session resume in the Antigravity CLI is still being wired up upstream, so chat may
        // start fresh each turn until this is confirmed.
        let _ = &inv.resume_session_id;

        if let Some(dir) = inv.cwd {
            cmd.current_dir(dir);
        }
        cmd
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }
}

/// The Gemini CLI's `--output-format json` envelope. Tolerant on purpose: the reply key has
/// moved between builds (`response` vs `result` vs `text`), so a few likely keys are tried, and
/// anything unparseable falls through to raw-stdout handling. TODO(verify) the real schema.
#[derive(Deserialize)]
struct GeminiCliResult {
    response: Option<String>,
    result: Option<String>,
    text: Option<String>,
    error: Option<GeminiError>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct GeminiError {
    message: Option<String>,
}

/// Interprets a finished Gemini run — mirrors the Claude interpreter's contract (quota marker,
/// surface-the-reason-on-stdout, exit-status fallback) but against Gemini's JSON shape, and
/// degrades gracefully to raw stdout when the CLI emits no JSON envelope (as the Antigravity CLI
/// reportedly does).
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<AiRun, String> {
    if let Ok(parsed) = serde_json::from_str::<GeminiCliResult>(stdout) {
        if let Some(err) = parsed.error {
            let msg = err.message.unwrap_or_else(|| "Gemini reported an error".to_string());
            if quota_signal(&msg) {
                return Err(format!("{QUOTA_MARKER}{msg}"));
            }
            return Err(msg);
        }

        let text = parsed
            .response
            .or(parsed.result)
            .or(parsed.text)
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty());

        if let Some(text) = text {
            if quota_signal(&text) {
                return Err(format!("{QUOTA_MARKER}{text}"));
            }
            if !success {
                return Err(text);
            }
            return Ok(AiRun { text, session_id: parsed.session_id, model: parsed.model });
        }
    }

    // No JSON envelope we understood — behave like the Claude fallback path.
    if !success {
        if quota_signal(stderr) {
            return Err(format!("{QUOTA_MARKER}{}", stderr.trim()));
        }
        if quota_signal(stdout) {
            return Err(format!("{QUOTA_MARKER}{}", stdout.trim()));
        }
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or("sin salida en stdout ni stderr");
        return Err(format!("gemini exited with an error ({status_label}): {detail}"));
    }

    let fallback = stdout.trim();
    if fallback.is_empty() {
        return Err("gemini produced no output".to_string());
    }
    if quota_signal(fallback) {
        return Err(format!("{QUOTA_MARKER}{fallback}"));
    }
    Ok(AiRun { text: fallback.to_string(), session_id: None, model: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_reply_from_the_response_key() {
        let stdout = r#"{"response":"  feat: add thing  ","session_id":"g-1"}"#;
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id.as_deref(), Some("g-1"));
    }

    #[test]
    fn surfaces_a_structured_error_message() {
        let stdout = r#"{"error":{"message":"Failed to authenticate: login required"}}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert_eq!(err, "Failed to authenticate: login required");
    }

    #[test]
    fn a_quota_error_gets_the_marker() {
        let stdout = r#"{"error":{"message":"Resource exhausted: rate limit reached"}}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn falls_back_to_raw_stdout_when_there_is_no_json_envelope() {
        let run = interpret_output(true, "exit status: 0", "plain reply\n", "").unwrap();
        assert_eq!(run.text, "plain reply");
        assert_eq!(run.model, None);
    }
}
