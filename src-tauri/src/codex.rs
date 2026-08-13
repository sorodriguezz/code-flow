//! The Codex CLI engine — OpenAI's models driven through `codex`, authenticated with a **ChatGPT
//! subscription** rather than metered API credits.
//!
//! This is the counterpart to the `openai` engine, and the difference is billing, not vendor:
//! `openai.rs` talks to `/v1/chat/completions` with an API key (pay per token), while this one
//! shells out to the CLI the user logged into with `codex login` — the same arrangement Claude Code
//! and Antigravity have, where the flat-fee plan you already pay for does the work.
//!
//! Headless contract (`codex exec --json`): runs one task to completion, streams progress to
//! **stderr** and a JSONL event stream to **stdout**, with no approval prompts. Piped stdin is
//! taken as additional context alongside the prompt argument, which maps exactly onto this app's
//! "ask as argument, data on stdin" split.
//!
//! **Why `--json`, having gone out of its way not to need it.** Plain `codex exec` puts the final
//! message on stdout and nothing else — simple, and schema-proof. But it also reports *no token
//! counts anywhere*, so every Codex run was recorded with nothing to count and the engine was
//! simply missing from the usage screen. `turn.completed` is the one place the CLI states what a
//! turn spent. [`parse_events`] therefore reads the stream, and falls back to treating stdout as a
//! plain final message when it parses as no events at all — so a build that drops the flag loses
//! the token counts and keeps answering.
//!
//! **Sessions.** `codex exec` opens its run with a preamble on stderr — version, workdir, model,
//! sandbox, and a `session id: <uuid>` line — and `codex exec resume <id>` continues that rollout.
//! The id is still scraped from that preamble rather than from the event stream, which keeps
//! resuming working even if the stream's shape changes under it.
//! Before this, the engine reported a fixed sentinel and never passed a resume argument at all,
//! which was the worst of both — no continuity *and* the app believing a session existed, so
//! [`crate::ai::chat_with_repo`] stopped re-sending the project context from turn two onward.
//!
//! If the preamble ever stops carrying the id, [`session_id_from_preamble`] returns `None` and the
//! next turn simply opens a fresh session with the context re-sent. That is the deliberate failure
//! mode: losing continuity is recoverable, resuming the wrong conversation silently is not.
//!
//! Why the brief goes through stdin anyway: the prompt templates are multi-line, and a CLI
//! installed as an npm `.cmd` shim on Windows can't receive a multi-line argument. Sending a short
//! single-line pointer as the argument and everything else down the pipe is safe on every platform
//! and every distribution — the same trick `opencode` and `gemini` use with their payload files.

use tokio::process::Command;

use crate::ai::{quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, AiUsage, QUOTA_MARKER};

const DEFAULT_BINARY: &str = "codex";

/// Let the CLI pick its own model for commit messages — which ids a ChatGPT plan exposes depends on
/// the subscription tier, so hardcoding one risks naming something the account can't use.
const COMMIT_MESSAGE_MODEL: &str = "";

/// Single-line, ASCII, shim-safe. The real instructions arrive on stdin.
const POINTER: &str =
    "Follow the instructions in the input piped on stdin and reply with only the requested output.";

pub struct CodexEngine;

impl AiEngine for CodexEngine {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_BINARY
    }

    fn commit_message_model(&self) -> &'static str {
        COMMIT_MESSAGE_MODEL
    }

    fn fix_tools(&self) -> Vec<String> {
        // Codex has no tool-allowlist flag; write access is granted by the sandbox policy
        // (`--sandbox workspace-write`, set from `auto_approve_edits`), so there are no names to pass.
        Vec::new()
    }

    fn stdin_payload(&self, inv: &AiInvocation) -> String {
        let mut brief = String::new();
        if let Some(system) = inv.system_prompt {
            if !system.trim().is_empty() {
                brief.push_str(system);
                brief.push_str("\n\n");
            }
        }
        brief.push_str(inv.prompt);
        if !inv.skills_note.is_empty() {
            brief.push_str("\n\n");
            brief.push_str(&inv.skills_note);
        }
        if !inv.stdin_content.trim().is_empty() {
            brief.push_str("\n\n----- INPUT -----\n\n");
            brief.push_str(inv.stdin_content);
        }
        brief
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = crate::proc::command(binary);
        cmd.arg("exec");
        // Multi-turn chat: continue *this conversation's* rollout. `resume <id>` is a subcommand of
        // `exec`, so it goes between `exec` and the prompt, before the flags.
        if let Some(id) = inv.resume_session_id {
            cmd.arg("resume").arg(id);
        }
        cmd.arg(POINTER);

        if !inv.model.trim().is_empty() {
            cmd.arg("--model").arg(inv.model);
        }
        // Read-only unless the flow may write (chat / fix). `workspace-write` is the documented
        // successor to the deprecated `--full-auto`, and stays scoped to the repo rather than the
        // whole machine — `danger-full-access` is deliberately never used.
        cmd.arg("--sandbox")
            .arg(if inv.auto_approve_edits { "workspace-write" } else { "read-only" });
        // Headless runs can't answer an approval prompt — without this the agent can stop and wait
        // forever. Set through `-c` rather than `--ask-for-approval`, which `codex exec` dropped
        // (it errors with "unexpected argument" on 0.145+); the config key works on every version.
        cmd.arg("-c").arg("approval_policy=\"never\"");
        // Events as JSONL on stdout — the only place `codex exec` states what a turn spent. Without
        // it the run is unaccountable and Codex is simply missing from the usage screen, which is
        // what it was until this flag went in. [`interpret_output`] falls back to reading stdout as
        // the plain final message when nothing parses, so a build that drops or renames the flag
        // loses the token counts and keeps working.
        cmd.arg("--json");
        if let Some(dir) = inv.cwd {
            // `--cd` sets the workspace root the sandbox is scoped to, so it must be set even
            // though `current_dir` below already points there.
            cmd.arg("--cd").arg(dir);
            cmd.current_dir(dir);
        }
        cmd
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }

    fn cached_models(&self) -> Option<Vec<String>> {
        read_models_cache(&codex_home()?)
    }
}

/// Codex's state directory: `$CODEX_HOME` when set (the CLI's own override), else `~/.codex`.
pub(crate) fn codex_home() -> Option<std::path::PathBuf> {
    if let Some(dir) = std::env::var_os("CODEX_HOME") {
        return Some(std::path::PathBuf::from(dir));
    }
    Some(dirs::home_dir()?.join(".codex"))
}

/// The model catalog Codex refreshes into `models_cache.json`. Reading it is what keeps this
/// provider's picker current despite the CLI having no `models` subcommand: the CLI updates the
/// file itself, so a model shipped today shows up without an app release.
///
/// Only entries the CLI would itself display (`visibility: "list"`) are offered, ordered by the
/// catalog's own `priority` so the newest/most capable lands at the top rather than alphabetically.
fn read_models_cache(codex_home: &std::path::Path) -> Option<Vec<String>> {
    #[derive(serde::Deserialize)]
    struct Cache {
        #[serde(default)]
        models: Vec<Entry>,
    }
    #[derive(serde::Deserialize)]
    struct Entry {
        slug: String,
        #[serde(default)]
        visibility: String,
        #[serde(default)]
        priority: i64,
    }

    let raw = std::fs::read_to_string(codex_home.join("models_cache.json")).ok()?;
    let cache: Cache = serde_json::from_str(&raw).ok()?;
    let mut listed: Vec<Entry> = cache.models.into_iter().filter(|m| m.visibility == "list").collect();
    listed.sort_by_key(|m| m.priority);
    let slugs: Vec<String> = listed.into_iter().map(|m| m.slug).collect();
    // An empty catalog is indistinguishable from "no catalog" for the caller's purposes, and
    // `None` lets the frontend fall back to its curated list instead of showing nothing.
    (!slugs.is_empty()).then_some(slugs)
}

/// Pulls the rollout id out of `codex exec`'s stderr preamble, which prints one `key: value` per
/// line — the id being `session id: 019ce7d6-5962-7f21-9f20-95ebe6504c32`. Matched leniently
/// (either spelling, any case) because this is a human-readable banner, not a committed format;
/// `None` when it isn't there, which costs continuity but never resumes the wrong rollout.
fn session_id_from_preamble(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let line = line.trim();
        let lower = line.to_ascii_lowercase();
        let rest = ["session id:", "session_id:"]
            .iter()
            .find_map(|key| lower.starts_with(key).then(|| &line[key.len()..]))?;
        let id = rest.trim();
        (!id.is_empty()).then(|| id.to_string())
    })
}

/// The model `codex exec` announced it was going to use, from the same banner.
///
/// Worth reading even though this engine reports no tokens: with a blank `codex_model` setting the
/// CLI picks for itself, and without this the usage meter files the run under an empty model — a
/// row that reads as "unknown" next to the ones that name themselves. `model: gpt-5.3-codex` is
/// printed on every run, so the answer is there for free.
fn model_from_preamble(stderr: &str) -> Option<String> {
    stderr.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.to_ascii_lowercase().starts_with("model:").then(|| &line["model:".len()..])?;
        let model = rest.trim();
        (!model.is_empty()).then(|| model.to_string())
    })
}

/// `codex exec` puts the agent's final message on stdout and its progress log on stderr, so the
/// reply is just stdout. Mirrors the other engines' error/quota contract.
fn interpret_output(success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
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
        return Err(format!("codex exited with an error ({status_label}): {detail}"));
    }

    // `--json` turns stdout into an event stream, so the reply is assembled from it. A stdout that
    // parses as no events at all is taken verbatim, which is both the pre-`--json` behaviour and
    // the safety net if the flag ever stops being accepted.
    let events = parse_events(stdout);
    let text = match &events {
        Some(events) => events.message.trim().to_string(),
        None => stdout.trim().to_string(),
    };

    if text.is_empty() {
        let err = stderr.trim();
        return Err(if err.is_empty() {
            "codex produced no output".to_string()
        } else {
            err.to_string()
        });
    }
    if refusal_reply(&text) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    Ok(AiRun {
        text,
        session_id: session_id_from_preamble(stderr),
        model: model_from_preamble(stderr),
        // Tokens, never a price: a ChatGPT plan is a flat fee, so the run genuinely has no dollar
        // figure to report and the meter shows it as "no price" rather than as free.
        usage: events.and_then(|events| events.usage),
    })
}

/// What one `codex exec --json` run said: the agent's reply, and what it spent.
struct CodexEvents {
    message: String,
    usage: Option<AiUsage>,
}

/// Reads the JSONL event stream.
///
/// `None` means stdout held no events at all — not that it held none of interest — so the caller
/// can tell "this is an old-style plain-text reply" apart from "this run said nothing".
///
/// Only two event types are read, and unknown ones are skipped rather than treated as an error:
/// `item.completed` carrying an `agent_message` (the reply, joined when a turn produces several)
/// and `turn.completed` (the tokens). Everything else Codex emits — thread and turn starts, tool
/// calls, reasoning — is progress, not output.
fn parse_events(stdout: &str) -> Option<CodexEvents> {
    let mut saw_event = false;
    let mut message = String::new();
    let mut usage = None;

    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(kind) = event.get("type").and_then(|t| t.as_str()) else { continue };
        saw_event = true;

        match kind {
            "item.completed" => {
                let item = event.get("item");
                let is_message =
                    item.and_then(|i| i.get("type")).and_then(|t| t.as_str()) == Some("agent_message");
                if let (true, Some(text)) =
                    (is_message, item.and_then(|i| i.get("text")).and_then(|t| t.as_str()))
                {
                    if !message.is_empty() {
                        message.push_str("\n\n");
                    }
                    message.push_str(text);
                }
            }
            // Last one wins: a resumed rollout can report more than one turn, and the reply being
            // returned belongs to the final one.
            "turn.completed" => {
                if let Some(reported) = event.get("usage") {
                    usage = parse_usage(reported);
                }
            }
            _ => {}
        }
    }

    saw_event.then_some(CodexEvents { message, usage })
}

/// One `turn.completed` usage object in this app's terms.
///
/// The subtraction is the part that matters: Codex reports `input_tokens` **inclusive** of
/// `cached_input_tokens` (a second run of the same prompt came back as 12,975 input of which 12,672
/// cached — not 12,975 *plus* 12,672), so recording both as given would count the cached prompt
/// twice and make a cheap warm run look like the most expensive of the day. `reasoning_output_tokens`
/// is likewise already part of `output_tokens` and is deliberately not added.
fn parse_usage(reported: &serde_json::Value) -> Option<AiUsage> {
    let field = |name: &str| reported.get(name).and_then(|v| v.as_i64()).unwrap_or(0);

    let cached = field("cached_input_tokens");
    let usage = AiUsage {
        input_tokens: (field("input_tokens") - cached).max(0),
        output_tokens: field("output_tokens"),
        cache_read_tokens: cached,
        cache_write_tokens: field("cache_write_input_tokens"),
        cost_usd: None,
    };
    (!usage.is_empty()).then_some(usage)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured verbatim from `codex exec --json` on 0.147.0.
    const EVENTS: &str = concat!(
        r#"{"type":"thread.started","thread_id":"th_1"}"#,
        "\n",
        r#"{"type":"turn.started"}"#,
        "\n",
        r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}"#,
        "\n",
        r#"{"type":"turn.completed","usage":{"input_tokens":12975,"cached_input_tokens":12672,"#,
        r#""cache_write_input_tokens":0,"output_tokens":30,"reasoning_output_tokens":22}}"#,
        "\n",
    );

    #[test]
    fn reads_the_reply_and_the_tokens_from_the_event_stream() {
        let run = interpret_output(true, "exit status: 0", EVENTS, "").unwrap();
        assert_eq!(run.text, "PONG");

        let usage = run.usage.expect("codex now reports usage");
        // The cached prompt is counted once, not twice: 12975 reported input includes the 12672
        // served from cache, so only 303 of it was new.
        assert_eq!(usage.input_tokens, 303);
        assert_eq!(usage.cache_read_tokens, 12672);
        assert_eq!(usage.cache_write_tokens, 0);
        // `reasoning_output_tokens` is already inside `output_tokens` and is not added on top.
        assert_eq!(usage.output_tokens, 30);
        // A ChatGPT plan is a flat fee — no per-run price exists to report.
        assert!(usage.cost_usd.is_none());
    }

    /// The safety net: stdout that parses as no events is the old plain-text reply, and still works.
    #[test]
    fn plain_stdout_is_still_a_reply() {
        let run = interpret_output(true, "exit status: 0", "just the answer\n", "").unwrap();
        assert_eq!(run.text, "just the answer");
        assert!(run.usage.is_none());
    }

    /// A turn that emits events but no `agent_message` has produced no reply — that is an error,
    /// not an empty success, or the caller would file a blank answer as a good one.
    #[test]
    fn events_without_a_message_are_an_error() {
        let only_progress = concat!(r#"{"type":"turn.started"}"#, "\n", r#"{"type":"turn.completed"}"#, "\n");
        assert!(interpret_output(true, "exit status: 0", only_progress, "").is_err());
    }

    /// Several agent messages in one turn are joined rather than the last one silently winning.
    #[test]
    fn multiple_agent_messages_are_joined() {
        let two = concat!(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"first"}}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"second"}}"#,
            "\n",
        );
        let run = interpret_output(true, "exit status: 0", two, "").unwrap();
        assert_eq!(run.text, "first\n\nsecond");
    }

    /// The real `codex exec` stderr preamble — the only place the rollout id is reported when
    /// stdout is left as plain text.
    const PREAMBLE: &str = concat!(
        "OpenAI Codex v0.114.0 (research preview)\n",
        "--------\n",
        "workdir: /home/u/project\n",
        "model: gpt-5.3-codex\n",
        "provider: openai\n",
        "approval: never\n",
        "sandbox: read-only\n",
        "session id: 019ce7d6-5962-7f21-9f20-95ebe6504c32\n",
        "--------\n",
    );

    #[test]
    fn a_successful_run_returns_stdout_as_the_reply() {
        let run = interpret_output(true, "exit status: 0", "  feat: add thing  ", "thinking…").unwrap();
        assert_eq!(run.text, "feat: add thing");
    }

    /// What makes per-conversation resume possible: the id comes off the preamble, so the next turn
    /// can `codex exec resume <id>` instead of opening an unrelated rollout.
    #[test]
    fn captures_the_rollout_id_from_the_stderr_preamble() {
        let run = interpret_output(true, "exit status: 0", "done", PREAMBLE).unwrap();
        assert_eq!(run.session_id.as_deref(), Some("019ce7d6-5962-7f21-9f20-95ebe6504c32"));
    }

    /// The banner is also the only place a codex run says which model answered, which is what
    /// keeps it out of the usage meter's "unknown model" bucket when nothing was forced.
    #[test]
    fn captures_the_model_from_the_stderr_preamble() {
        let run = interpret_output(true, "exit status: 0", "done", PREAMBLE).unwrap();
        assert_eq!(run.model.as_deref(), Some("gpt-5.3-codex"));
    }

    #[test]
    fn reports_no_model_when_the_preamble_omits_it() {
        let run = interpret_output(true, "exit status: 0", "done", "OpenAI Codex v0.1\n").unwrap();
        assert_eq!(run.model, None);
    }

    /// A preamble without the id must report no session rather than a placeholder: `None` makes the
    /// next turn start fresh *with* the project context, which a sentinel silently suppressed.
    #[test]
    fn reports_no_session_when_the_preamble_omits_the_id() {
        let run = interpret_output(true, "exit status: 0", "done", "OpenAI Codex v0.1\nmodel: gpt\n").unwrap();
        assert_eq!(run.session_id, None);
    }

    /// Tolerated because the banner is human-readable prose, not a committed format.
    #[test]
    fn accepts_the_underscored_and_differently_cased_spellings() {
        assert_eq!(
            session_id_from_preamble("Session_ID:  abc-123  ").as_deref(),
            Some("abc-123")
        );
        assert_eq!(session_id_from_preamble("session id:").as_deref(), None);
    }

    #[test]
    fn surfaces_the_failure_detail() {
        let err = interpret_output(false, "exit status: 1", "", "not logged in — run `codex login`").unwrap_err();
        assert_eq!(err, "codex exited with an error (exit status: 1): not logged in — run `codex login`");
    }

    #[test]
    fn a_plan_limit_message_gets_the_marker() {
        let err = interpret_output(false, "exit status: 1", "", "You've hit your usage limit").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    #[test]
    fn progress_on_stderr_is_not_mistaken_for_an_error_on_a_clean_exit() {
        let run = interpret_output(true, "exit status: 0", "done", "[2026] running…").unwrap();
        assert_eq!(run.text, "done");
    }

    /// Self-cleaning scratch directory, optionally seeded with a `models_cache.json`.
    struct CacheDir(std::path::PathBuf);

    impl CacheDir {
        fn new(json: Option<&str>) -> Self {
            let path = std::env::temp_dir().join(format!("codeflow-codex-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            if let Some(json) = json {
                std::fs::write(path.join("models_cache.json"), json).expect("write cache");
            }
            CacheDir(path)
        }
    }

    impl Drop for CacheDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_the_catalog_newest_first_and_skips_hidden_entries() {
        let dir = CacheDir::new(Some(
            r#"{"models":[
                {"slug":"gpt-5.5","visibility":"list","priority":7},
                {"slug":"gpt-5.6-sol","visibility":"list","priority":1},
                {"slug":"internal-only","visibility":"hidden","priority":2}
            ]}"#,
        ));
        assert_eq!(
            read_models_cache(&dir.0),
            Some(vec!["gpt-5.6-sol".to_string(), "gpt-5.5".to_string()])
        );
    }

    #[test]
    fn no_catalog_falls_back_rather_than_reporting_an_empty_list() {
        assert_eq!(read_models_cache(&CacheDir::new(None).0), None);
        let nothing_listed = CacheDir::new(Some(r#"{"models":[{"slug":"x","visibility":"hidden"}]}"#));
        assert_eq!(read_models_cache(&nothing_listed.0), None);
    }
}
