//! The Antigravity CLI engine (`agy`) — surfaced in the UI as "Gemini".
//!
//! Google retired the standalone `gemini` CLI for consumer/subscription accounts (mid-2026) and
//! replaced it with the **Antigravity CLI**, invoked as `agy`, which runs Gemini 3.x plus a few
//! Claude / GPT-OSS models against a Google-account login. This engine drives `agy` in headless
//! `--print` mode. The provider stays labelled "Gemini" (that's the login/brand the user picks);
//! this module is what actually differs.
//!
//! Verified against agy 1.1.7 on Windows, and re-verified on 1.1.10 (macOS):
//!   - `agy models` prints available models, one per line → [`list_models_args`] makes the
//!     Settings picker show the real set instead of a hardcoded guess. Newer builds print
//!     `<id>\t<display label>` rather than a bare id, which is why [`parse_model_list`] takes only
//!     the first token of each line instead of the default one-id-per-line parse.
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
//!     prompt (system + ask + data) can't ride on stdin. Two delivery paths, chosen by
//!     [`delivery`]:
//!       * **inline** — passed as the `-p` argument. The installs verified above resolve `agy` to a
//!         native binary, so a multi-line argument wouldn't hit the `.cmd` shim newline rejection
//!         `claude.rs`/`grok.rs` guard against — but nothing stops a future or platform-specific
//!         packaging from landing as `agy.cmd` instead (npm is exactly how `opencode` ships), so a
//!         brief with an embedded newline goes inline only when the program is known not to be a
//!         batch shim, and only on a read-only run (below).
//!       * **a file** — a review diff can be 120k, past the ~32k Windows argv limit. It is written
//!         to a private per-call directory (see `crate::ai_prompt_files`, which deletes it when the
//!         run ends), that directory is added with `--add-dir`, and a short `-p` message tells agy
//!         to read it. Reading it headlessly needs `--dangerously-skip-permissions` (no prompt to
//!         answer). agy has no granular tool-allowlist flag, so permissions are all-or-nothing.
//!
//! **Read-only, as far as agy allows.** Re-verified on agy 1.2.12: in print mode, a tool request
//! that needs confirmation is *soft-denied* ("Print mode: soft-denying tool confirmation"), so a
//! run **without** `--dangerously-skip-permissions` cannot edit or run commands the user has not
//! pre-approved — and `--sandbox` restricts the terminal on top. So an invocation marked
//! [`AiInvocation::read_only`] gets its brief inline whenever the command line can carry it (no
//! file to read, so no bypass needed) plus `--sandbox`. It is still not a guarantee, and
//! [`AiEngine::enforces_read_only`] says so: the user's own settings can pre-approve writes
//! (`permission.allow`), and a brief too large for the command line needs the file, and with it the
//! bypass. `--mode plan` was considered and left out: the strings inside the binary show it is a
//! prompt ("DO NOT make any source code changes…"), not a gate, and it asks for plan artifacts
//! nobody here reads.
//!
//! **Sessions are resumed by id.** 1.1.7 gave a headless caller no conversation id — nothing
//! printed it and there was no `--output-format` to ask for it (google-antigravity/antigravity-cli#7)
//! — so every turn resumed "the most recent conversation" with `--continue`, and two chats (or two
//! agents) on one project resumed each other's context without a word. Since 1.1.10 the closing
//! `result` event carries `conversation_id`, and `--conversation <id>` ("Resume a previous
//! conversation by ID", in `agy --help` on 1.2.11 and 1.2.12) takes it back. [`interpret_output`]
//! hands that id to the caller as the session, and [`GeminiEngine::build_command`] resumes exactly
//! it.
//!
//! **Which versions get it is decided by evidence, not by a version string.** An id is used only
//! when the CLI printed one, and a CLI that printed none — a build old enough to ignore
//! `--output-format`, or a conversation whose stored session is still the [`SESSION_SENTINEL`] an
//! earlier CodeFlow wrote — keeps `--continue`, exactly as before. That is the only fallback that
//! can occur: a build older than 1.1.10 rejects `--output-format stream-json` outright, so it
//! never reaches a second turn here at all.

use tokio::process::Command;

use serde::Deserialize;
use crate::ai::{quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, AiUsage, QUOTA_MARKER};

const DEFAULT_BINARY: &str = "agy";

/// Let agy pick its own default model for commit messages — its ids (e.g. `gemini-3.6-flash-low`)
/// depend on the account's quota/availability, so hardcoding one risks pointing at something the
/// user's plan doesn't expose.
const COMMIT_MESSAGE_MODEL: &str = "";

/// Stand-in for a session id, for a run whose CLI did not print its conversation id (see the module
/// docs). It identifies nothing — its only job is to keep the app's chat state at "there is a
/// session" so the next turn passes *something*, which [`GeminiEngine::build_command`] turns into
/// `--continue`. Conversations stored by earlier builds hold it too, which is why it is still
/// recognised. Being a fixed string is why chat turns group under the app's own conversation id
/// and not this one (see `db::migrations`).
const SESSION_SENTINEL: &str = "agy-last";

/// Whether a stored session names a real agy conversation, rather than the sentinel.
fn is_conversation_id(session: &str) -> bool {
    let session = session.trim();
    !session.is_empty() && session != SESSION_SENTINEL
}

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

    fn supports_extra_dirs(&self) -> bool {
        true
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
        // The skills this CLI would not find by itself. It reads no stdin, so the default
        // `stdin_payload` that carries the note for other engines never reaches it — without this
        // line every skill synced for it was a folder nobody mentioned.
        if !inv.skills_note.is_empty() {
            brief.push_str("\n\n");
            brief.push_str(inv.skills_note.trim_end());
        }
        if !inv.stdin_content.trim().is_empty() {
            brief.push_str("\n\n----- INPUT -----\n\n");
            brief.push_str(inv.stdin_content);
        }

        // Deliver the prompt inline when the command line can carry it, else via a private file agy
        // is told to read. See [`delivery`] for which is which.
        let mut needs_read_permission = false;
        let file = match delivery(binary, &brief, inv.read_only) {
            Delivery::Inline => None,
            Delivery::File => write_brief(inv, &brief),
        };
        match file {
            Some((dir, file)) => {
                cmd.arg("-p").arg(format!(
                    "Read the file at {} and carry out the instructions it contains, replying with only the requested output.",
                    file.display()
                ));
                cmd.arg("--add-dir").arg(dir);
                needs_read_permission = true;
            }
            // Either it fits, or the file could not be written and an inline attempt is the better
            // of two bad outcomes.
            None => {
                cmd.arg("-p").arg(&brief);
            }
        }

        // One JSON event per line as the run happens, rather than a single blob at the end: the
        // app streams stdout into the run log, and plain `json` would leave it empty until the
        // process exits. The closing `result` event is what `interpret_output` reads.
        cmd.arg("--output-format").arg("stream-json");
        // Sanitised on the way out, not merely on the way in. [`parse_model_list`] stops the label
        // being *stored* from now on, but a setting written before that — or by an older build on
        // another machine — is already `<id>\t<label>` in the database, and nothing rewrites it. It
        // would then be handed to `--model` verbatim on every single turn, and the CLI refuses the
        // whole run: "model gemini-3.6-flash-high\tGemini 3.6 Flash (High) is not recognized". So
        // the id is taken here too, which repairs those installs without a migration and without
        // the user having to re-pick a model that looks correct in the dropdown.
        let model = model_id(inv.model);
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
        // Skip permission prompts when the flow may write (chat / fix) or when agy has to read the
        // temp brief file headlessly. A small read-only prompt needs neither.
        //
        // The second reason is the uncomfortable one, and it is why `--sandbox` follows. agy has no
        // narrow "you may read this one file" grant — its only two levers are this flag, which
        // auto-approves *every* tool request including `write_file` and the shell, and `--sandbox`.
        // So a run that only ever needed to read a temp brief ends up holding the same authority as
        // one that was asked to refactor a repository. That is tolerable when the caller opted into
        // writing; it is not what a read-only conversation was promised.
        //
        // A brief with a newline used to go to a file on every turn — and a system prompt joined to
        // a user message always has one — so every repo-less chat ran with the bypass. A read-only
        // run now keeps its brief inline wherever the command line can carry it (see [`delivery`]),
        // which leaves agy's own permission system in charge: in print mode it soft-denies what it
        // would have asked about. `--sandbox` takes the shell away on top, and is the only narrowing
        // agy offers for the one read-only case that still needs the bypass — a brief too large for
        // the command line. See [`AiEngine::enforces_read_only`] for why that is still not a
        // guarantee, which the UI says in so many words.
        let writes = inv.auto_approve_edits && !inv.read_only;
        if writes || needs_read_permission {
            cmd.arg("--dangerously-skip-permissions");
        }
        if !writes && (needs_read_permission || inv.read_only) {
            cmd.arg("--sandbox");
        }
        // Multi-turn chat: resume *this* conversation, by the id the previous turn reported. Only a
        // session with no id to be specific with — the sentinel — falls back to "the most recent
        // conversation", which is what could cross two chats on one project. See the module docs.
        match inv.resume_session_id {
            Some(id) if is_conversation_id(id) => {
                cmd.arg("--conversation").arg(id.trim());
            }
            Some(_) => {
                cmd.arg("--continue");
            }
            None => {}
        }
        if let Some(dir) = inv.cwd {
            cmd.current_dir(dir);
            // **And named to agy as a directory it may use**, which `current_dir` alone does not
            // do. `--add-dir` is what scopes this CLI's file access, and until now the only thing
            // in that scope was the temp folder holding the brief — so a turn asked for a PNG
            // wrote it *next to the brief*, in `/var/folders/.../codeflow-agy-…`, where nothing
            // looks for it and the OS eventually deletes it. The working directory has to be in
            // the scope for a file written there to be a file anybody sees.
            cmd.arg("--add-dir").arg(dir);
        }
        // And the run's other working copies, the same way (repeatable on agy 1.2.14).
        for dir in inv.extra_dirs {
            cmd.arg("--add-dir").arg(dir);
        }
        cmd
    }

    /// `agy --effort low|medium|high`, verified on the installed CLI. It has nothing above `high`,
    /// so `max` saturates there rather than being passed through — agy rejects the whole run on an
    /// unrecognised value, and losing a turn to a level that does not exist is a worse trade than
    /// thinking one step less hard than asked.
    fn effort_args(&self, effort: &str) -> Vec<String> {
        let level = if effort == crate::ai::effort::MAX { "high" } else { effort };
        vec!["--effort".into(), level.into()]
    }

    /// agy's levels are **model variants**, and it says so by refusing everything else (1.2.13/14,
    /// all refused before any model call): `--effort` on a listed id that names a level
    /// (`gemini-3.8-flash-high`) "conflicts", and on one with no variants (`claude-sonnet-4-6`,
    /// `claude-opus-4-6-thinking`) it "is not supported". What it takes is a family it lists
    /// variants of — `--model gemini-3.8-flash --effort high` runs as `gemini-3.8-flash-high`.
    ///
    /// So the answer is read off agy's own `models` listing rather than a list kept here: a family
    /// that ships tomorrow with `-low`/`-high` variants takes the dial the day agy lists it. With no
    /// listing seen yet this says no — a missing dial costs a control, a wrong one costs the run.
    fn model_supports_effort(&self, model: &str) -> bool {
        !variant_levels(model_id(model)).is_empty()
    }

    /// The level among the variants agy lists for this family — `gemini-3.1-pro` has `-high` and
    /// `-low` only, so `medium` runs as `low`.
    fn effort_args_for(&self, effort: &str, model: &str) -> Vec<String> {
        match crate::ai::fit_effort(effort, &variant_levels(model_id(model))) {
            Some(level) => vec!["--effort".into(), level],
            None => Vec::new(),
        }
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }

    /// A run that ended on a model error still closes with its `result` event — since 1.2.10 with
    /// exit code 3 and "the partial response" — and the usage in it was spent.
    fn reported_usage(&self, stdout: &str, _stderr: &str) -> Option<AiUsage> {
        result_event(stdout).and_then(|result| result.usage).map(usage_of)
    }

    fn list_models_args(&self) -> Option<Vec<String>> {
        Some(vec!["models".to_string()])
    }

    fn parse_models(&self, stdout: &str) -> Vec<String> {
        let models = parse_model_list(stdout);
        if let Ok(mut listed) = listing().lock() {
            *listed = models.clone();
        }
        models
    }
}

/// Pulls the id out of each line of `agy models`. Newer builds print `<id>\t<display label>`
/// (e.g. `gemini-3.6-flash-high\tGemini 3.6 Flash (High)`) rather than a bare id — the default
/// [`AiEngine::parse_models`] takes the whole trimmed line, so the label rode along into
/// `--model` and the CLI rejected it outright ("model … is not recognized as a known model").
/// An id never contains whitespace, so the first token of the line is always it, tab-separated
/// or not.
fn parse_model_list(stdout: &str) -> Vec<String> {
    stdout.lines().map(model_id).filter(|id| !id.is_empty()).map(str::to_string).collect()
}

/// The last `agy models` listing this process read — what [`variant_levels`] answers from.
fn listing() -> &'static std::sync::Mutex<Vec<String>> {
    static LISTING: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    LISTING.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

/// The levels agy lists variants of `family` at — `low`, `medium`, `high` for `gemini-3.8-flash`.
/// Empty for an id that already names its level and for one with no variants.
fn variant_levels(family: &str) -> Vec<String> {
    if family.is_empty() || crate::ai::pinned_effort(family).is_some() {
        return Vec::new();
    }
    let listed = listing().lock().map(|listed| listed.clone()).unwrap_or_default();
    levels_listed_for(family, &listed)
}

/// The pure half of [`variant_levels`]: the `<family>-<level>` ids among `listed`.
fn levels_listed_for(family: &str, listed: &[String]) -> Vec<String> {
    let prefix = format!("{family}-");
    listed
        .iter()
        .filter_map(|id| id.strip_prefix(&prefix))
        .filter(|level| matches!(*level, "minimal" | "low" | "medium" | "high" | "xhigh" | "max"))
        .map(str::to_string)
        .collect()
}

/// The id part of whatever a model setting holds.
///
/// One rule, used at both ends — where the list is read *and* where `--model` is built — because
/// the two ends are what disagreed: the parser started stripping the label, but every setting
/// stored before that still holds the whole `<id>\t<label>` line, and only the second end can save
/// those. An id never contains whitespace, so the first token is always it.
fn model_id(raw: &str) -> &str {
    raw.split_whitespace().next().unwrap_or("")
}

/// How a brief reaches agy.
#[derive(Debug, PartialEq, Eq)]
enum Delivery {
    /// As the `-p` argument itself.
    Inline,
    /// In a private file agy is told to read — which needs the permission bypass.
    File,
}

/// Which delivery a brief gets, on this program.
///
/// Too large for the command line always means a file. A single line always fits. A **multi-line**
/// brief is the case that decides read-only: it goes inline only for a read-only run, and only
/// when `program` is known not to be a batch shim (`.cmd`/`.bat`, whose `cmd.exe` layer rejects a
/// newline in an argument). Every other run keeps the file it has always had, and with it the
/// permission bypass its reads were verified with — a review is not the place to find out what
/// agy's default permissions refuse.
fn delivery(program: &str, brief: &str, read_only: bool) -> Delivery {
    if brief.len() > INLINE_LIMIT {
        return Delivery::File;
    }
    if !brief.contains('\n') || (read_only && !is_batch_shim(program)) {
        return Delivery::Inline;
    }
    Delivery::File
}

/// Whether `program` is run through `cmd.exe`. `program` is the resolved path, which on Windows
/// carries its extension (see `ai::resolve_binary`), so the extension is the whole answer.
fn is_batch_shim(program: &str) -> bool {
    let lower = program.trim().to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Writes the brief into a private directory of its own — so `--add-dir` scopes agy to exactly
/// this file and nothing else — and returns `(directory, file)`. Both go when the run ends. `None`
/// on a failed write, which degrades to an inline attempt rather than failing the call.
fn write_brief(inv: &AiInvocation, content: &str) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let dir = inv.prompt_files.dir("agy")?;
    let file = crate::ai_prompt_files::write_into(&dir, "brief.txt", content)?;
    Some((dir, file))
}

/// The closing `{"event":"result", …}` line of a `stream-json` run.
#[derive(Deserialize)]
struct AgyResult {
    #[serde(default)]
    response: String,
    /// The conversation this turn ran in — what the next turn resumes with `--conversation`.
    /// Printed since 1.1.10; absent from anything older, which then keeps `--continue`.
    #[serde(default)]
    conversation_id: Option<String>,
    #[serde(default)]
    usage: Option<AgyUsage>,
}

/// One `result` event's usage, in this app's terms.
fn usage_of(u: AgyUsage) -> AiUsage {
    AiUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens + u.thinking_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: 0,
        // agy prices nothing. `None` and not `0.0`: the meter shows "no price" for this engine
        // rather than claiming its turns were free.
        cost_usd: None,
    }
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
    let generated = parsed.as_ref().and_then(|result| result.usage.as_ref()).map(|u| u.output_tokens + u.thinking_tokens);
    if refusal_reply(&text, generated) {
        return Err(format!("{QUOTA_MARKER}{text}"));
    }
    // The real conversation when the CLI named it, the sentinel when it did not — the evidence that
    // decides between `--conversation` and `--continue` next turn. See the module docs.
    let session_id = parsed
        .as_ref()
        .and_then(|result| result.conversation_id.as_deref())
        .map(str::trim)
        .filter(|id| is_conversation_id(id))
        .unwrap_or(SESSION_SENTINEL)
        .to_string();
    let usage = parsed.and_then(|result| result.usage).map(usage_of);
    Ok(AiRun {
        text,
        session_id: Some(session_id),
        model: None,
        usage: usage.filter(|u| !u.is_empty()),
        // `None`: this app does not read this CLI's output step by step, so it has no
        // figure for the *final* prompt — only a cumulative total, which is a bill and not a
        // gauge. The chat's context meter estimates instead, and says so.
        context_tokens: None,
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
    fn small_single_line_prompts_stay_inline() {
        assert_eq!(delivery("agy", "hola", false), Delivery::Inline);
    }

    /// A brief under `INLINE_LIMIT` still moves to a file once it has a newline — the module docs
    /// explain why this engine doesn't bet on `agy` always resolving to a native binary.
    #[test]
    fn a_short_multiline_brief_still_moves_to_a_file() {
        assert_eq!(delivery("agy", "system prompt\n\nthe ask", false), Delivery::File);
    }

    fn args_of(inv: &AiInvocation, program: &str) -> Vec<String> {
        GeminiEngine
            .build_command(program, inv)
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    /// The whole point of the read-only path: a chat turn's brief — a system prompt joined to a
    /// message, so always multi-line — rides the command line, and with no file to read there is no
    /// permission bypass. agy's print mode then soft-denies what it would have asked about.
    #[test]
    fn a_read_only_turn_needs_no_permission_bypass() {
        let mut inv = AiInvocation::new("¿qué es esto?", "");
        inv.system_prompt = Some("Eres un asistente.\nResponde en texto.");
        inv.read_only = true;
        let args = args_of(&inv, "/usr/local/bin/agy");
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions"), "{args:?}");
        assert!(args.iter().any(|a| a == "--sandbox"), "{args:?}");
        let prompt = &args[args.iter().position(|a| a == "-p").unwrap() + 1];
        assert!(prompt.contains("Responde en texto."), "the brief itself, not a pointer: {prompt}");
    }

    /// agy reads no stdin either, so the skills note belongs in the brief it is handed.
    #[test]
    fn the_skills_note_rides_the_brief() {
        let mut inv = AiInvocation::new("¿qué es esto?", "");
        inv.skills_note = "=== SKILLS DISPONIBLES ===\n.claude/skills/pdf/SKILL.md — PDFs\n".to_string();
        inv.read_only = true;
        let args = args_of(&inv, "/usr/local/bin/agy");
        let prompt = &args[args.iter().position(|a| a == "-p").unwrap() + 1];
        assert!(prompt.contains(".claude/skills/pdf/SKILL.md"), "{prompt}");
    }

    /// Where the command line cannot carry it — a batch shim, or a brief past the limit — the file
    /// and the bypass come back, with the sandbox. That is why agy is not reported as enforcing.
    #[test]
    fn a_read_only_brief_that_cannot_go_inline_keeps_the_sandbox() {
        assert_eq!(delivery(r"C:\npm\agy.cmd", "a\nb", true), Delivery::File);
        assert_eq!(delivery("agy", &"x".repeat(INLINE_LIMIT + 1), true), Delivery::File);

        let mut inv = AiInvocation::new("pregunta", "");
        inv.system_prompt = Some("uno\ndos");
        inv.read_only = true;
        let args = args_of(&inv, r"C:\npm\agy.cmd");
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"), "{args:?}");
        assert!(args.iter().any(|a| a == "--sandbox"), "{args:?}");
        assert!(!GeminiEngine.enforces_read_only());
    }

    /// A run that may write is exactly what it was: the bypass, and no sandbox in its way.
    #[test]
    fn a_writing_run_is_unchanged() {
        let mut inv = AiInvocation::new("corrige", "");
        inv.auto_approve_edits = true;
        let args = args_of(&inv, "agy");
        assert!(args.iter().any(|a| a == "--dangerously-skip-permissions"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--sandbox"), "{args:?}");
    }

    /// The brief file is private, scoped by `--add-dir` to its own directory, and gone with the run.
    #[test]
    fn the_brief_file_goes_with_the_invocation() {
        let mut inv = AiInvocation::new("pregunta", "");
        inv.system_prompt = Some("uno\ndos");
        let args = args_of(&inv, "agy");
        let dir = std::path::PathBuf::from(&args[args.iter().position(|a| a == "--add-dir").unwrap() + 1]);
        assert!(dir.join("brief.txt").exists());
        drop(inv);
        assert!(!dir.exists());
    }

    /// Captured from `agy -p … --output-format stream-json` on 1.1.10: the closing event names the
    /// conversation, and that is the session from now on.
    #[test]
    fn the_conversation_id_is_the_session() {
        let run = interpret_output(true, "exit status: 0", STREAM, "").unwrap();
        assert_eq!(run.session_id.as_deref(), Some("c8bb"));
    }

    /// Resumed by id — never "the most recent conversation", which is what crossed two chats.
    #[test]
    fn a_turn_resumes_its_own_conversation() {
        let mut inv = AiInvocation::new("¿y ahora?", "");
        inv.resume_session_id = Some("c8bb");
        let args = args_of(&inv, "agy");
        assert!(args.windows(2).any(|pair| pair == ["--conversation", "c8bb"]), "{args:?}");
        assert!(!args.iter().any(|a| a == "--continue"), "{args:?}");
    }

    /// The fallback: a session stored by an earlier build, or reported by a CLI that printed no id,
    /// is the sentinel — and keeps `--continue`, as before.
    #[test]
    fn the_sentinel_still_continues() {
        let mut inv = AiInvocation::new("¿y ahora?", "");
        inv.resume_session_id = Some(SESSION_SENTINEL);
        let args = args_of(&inv, "agy");
        assert!(args.iter().any(|a| a == "--continue"), "{args:?}");
        assert!(!args.iter().any(|a| a == "--conversation"), "{args:?}");
    }

    #[test]
    fn a_failed_run_still_reports_what_it_spent() {
        let usage = GeminiEngine.reported_usage(STREAM, "").expect("the result event carries usage");
        assert_eq!(usage.output_tokens, 20);
        assert!(GeminiEngine.reported_usage("", "boom").is_none());
    }

    /// Captured verbatim from a failing run: `agy models` handed back `id\tlabel` pairs, and the
    /// whole line was stored as the model id, so `--model` broke with "not recognized as a known
    /// model or custom model in settings".
    #[test]
    fn strips_the_display_label_off_a_tab_separated_listing() {
        let out = "gemini-3.6-flash-high\tGemini 3.6 Flash (High)\ngemini-3.6-flash\tGemini 3.6 Flash";
        assert_eq!(parse_model_list(out), vec!["gemini-3.6-flash-high", "gemini-3.6-flash"]);
    }

    #[test]
    fn a_bare_id_per_line_still_works() {
        assert_eq!(parse_model_list("gemini-3.6-flash-high\ngemini-3.6-flash"), vec![
            "gemini-3.6-flash-high",
            "gemini-3.6-flash"
        ]);
    }

    /// The half the listing fix could not reach: a setting written *before* it, which is still
    /// `<id>\t<label>` in the database and is read straight out of it on every turn. Sanitising the
    /// listing alone left those installs failing every single run with "invalid model selection",
    /// and no amount of re-picking in the dropdown fixed it, because the dropdown looked right.
    #[test]
    fn an_already_stored_label_never_reaches_the_model_flag() {
        assert_eq!(model_id("gemini-3.6-flash-high\tGemini 3.6 Flash (High)"), "gemini-3.6-flash-high");
        assert_eq!(model_id("gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)"), "gemini-3.6-flash-medium");
        // A clean id is left exactly as it is, and a blank stays blank so the caller omits the flag
        // and lets the CLI pick for itself.
        assert_eq!(model_id("gemini-3.1-pro-high"), "gemini-3.1-pro-high");
        assert_eq!(model_id("   "), "");
        assert_eq!(model_id(""), "");
    }

    /// `agy models` on 1.2.13, ids only.
    const AGY_LISTING: [&str; 14] = [
        "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
        "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
        "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
        "gemini-3.1-pro-high", "gemini-3.1-pro-low",
        "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
    ];

    /// What agy 1.2.13/14 accepted and refused, all before calling a model: a listed id never takes
    /// `--effort` (its level is in the name, or it has none); a family it lists variants of does.
    #[test]
    fn effort_is_offered_only_on_a_family_agy_lists_levels_of() {
        let listed: Vec<String> = AGY_LISTING.iter().map(|id| id.to_string()).collect();
        for id in AGY_LISTING {
            let family_levels = if crate::ai::pinned_effort(id).is_some() { Vec::new() } else { levels_listed_for(id, &listed) };
            assert!(family_levels.is_empty(), "{id} is listed as it is and takes no --effort");
        }
        assert_eq!(levels_listed_for("gemini-3.8-flash", &listed), ["high", "medium", "low"]);
        assert_eq!(levels_listed_for("gemini-3.1-pro", &listed), ["high", "low"]);
        assert!(levels_listed_for("claude-opus-4-6", &listed).is_empty(), "-thinking is not a level agy takes");
        let pro = levels_listed_for("gemini-3.1-pro", &listed);
        assert_eq!(crate::ai::fit_effort("medium", &pro).as_deref(), Some("low"));
        assert_eq!(crate::ai::fit_effort("max", &pro).as_deref(), Some("high"));
    }
}
