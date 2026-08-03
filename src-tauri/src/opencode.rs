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
//! it). Temp files aren't cleaned up yet.
//!
//! **Sessions.** Runs use `--format json`, which is what makes per-conversation resume possible:
//! the real session id (`ses_…`) rides on every emitted event as `sessionID`, so
//! [`OpenCodeEngine::interpret`] can hand it back and the next turn resumes *that* session with
//! `--session <id>`. This replaces an
//! earlier `--continue`, which resolves to "the first root session opencode lists" — global to the
//! CLI, not scoped to the conversation — so two chats open on the same project would silently
//! answer each other's context. Note `--session <id>` hard-fails ("Session not found", exit 1) on
//! an id opencode no longer has, which is deliberate: a loud error beats the wrong context.
//!
//! Verified against opencode 1.18.7 (`opencode run --help` for the flags, a live run for the event
//! shape) and pinned against the CLI's own `run.ts`, which emits every event as
//! `{type, timestamp, sessionID, ...data}` — one JSON object per line on stdout. The events this
//! module reads are `text` (a completed assistant text part, in `part.text`) and `error`.

use serde::Deserialize;
use tokio::process::Command;

use crate::ai::{quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, QUOTA_MARKER};

/// opencode addresses models as `provider/model`; leaving the commit model empty lets opencode use
/// whatever default the user configured instead of forcing a provider they might not have set up.
const COMMIT_MESSAGE_MODEL: &str = "";

const DEFAULT_BINARY: &str = "opencode";

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
        let mut cmd = crate::proc::command(binary);
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

        // Structured events on stdout instead of formatted text. Needed for the session id — it is
        // reported nowhere else — and the reply is reassembled from the `text` events, which carry
        // exactly what the default formatter would have printed.
        cmd.arg("--format").arg("json");

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
        // Multi-turn chat: resume *this conversation's* session by id, not whichever session the
        // CLI happens to consider most recent (see the module docs on `--continue`).
        if let Some(id) = inv.resume_session_id {
            cmd.arg("--session").arg(id);
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

/// One line of `opencode run --format json`. Every event is `{type, timestamp, sessionID, ...data}`,
/// so `sessionID` is available whichever event arrives first — including the `error` ones, which is
/// what lets a failed run still report the session it failed in.
#[derive(Deserialize)]
struct Event {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "sessionID")]
    session_id: Option<String>,
    part: Option<Part>,
    error: Option<EventError>,
}

#[derive(Deserialize)]
struct Part {
    #[serde(default)]
    text: Option<String>,
}

/// The `error` event's payload: a named error whose human-readable text sits in `data.message`.
#[derive(Deserialize)]
struct EventError {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    data: Option<EventErrorData>,
}

#[derive(Deserialize)]
struct EventErrorData {
    #[serde(default)]
    message: Option<String>,
}

/// What one JSON-formatted run reported.
struct Parsed {
    text: String,
    session_id: Option<String>,
    /// First error event, if any — the root cause, which later events tend to restate.
    error: Option<String>,
}

/// Reads the event stream. `None` means stdout held no parseable event at all, so the caller falls
/// back to treating it as plain text — which keeps a build that ignored `--format json` working
/// exactly as before instead of reporting an empty reply.
fn parse_events(stdout: &str) -> Option<Parsed> {
    let mut texts: Vec<String> = Vec::new();
    let mut session_id: Option<String> = None;
    let mut error: Option<String> = None;
    let mut saw_event = false;

    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Event>(line) else { continue };
        saw_event = true;
        if session_id.is_none() {
            session_id = event.session_id.filter(|id| !id.trim().is_empty());
        }
        match event.kind.as_str() {
            // Concatenating the completed text parts reproduces what the default formatter writes
            // to a non-TTY stdout (each part trimmed, one per line) — so the reply text is
            // unchanged by moving to JSON.
            "text" => {
                if let Some(text) = event.part.and_then(|p| p.text) {
                    let text = text.trim();
                    if !text.is_empty() {
                        texts.push(text.to_string());
                    }
                }
            }
            "error" => {
                if error.is_none() {
                    error = event.error.and_then(error_message);
                }
            }
            _ => {}
        }
    }

    saw_event.then(|| Parsed { text: texts.join("\n"), session_id, error })
}

/// Best available description of an `error` event: its message, qualified by the error name when
/// there is one (`APIError: Unauthorized …` reads better than a bare message in the UI).
fn error_message(error: EventError) -> Option<String> {
    let message = error.data.and_then(|d| d.message).map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    match (error.name.as_deref().map(str::trim).filter(|n| !n.is_empty()), message) {
        (Some(name), Some(message)) => Some(format!("{name}: {message}")),
        (None, Some(message)) => Some(message),
        (Some(name), None) => Some(name.to_string()),
        (None, None) => None,
    }
}

/// Turns one finished `opencode run --format json` into its reply (plus the session id to resume
/// next turn) or a user-facing error. Mirrors the other engines' error/quota contract.
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<AiRun, String> {
    if let Some(parsed) = parse_events(stdout) {
        // An `error` event is the CLI explaining itself, and it can arrive on an otherwise
        // zero-exit run — so it's judged before the status, as in the Claude engine.
        if let Some(error) = parsed.error {
            return Err(if quota_signal(&error) { format!("{QUOTA_MARKER}{error}") } else { error });
        }
        let text = parsed.text.trim();
        if !success {
            let detail = [text, stderr.trim()].into_iter().find(|s| !s.is_empty()).unwrap_or("sin salida");
            if quota_signal(detail) {
                return Err(format!("{QUOTA_MARKER}{detail}"));
            }
            return Err(stale_session_hint(detail)
                .unwrap_or_else(|| format!("opencode exited with an error ({status_label}): {detail}")));
        }
        if text.is_empty() {
            return Err("opencode produced no output".to_string());
        }
        if refusal_reply(text) {
            return Err(format!("{QUOTA_MARKER}{text}"));
        }
        return Ok(AiRun { text: text.to_string(), session_id: parsed.session_id, model: None });
    }

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
        return Err(stale_session_hint(detail)
            .unwrap_or_else(|| format!("opencode exited with an error ({status_label}): {detail}")));
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
    if refusal_reply(text) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    // No events means no session id to report. `None` costs this conversation its continuity (the
    // next turn starts fresh and re-sends the project context) but never resumes the wrong one.
    Ok(AiRun { text: text.to_string(), session_id: None, model: None })
}

/// Rewrites opencode's bare "Session not found" into something actionable. It means the id we asked
/// to resume is gone from opencode's store (deleted or pruned), which the raw message doesn't
/// convey — and since the app keeps re-sending that id, the conversation would otherwise look
/// permanently broken for no visible reason.
fn stale_session_hint(detail: &str) -> Option<String> {
    detail.to_lowercase().contains("session not found").then(|| {
        "La sesión de opencode que continuaba esta conversación ya no existe (fue eliminada o \
         purgada). Inicia una conversación nueva para volver a empezar."
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `--format json` run, trimmed to the events this module reads. Shape taken from the
    /// CLI's own emitter (`{type, timestamp, sessionID, ...data}`) and a live opencode 1.18.7 run.
    const JSON_STDOUT: &str = concat!(
        r#"{"type":"step_start","timestamp":1785160196000,"sessionID":"ses_05c2930e3ffeAwuzpCYQ7CgtfG","part":{"type":"step-start"}}"#,
        "\n",
        r#"{"type":"text","timestamp":1785160196045,"sessionID":"ses_05c2930e3ffeAwuzpCYQ7CgtfG","part":{"id":"prt_1","messageID":"msg_1","type":"text","text":"  feat: add thing  ","time":{"start":1,"end":2}}}"#,
        "\n",
        r#"{"type":"step_finish","timestamp":1785160196050,"sessionID":"ses_05c2930e3ffeAwuzpCYQ7CgtfG","part":{"type":"step-finish"}}"#,
        "\n",
    );

    /// The whole point of the JSON format: the reply *and* the real `ses_…` id, so the next turn
    /// resumes this conversation by id rather than whatever session opencode ran last.
    #[test]
    fn reads_the_reply_and_the_real_session_id_out_of_the_event_stream() {
        let run = interpret_output(true, "exit status: 0", JSON_STDOUT, "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id.as_deref(), Some("ses_05c2930e3ffeAwuzpCYQ7CgtfG"));
    }

    /// Several completed text parts arrive as separate events; joining them reproduces what the
    /// default (non-JSON) formatter would have written to stdout.
    #[test]
    fn joins_multiple_text_parts_in_order() {
        let stdout = concat!(
            r#"{"type":"text","sessionID":"ses_a","part":{"type":"text","text":"first"}}"#,
            "\n",
            r#"{"type":"text","sessionID":"ses_a","part":{"type":"text","text":"second"}}"#,
            "\n",
        );
        let run = interpret_output(true, "exit status: 0", stdout, "").unwrap();
        assert_eq!(run.text, "first\nsecond");
    }

    /// Verbatim `error` event from a live run whose Copilot token had expired: a zero exit code, so
    /// the event is the only thing that says the run failed.
    #[test]
    fn an_error_event_beats_a_clean_exit_status() {
        let stdout = r#"{"type":"error","timestamp":1785160196045,"sessionID":"ses_05c2930e3ffeAwuzpCYQ7CgtfG","error":{"name":"APIError","data":{"message":"Unauthorized: unauthorized: AuthenticateToken authentication failed","statusCode":401}}}"#;
        let err = interpret_output(true, "exit status: 0", stdout, "").unwrap_err();
        assert_eq!(err, "APIError: Unauthorized: unauthorized: AuthenticateToken authentication failed");
    }

    /// A billing refusal that exits non-zero without emitting an `error` event still has to reach
    /// the frontend as a quota notice, not a generic red banner.
    #[test]
    fn a_quota_failure_alongside_events_still_gets_the_marker() {
        let stdout = r#"{"type":"step_start","sessionID":"ses_a","part":{"type":"step-start"}}"#;
        let err = interpret_output(false, "exit status: 1", stdout, "Error: Insufficient balance").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn a_quota_error_event_gets_the_marker() {
        let stdout = r#"{"type":"error","sessionID":"ses_a","error":{"name":"APIError","data":{"message":"Insufficient balance"}}}"#;
        let err = interpret_output(true, "exit status: 0", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    /// Resuming an id opencode has since dropped exits 1 with a bare "Session not found"; the app
    /// keeps re-sending that id, so the message has to say what to do about it.
    #[test]
    fn a_dropped_session_explains_itself_instead_of_repeating_the_cli_error() {
        let err = interpret_output(false, "exit status: 1", "", "Error: Session not found").unwrap_err();
        assert!(err.contains("Inicia una conversación nueva"), "got {err}");
    }

    /// A build that ignored `--format json` still emits plain text; it must keep working, just
    /// without a session id (no id is better than resuming a stranger's session).
    #[test]
    fn falls_back_to_plain_stdout_and_reports_no_session() {
        let run = interpret_output(true, "exit status: 0", "  feat: add thing  ", "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        assert_eq!(run.session_id, None);
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
