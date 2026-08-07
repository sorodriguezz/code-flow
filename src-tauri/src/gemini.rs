//! The Antigravity CLI engine (`agy`) — surfaced in the UI as "Gemini".
//!
//! Google retired the standalone `gemini` CLI for consumer/subscription accounts (mid-2026) and
//! replaced it with the **Antigravity CLI**, invoked as `agy`, which runs Gemini 3.x plus a few
//! Claude / GPT-OSS models against a Google-account login. This engine drives `agy` in headless
//! `--print` mode. The provider stays labelled "Gemini" (that's the login/brand the user picks);
//! this module is what actually differs.
//!
//! Verified against agy 1.1.7 on Windows, and re-verified on 1.1.10 (macOS):
//!   - `agy models` prints available model ids, one per line → [`list_models_args`] makes the
//!     Settings picker show the real set instead of a hardcoded guess.
//!   - `agy -p "<prompt>"` runs one prompt non-interactively and prints the reply to stdout.
//!   - **`--output-format text|json|stream-json` exists as of 1.1.10** and did not in 1.1.7. Under
//!     `stream-json` the CLI emits one JSON event per line and closes with
//!     `{"event":"result","result":{…}}`, which carries the reply, the conversation id and the
//!     turn's `usage` block. That is the same shape `claude.rs` reads, and this engine now asks for
//!     it: without it a Gemini turn reported no tokens at all and the usage meter simply had
//!     nothing to draw for this provider. **It also means agy 1.1.10 or newer is required** — an
//!     older binary rejects the flag. The plain-text fallback below covers a CLI that ignores it,
//!     not one that refuses it.
//!   - `-p` does **not** read stdin, and there's no `--system-prompt` / `--file` flag. So the whole
//!     prompt (system + ask + data) can't ride on stdin. Two delivery paths, chosen by size:
//!       * **small** — passed inline as the `-p` argument. `agy.exe` is a native binary, so
//!         multi-line args are fine (unlike the `.cmd` shims opencode/gemini get from npm).
//!       * **large** — a review diff can be 120k, past the ~32k Windows argv limit; it's written to
//!         a temp file, the temp dir added with `--add-dir`, and a short `-p` message tells agy to
//!         read it. Reading it headlessly needs `--dangerously-skip-permissions` (no prompt to
//!         answer). agy has no granular tool-allowlist flag, so permissions are all-or-nothing.
//!
//! **Sessions: the blocker is gone, the swap is not made yet.** This engine used to say a headless
//! caller could not learn agy's conversation id — true on 1.1.7, where nothing printed it and there
//! was no `--output-format` to ask for it (google-antigravity/antigravity-cli#7). On 1.1.10 the
//! `result` event carries `conversation_id`, and `--conversation <id>` has always accepted one. So
//! the two halves now exist and [`SESSION_SENTINEL`] could be replaced by the real id.
//!
//! It deliberately has **not** been, because that is a change to how chat resumes rather than a
//! bug fix on the way past: `--continue` keeps working exactly as it has, with its known
//! limitation — two conversations open on the same project can resume each other's context,
//! silently. Making the swap is a decision about chat behaviour and wants to be made on purpose,
//! with the id threaded through `AiRun::session_id` and `build_command` moved off `--continue` in
//! the same change.

use tokio::process::Command;

use serde::Deserialize;
use crate::ai::{quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, AiUsage, QUOTA_MARKER};

const DEFAULT_BINARY: &str = "agy";

/// Let agy pick its own default model for commit messages — its ids (e.g. `gemini-3.6-flash-low`)
/// depend on the account's quota/availability, so hardcoding one risks pointing at something the
/// user's plan doesn't expose.
const COMMIT_MESSAGE_MODEL: &str = "";

/// Stand-in for a session id, because agy never tells a `--print` caller its real conversation id
/// (see the module docs). It identifies nothing — its only job is to keep the app's chat state at
/// "there is a session" so the next turn passes *something*, which
/// [`GeminiEngine::build_command`] turns into `--continue`. Being a fixed string is why chat turns
/// group under the app's own conversation id and not this one (see `db::migrations`).
const SESSION_SENTINEL: &str = "agy-last";

/// Above this many chars the prompt is delivered via a temp file + `--add-dir` instead of inline,
/// to stay clear of the Windows ~32k command-line limit (a review diff alone can reach 120k).
const INLINE_LIMIT: usize = 12_000;

pub struct GeminiEngine;

impl AiEngine for GeminiEngine {
    fn id(&self) -> &'static str {
        "gemini"
    }

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
        let mut cmd = crate::proc::command(binary);

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

        // One JSON event per line as the run happens, rather than a single blob at the end: the
        // app streams stdout into the run log, and plain `json` would leave it empty until the
        // process exits. The closing `result` event is what `interpret_output` reads.
        cmd.arg("--output-format").arg("stream-json");
        if !inv.model.trim().is_empty() {
            cmd.arg("--model").arg(inv.model);
        }
        // Skip permission prompts when the flow may write (chat / fix) or when agy has to read the
        // temp brief file headlessly. A small read-only prompt needs neither.
        if inv.auto_approve_edits || needs_read_permission {
            cmd.arg("--dangerously-skip-permissions");
        }
        // Multi-turn chat: resume the most recent conversation. Not this conversation — agy gives a
        // headless caller no id to be specific with, so two chats on one project can cross. See the
        // module docs; `--conversation <id>` is the fix once the id is obtainable.
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

/// The closing `{"event":"result", …}` line of a `stream-json` run.
#[derive(Deserialize)]
struct AgyResult {
    #[serde(default)]
    response: String,
    #[serde(default)]
    usage: Option<AgyUsage>,
}

/// Defaulted field by field, like every other engine's: agy has already added fields to this
/// object between two point releases, and a strict shape would turn "a newer CLI reported one more
/// counter" into "the whole turn failed to parse".
#[derive(Default, Deserialize)]
struct AgyUsage {
    #[serde(default)]
    input_tokens: i64,
    #[serde(default)]
    output_tokens: i64,
    /// Reasoning tokens. Counted as output, because that is what they are — generated, and billed
    /// as such — and a meter that dropped them would under-report a thinking model by most of it.
    #[serde(default)]
    thinking_tokens: i64,
    #[serde(default)]
    cache_read_tokens: i64,
}

/// Walks the events backwards for the run's verdict. Backwards because the `result` event is the
/// last line by construction, and because anything a banner printed ahead of the stream is then
/// never even parsed.
fn result_event(stdout: &str) -> Option<AgyResult> {
    for line in stdout.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if value.get("event").and_then(serde_json::Value::as_str) != Some("result") {
            continue;
        }
        if let Some(result) = value.get("result") {
            return serde_json::from_value(result.clone()).ok();
        }
    }
    None
}

/// Under `stream-json` the reply is the `response` of the closing event; a CLI that ignored the
/// flag prints the reply as plain text instead, and that stays the fallback. Mirrors the other
/// engines' error/quota contract either way.
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

    let parsed = result_event(stdout);
    // The whole of stdout when there was no result event — a CLI old enough to ignore
    // `--output-format` prints the reply and nothing else, which is exactly what this used to read.
    let text = match &parsed {
        Some(result) => result.response.trim().to_string(),
        None => stdout.trim().to_string(),
    };
    if text.is_empty() {
        let err = stderr.trim();
        return Err(if err.is_empty() {
            "agy produced no output".to_string()
        } else {
            err.to_string()
        });
    }
    if refusal_reply(&text) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    let usage = parsed.and_then(|result| result.usage).map(|u| AiUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens + u.thinking_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: 0,
        // agy prices nothing. `None` and not `0.0`: the meter shows "no price" for this engine
        // rather than claiming its turns were free.
        cost_usd: None,
    });
    Ok(AiRun {
        text,
        session_id: Some(SESSION_SENTINEL.to_string()),
        model: None,
        usage: usage.filter(|u| !u.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback path: a CLI old enough to ignore `--output-format` prints prose and nothing
    /// else, and that still has to work.
    #[test]
    fn a_successful_run_returns_stdout_as_the_reply() {
        let run = interpret_output(true, "exit status: 0", "  feat: add thing  ", "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id.as_deref(), Some(SESSION_SENTINEL));
        assert!(run.usage.is_none(), "no envelope means nothing to report");
    }

    /// Captured verbatim from `agy -p … --output-format stream-json` on 1.1.10, trimmed to the
    /// closing event.
    const STREAM: &str = concat!(
        r#"{"event":"step_update","step_update":{"step_index":0,"state":"DONE"}}"#,
        "\n",
        r#"{"event":"result","result":{"conversation_id":"c8bb","status":"SUCCESS","response":"ok\n","#,
        r#""num_turns":1,"usage":{"input_tokens":17902,"output_tokens":16,"thinking_tokens":4,"#,
        r#""cache_read_tokens":9,"total_tokens":17918}}}"#,
    );

    #[test]
    fn the_closing_event_carries_the_reply_and_the_tokens() {
        let run = interpret_output(true, "exit status: 0", STREAM, "").unwrap();
        assert_eq!(run.text, "ok");
        let usage = run.usage.expect("1.1.10 reports usage");
        assert_eq!(usage.input_tokens, 17902);
        // Thinking tokens are generated tokens, so they land on the output side.
        assert_eq!(usage.output_tokens, 20);
        assert_eq!(usage.cache_read_tokens, 9);
        assert!(usage.cost_usd.is_none(), "agy prices nothing");
    }

    /// A stray line that happens to be JSON must not be mistaken for the verdict.
    #[test]
    fn only_the_result_event_counts() {
        let noise = concat!(r#"{"event":"step_update","step_update":{"state":"DONE"}}"#, "\n", "plain tail");
        let run = interpret_output(true, "exit status: 0", noise, "").unwrap();
        assert!(run.text.contains("plain tail"), "fell back to the whole of stdout");
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
