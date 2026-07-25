//! The opencode CLI engine — **skeleton**.
//!
//! [opencode](https://opencode.ai) is an open-source, provider-agnostic terminal coding agent.
//! Unlike [`crate::claude`]/[`crate::gemini`] it isn't tied to one vendor's login: the user
//! configures whatever providers they want *inside opencode* (Anthropic, OpenAI, local models, …)
//! and CodeFlow just drives its headless `run` subcommand — which is why a model here is addressed
//! as `provider/model` (e.g. `anthropic/claude-sonnet-4-5`) rather than a bare model id.
//!
//! The flags were verified against the installed CLI (`opencode run --help`) and a live free-model
//! run. Three things differ structurally from the Claude engine and shape [`OpenCodeEngine::build_command`]:
//!   1. **No stdin.** `opencode run` does not read piped stdin (unlike `claude -p`).
//!   2. **No `--system-prompt` flag.** System instructions have to travel with the prompt.
//!   3. **Windows `.cmd` shim can't take newline args.** When opencode is installed via npm the
//!      binary is `opencode.cmd`, which `std::process` runs through `cmd.exe` — and cmd.exe rejects
//!      any argument containing a newline ("batch file arguments are invalid"). Our system prompts
//!      and review templates are multi-line, and the diff can exceed argv length limits anyway.
//!
//! So instead of passing the prompt as argv, we write the **entire** prompt (system + ask + data)
//! to a temp file, attach it with `--file`, and pass only a short, single-line, ASCII pointer
//! message. That sidesteps all three constraints at once. Verified: opencode feeds `--file` content
//! to the model, and the message must precede `--file` (a variadic flag that would otherwise eat
//! it). What's still worth a real end-to-end check per flow: the `--continue` session semantics and
//! that structured-output tasks (review/commit) follow the attached instructions as faithfully as
//! they did on the native `-p` path. Temp files aren't cleaned up yet.

use tokio::process::Command;

use crate::ai::{quota_signal, AiEngine, AiInvocation, AiRun, QUOTA_MARKER};

/// opencode addresses models as `provider/model`; leaving the commit model empty lets opencode use
/// whatever default the user configured instead of forcing a provider they might not have set up.
const COMMIT_MESSAGE_MODEL: &str = "";

const DEFAULT_BINARY: &str = "opencode";

/// Sentinel handed back as the "session id" on every successful run. opencode resumes its most
/// recent session with `--continue` (no id needed), so rather than parse the JSON event stream for
/// the real id (TODO(verify)) we return a non-empty marker — that keeps the app's multi-turn chat
/// state at "there is a session", so the next turn passes a resume id, which [`build_command`] maps
/// to `--continue`. TODO(verify): capture the real session id via `--format json` and switch to
/// `--session <id>` so interleaved reviews/chats can't resume each other's session.
const SESSION_SENTINEL: &str = "opencode-last";

pub struct OpenCodeEngine;

impl AiEngine for OpenCodeEngine {
    fn label(&self) -> &'static str {
        "opencode"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_BINARY
    }

    fn commit_message_model(&self) -> &'static str {
        COMMIT_MESSAGE_MODEL
    }

    fn fix_tools(&self) -> Vec<String> {
        // opencode's built-in tool names. NOTE: `opencode run` has no tool-allowlist flag (see
        // build_command), so these aren't passed today — write access comes from `--auto`. Kept
        // for parity/documentation. TODO(verify).
        ["read", "edit", "write", "bash", "grep", "glob"].iter().map(|s| s.to_string()).collect()
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = Command::new(binary);
        cmd.arg("run");

        // Everything textual — system instructions, the ask, and the data payload — goes into one
        // attached file (see the module docs for why: no stdin, no `--system-prompt`, and Windows
        // `.cmd` shims reject newline args). Order: system → ask → data, so the ask reads as the
        // primary instruction and the data as its input.
        let mut brief = String::new();
        if let Some(sp) = inv.system_prompt {
            if !sp.trim().is_empty() {
                brief.push_str(sp);
                brief.push_str("\n\n");
            }
        }
        brief.push_str(inv.prompt);
        if !inv.stdin_content.trim().is_empty() {
            brief.push_str("\n\n----- INPUT -----\n\n");
            brief.push_str(inv.stdin_content);
        }

        // Short, single-line, ASCII pointer message — safe through the `.cmd`/cmd.exe layer. MUST
        // come before `--file` (a variadic array flag that would otherwise swallow it as a path).
        cmd.arg(
            "The attached file contains your full instructions and the input to work on. \
             Follow them exactly and reply with only the requested output.",
        );

        // Model as `provider/model`; empty means "use opencode's configured default".
        if !inv.model.trim().is_empty() {
            cmd.arg("--model").arg(inv.model);
        }
        // Auto-approve edits (Claude's `--permission-mode acceptEdits`). Headless runs can't answer
        // an interactive permission prompt, so the write flows (chat, "fix with AI") set this.
        if inv.auto_approve_edits {
            cmd.arg("--auto");
        }
        if let Some(dir) = inv.cwd {
            cmd.arg("--dir").arg(dir);
        }
        // Multi-turn chat: resume opencode's last session. TODO(verify) `--session <id>` once the
        // real id is captured (see SESSION_SENTINEL).
        if inv.resume_session_id.is_some() {
            cmd.arg("--continue");
        }
        // `--file` last so the message positional above can't be mistaken for another attachment.
        if let Some(path) = write_payload_file(&brief) {
            cmd.arg("--file").arg(path);
        }
        cmd
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }

    fn list_models_args(&self) -> Option<Vec<String>> {
        // `opencode models` prints every `provider/model` the user has configured, one per line —
        // exactly the shape [`crate::ai::list_models`] expects.
        Some(vec!["models".to_string()])
    }
}

/// Writes the combined prompt (system + ask + input) to a uniquely-named temp file so it can be
/// attached with `--file`. Returns the path, or `None` if the write failed — the run then proceeds
/// with only the pointer message (a degraded but non-crashing outcome; temp writes ~never fail).
fn write_payload_file(content: &str) -> Option<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("codeflow-opencode-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&path, content).ok().map(|_| path)
}

/// opencode's default output is formatted assistant text on stdout, so — unlike Claude's JSON
/// envelope — the reply is just stdout. Mirrors the other engines' error/quota contract.
/// TODO(verify): `--format json` emits a raw JSON event stream that would let us extract the real
/// session id and model; until that schema is pinned we consume the plain text.
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<AiRun, String> {
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
        return Err(format!("opencode exited with an error ({status_label}): {detail}"));
    }

    let text = stdout.trim();
    if text.is_empty() {
        // Some builds print status on stderr; surface that rather than an empty reply.
        let err = stderr.trim();
        return Err(if err.is_empty() {
            "opencode produced no output".to_string()
        } else {
            err.to_string()
        });
    }
    if quota_signal(text) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    Ok(AiRun { text: text.to_string(), session_id: Some(SESSION_SENTINEL.to_string()), model: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_successful_run_returns_stdout_as_the_reply() {
        let run = interpret_output(true, "exit status: 0", "  feat: add thing  ", "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        // Non-empty session marker so multi-turn chat resumes with `--continue`.
        assert_eq!(run.session_id.as_deref(), Some(SESSION_SENTINEL));
    }

    #[test]
    fn surfaces_the_failure_detail() {
        let err = interpret_output(false, "exit status: 1", "", "auth required: run `opencode auth login`").unwrap_err();
        assert_eq!(err, "opencode exited with an error (exit status: 1): auth required: run `opencode auth login`");
    }

    #[test]
    fn a_quota_message_gets_the_marker() {
        let err = interpret_output(false, "exit status: 1", "", "You have hit your rate limit, try again in 1h").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn empty_output_on_a_clean_exit_is_an_error_not_a_blank_reply() {
        let err = interpret_output(true, "exit status: 0", "   ", "").unwrap_err();
        assert_eq!(err, "opencode produced no output");
    }
}
