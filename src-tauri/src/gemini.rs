//! The Antigravity CLI engine (`agy`) — surfaced in the UI as "Gemini".
//!
//! Google retired the standalone `gemini` CLI for consumer/subscription accounts (mid-2026) and
//! replaced it with the **Antigravity CLI**, invoked as `agy`, which runs Gemini 3.x plus a few
//! Claude / GPT-OSS models against a Google-account login. This engine drives `agy` in headless
//! `--print` mode. The provider stays labelled "Gemini" (that's the login/brand the user picks);
//! this module is what actually differs.
//!
//! Verified against agy 1.1.7 on Windows:
//!   - `agy models` prints available model ids, one per line → [`list_models_args`] makes the
//!     Settings picker show the real set instead of a hardcoded guess.
//!   - `agy -p "<prompt>"` runs one prompt non-interactively and prints the reply to stdout.
//!   - `-p` does **not** read stdin, and there's no `--system-prompt` / `--file` flag. So the whole
//!     prompt (system + ask + data) can't ride on stdin. Two delivery paths, chosen by size:
//!       * **small** — passed inline as the `-p` argument. `agy.exe` is a native binary, so
//!         multi-line args are fine (unlike the `.cmd` shims opencode/gemini get from npm).
//!       * **large** — a review diff can be 120k, past the ~32k Windows argv limit; it's written to
//!         a temp file, the temp dir added with `--add-dir`, and a short `-p` message tells agy to
//!         read it. Reading it headlessly needs `--dangerously-skip-permissions` (no prompt to
//!         answer). agy has no granular tool-allowlist flag, so permissions are all-or-nothing.

use tokio::process::Command;

use crate::ai::{quota_signal, AiEngine, AiInvocation, AiRun, QUOTA_MARKER};

const DEFAULT_BINARY: &str = "agy";

/// Let agy pick its own default model for commit messages — its ids (e.g. `gemini-3.6-flash-low`)
/// depend on the account's quota/availability, so hardcoding one risks pointing at something the
/// user's plan doesn't expose.
const COMMIT_MESSAGE_MODEL: &str = "";

/// A non-empty sentinel so the app's chat state stays at "there is a session" and the next turn
/// passes a resume id, which [`build_command`] maps to `--continue` (resume the most recent
/// conversation). TODO(verify): capture the real conversation id and use `--conversation <id>`.
const SESSION_SENTINEL: &str = "agy-last";

/// Above this many chars the prompt is delivered via a temp file + `--add-dir` instead of inline,
/// to stay clear of the Windows ~32k command-line limit (a review diff alone can reach 120k).
const INLINE_LIMIT: usize = 12_000;

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
        // agy has no tool-allowlist flag; write access comes from `--dangerously-skip-permissions`
        // (set via auto_approve_edits), so there are no tool names to pass.
        Vec::new()
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = Command::new(binary);

        // Compose the full prompt: system instructions → the ask → the data payload.
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

        // Deliver the prompt inline when it fits, else via a temp file agy is told to read.
        let mut needs_read_permission = false;
        match write_brief_file_if_large(&brief) {
            Some((dir, file)) => {
                cmd.arg("-p").arg(format!(
                    "Read the file at {} and carry out the instructions it contains, replying with only the requested output.",
                    file.display()
                ));
                cmd.arg("--add-dir").arg(dir);
                needs_read_permission = true;
            }
            None => {
                cmd.arg("-p").arg(&brief);
            }
        }

        if !inv.model.trim().is_empty() {
            cmd.arg("--model").arg(inv.model);
        }
        // Skip permission prompts when the flow may write (chat / fix) or when agy has to read the
        // temp brief file headlessly. A small read-only prompt needs neither.
        if inv.auto_approve_edits || needs_read_permission {
            cmd.arg("--dangerously-skip-permissions");
        }
        // Multi-turn chat: resume the most recent conversation.
        if inv.resume_session_id.is_some() {
            cmd.arg("--continue");
        }
        if let Some(dir) = inv.cwd {
            cmd.current_dir(dir);
        }
        cmd
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }

    fn list_models_args(&self) -> Option<Vec<String>> {
        // `agy models` prints one model id per line — exactly what `crate::ai::list_models` wants.
        Some(vec!["models".to_string()])
    }
}

/// Returns `Some((tempdir, file))` when `content` is too big to pass inline and was written to a
/// temp file; `None` when it fits inline (the caller then passes it as the `-p` argument). A failed
/// write also returns `None`, degrading to an inline attempt rather than failing the whole call.
fn write_brief_file_if_large(content: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    if content.len() <= INLINE_LIMIT {
        return None;
    }
    // A per-call subdirectory so `--add-dir` scopes agy to exactly this file and nothing else.
    let dir = std::env::temp_dir().join(format!("codeflow-agy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).ok()?;
    let file = dir.join("brief.txt");
    std::fs::write(&file, content).ok()?;
    Some((dir, file))
}

/// agy `-p` prints the assistant reply to stdout (status/banner, if any, goes to stderr), so the
/// reply is just stdout. Mirrors the other engines' error/quota contract.
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
        return Err(format!("agy exited with an error ({status_label}): {detail}"));
    }

    let text = stdout.trim();
    if text.is_empty() {
        let err = stderr.trim();
        return Err(if err.is_empty() {
            "agy produced no output".to_string()
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
        assert_eq!(run.session_id.as_deref(), Some(SESSION_SENTINEL));
    }

    #[test]
    fn surfaces_the_failure_detail() {
        let err = interpret_output(false, "exit status: 1", "", "not signed in — run `agy` to log in").unwrap_err();
        assert_eq!(err, "agy exited with an error (exit status: 1): not signed in — run `agy` to log in");
    }

    #[test]
    fn a_quota_message_gets_the_marker() {
        let err = interpret_output(false, "exit status: 1", "", "quota exceeded, try again in 2h").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn empty_output_on_a_clean_exit_is_an_error_not_a_blank_reply() {
        let err = interpret_output(true, "exit status: 0", "   ", "").unwrap_err();
        assert_eq!(err, "agy produced no output");
    }

    #[test]
    fn small_prompts_stay_inline() {
        assert!(write_brief_file_if_large("hola").is_none());
    }
}
