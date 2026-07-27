//! The Codex CLI engine — OpenAI's models driven through `codex`, authenticated with a **ChatGPT
//! subscription** rather than metered API credits.
//!
//! This is the counterpart to the `openai` engine, and the difference is billing, not vendor:
//! `openai.rs` talks to `/v1/chat/completions` with an API key (pay per token), while this one
//! shells out to the CLI the user logged into with `codex login` — the same arrangement Claude Code
//! and Antigravity have, where the flat-fee plan you already pay for does the work.
//!
//! Headless contract (`codex exec`): runs one task to completion, streams progress to **stderr**
//! and writes only the final agent message to **stdout**, with no approval prompts. Piped stdin is
//! taken as additional context alongside the prompt argument, which maps exactly onto this app's
//! "ask as argument, data on stdin" split.
//!
//! **Sessions.** `codex exec` opens its run with a preamble on stderr — version, workdir, model,
//! sandbox, and a `session id: <uuid>` line — and `codex exec resume <id>` continues that rollout.
//! So the id is scraped from stderr rather than from `--json`: stdout keeps carrying nothing but
//! the final agent message, so the reply extraction below is unaffected by Codex's event schema.
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

use crate::ai::{quota_signal, AiEngine, AiInvocation, AiRun, QUOTA_MARKER};

const DEFAULT_BINARY: &str = "codex";

/// Let the CLI pick its own model for commit messages — which ids a ChatGPT plan exposes depends on
/// the subscription tier, so hardcoding one risks naming something the account can't use.
const COMMIT_MESSAGE_MODEL: &str = "";

/// Single-line, ASCII, shim-safe. The real instructions arrive on stdin.
const POINTER: &str =
    "Follow the instructions in the input piped on stdin and reply with only the requested output.";

pub struct CodexEngine;

impl AiEngine for CodexEngine {
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
        if !inv.stdin_content.trim().is_empty() {
            brief.push_str("\n\n----- INPUT -----\n\n");
            brief.push_str(inv.stdin_content);
        }
        brief
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = Command::new(binary);
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
fn codex_home() -> Option<std::path::PathBuf> {
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

    let text = stdout.trim();
    if text.is_empty() {
        let err = stderr.trim();
        return Err(if err.is_empty() {
            "codex produced no output".to_string()
        } else {
            err.to_string()
        });
    }
    if quota_signal(text) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    Ok(AiRun { text: text.to_string(), session_id: session_id_from_preamble(stderr), model: None })
}

#[cfg(test)]
mod tests {
    use super::*;

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
