//! The Cline CLI engine — the app's local-model provider, and the one that can also *change* files.
//!
//! This replaces the direct Ollama HTTP engine that used to sit here. The reason is a capability,
//! not a preference: `POST /api/chat` is a completion endpoint, so the old engine could draft a
//! commit message but could never open a file, grep the repo or apply a fix — "fix with AI", chat
//! with tools and the agent chains were all hidden whenever a local model was selected. Cline is a
//! headless coding agent that *drives* a model, so the same local model reached through
//! `cline -P ollama` gets the whole feature set. Nothing about local inference is given up: the
//! model still runs on the user's machine, and pointing Cline at any of its other providers
//! (`cline`, `openai`, `anthropic`, …) is one `cline auth` away.
//!
//! Everything below was verified against **cline 3.0.55** — its `--help`, its bundled entry point,
//! and live runs against `-P ollama`. Four findings shape this module:
//!
//!   1. **The prompt is argv-only.** The CLI's own option parser sets the prompt from
//!      `program.args.join(" ")` and never reads stdin, despite what its error message
//!      ("requires a prompt argument or piped stdin") suggests — piping was tried both ways and
//!      refused. So [`AiEngine::stdin_payload`] is empty and the whole brief travels as one
//!      argument. It must be *exactly one* argument and must contain whitespace, or the CLI
//!      rejects it as "Unknown command or unquoted prompt".
//!   2. **On Windows that argument can't hold the brief**, for the same reason it can't for
//!      opencode: an npm install lands as `cline.cmd`, cmd.exe refuses arguments containing a
//!      newline, and every template here is multi-paragraph. There the brief goes to a temp file
//!      and the argument becomes a one-line pointer to it — Cline reads it with its own file tool.
//!      See [`needs_file_handoff`].
//!   3. **There is no headless resume.** `--id` exists, but the entry point turns any run carrying
//!      it into an interactive TUI session (and JSON mode then refuses outright, since it has no
//!      prompt). Nor does the JSON stream report an id that could be resumed later. So
//!      [`AiEngine::resumes_sessions`] is false and chat re-sends its context every turn, exactly
//!      as the old local engine did.
//!   4. **`--system` replaces Cline's own system prompt** rather than appending to it, which would
//!      throw away the agent's tool instructions. Our system prompts are therefore folded into the
//!      brief instead — the flag is never passed.
//!
//! **Write access is the mode, not a tool list.** `cline run` has no allow-list flag; what it has
//! is act mode against plan mode. Plan mode keeps the read tools (`read_files`, `search_codebase`,
//! read-only `run_commands`) and hard-blocks every mutation — file edits are unavailable and
//! mutating commands return a tool error instead of running. That is the closest match to Claude
//! Code's default vs `acceptEdits`, so [`AiInvocation::auto_approve_edits`] picks between them.
//! One caveat, stated because it is a real hole rather than a theoretical one: plan mode offers the
//! model a `switch_to_act_mode` tool, and a headless run treats the switch as approved. A model
//! that decides mid-review to start editing therefore can, so the mode is a strong default and not
//! a sandbox. The flows that must not write also never *ask* for changes.
//!
//! The text-in/text-out operations pass no working directory at all, and they get plan mode as
//! well — measured, not assumed: act mode answers them more cleanly when it answers in one shot,
//! and spirals into an editor loop when it does not. They are given an empty scratch directory so
//! that "no repository" is what the run actually sees. See `build_command`.

use serde::Deserialize;
use tokio::process::Command;

use crate::ai::{
    quota_signal, refusal_reply, AiEngine, AiInvocation, AiRun, AiUsage, ModelListing, QUOTA_MARKER,
};

const DEFAULT_BINARY: &str = "cline";

/// No dedicated fast model. Which models exist depends entirely on the provider the user
/// authenticated inside Cline, so naming one here would be a guess that fails for everyone who
/// chose differently — the caller falls back to the configured base model.
const COMMIT_MESSAGE_MODEL: &str = "";

/// Single-line, ASCII, shim-safe stand-in for a brief that can't be passed as an argument — same
/// device as `claude.rs`'s `PROMPT_POINTER` and `opencode.rs`'s attachment message, except that
/// here the *model* opens the file rather than the CLI. It has whitespace in it, which the CLI's
/// "is this a prompt or a mistyped subcommand" check requires.
const FILE_POINTER: &str =
    "Read the file at this exact path with your file tool: it holds your complete instructions and \
     the input for this turn. Follow them exactly and reply with only the requested output. Path: ";

/// Above this many characters the brief goes to a file even on the platforms that would accept it
/// inline. Well under the ~1 MB `ARG_MAX` every Unix gives us (the largest brief this app builds is
/// a review chunk, capped at 120 000 characters plus its templates), so this is a guard against an
/// unforeseen caller rather than a limit anything hits today.
const MAX_INLINE_PROMPT_CHARS: usize = 200_000;

pub struct ClineEngine;

impl AiEngine for ClineEngine {
    fn id(&self) -> &'static str {
        "cline"
    }

    fn label(&self) -> &'static str {
        "Cline"
    }

    fn default_binary(&self) -> &'static str {
        DEFAULT_BINARY
    }

    fn commit_message_model(&self) -> &'static str {
        COMMIT_MESSAGE_MODEL
    }

    fn fix_tools(&self) -> Vec<String> {
        // Cline's own model-facing tool names, for documentation and parity with the other engines.
        // NOT passed to the CLI: there is no allow-list flag (see the module docs — access is
        // governed by act/plan mode), so these are never on a command line.
        ["read_files", "apply_patch", "run_commands", "search_codebase"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    /// Nothing. The CLI ignores its stdin entirely (see the module docs), so the default — which
    /// would push the whole diff into a pipe no one drains — would be bytes written for nobody.
    fn stdin_payload(&self, _inv: &AiInvocation) -> String {
        String::new()
    }

    fn build_command(&self, binary: &str, inv: &AiInvocation) -> Command {
        let mut cmd = crate::proc::command(binary);

        // Structured events, one JSON object per line, instead of the styled transcript. The final
        // `run_result` line is what `interpret` reads: it carries the reply, the token usage and
        // the model that actually answered.
        cmd.arg("--json");

        // Act mode is the default; `--plan` is what makes a run read-only. Paired with
        // `--auto-approve true` in both cases — a headless run has no terminal to answer a
        // permission prompt on, so the alternative isn't "safer", it's "no tools at all", which
        // would leave a reviewer unable to open the file it is reviewing.
        //
        // **A text-only run gets plan mode too, and this was measured rather than reasoned.** The
        // text-in/text-out operations — the inline edit, a described diagram, generated stories —
        // pass no working directory, and act mode looked better for them at first: plan mode's
        // system prompt asks for a structured plan where the prompt asked for a JSON object, and a
        // local qwen2.5:7b duly answered "El diagrama es el siguiente: ```json … ```". But that
        // prose wrapper is cheap to read past (`ai::draw_diagram` extracts the object), while what
        // act mode does instead is not: the same brief, six runs, went to seven iterations with five
        // `editor` calls and a file written to disk. Plan mode cannot do that — the editor tools are
        // unavailable to it — so it stays, and the answer is unwrapped on our side.
        if !inv.auto_approve_edits {
            cmd.arg("--plan");
        }
        cmd.arg("--auto-approve").arg("true");

        // **Always a working directory, even when the invocation has none.** Without `--cwd` the
        // CLI takes the app's own, so a text-only run would be pointed at whatever CodeFlow happens
        // to be started from. An empty scratch directory says the truth instead: this operation has
        // no repository. If one cannot be made, the invocation's own (absent) directory is left to
        // the CLI rather than failing the run over a temp directory.
        match (inv.cwd, scratch_dir()) {
            (Some(dir), _) => {
                cmd.arg("--cwd").arg(dir);
            }
            (None, Some(scratch)) => {
                cmd.arg("--cwd").arg(scratch);
            }
            (None, None) => {}
        }

        // Models are addressed as `provider/model` (see [`split_model`]); a bare id leaves the
        // provider to Cline's own configuration.
        let (provider, model) = split_model(inv.model);
        if let Some(provider) = provider {
            cmd.arg("--provider").arg(provider);
        }
        if !model.is_empty() {
            cmd.arg("--model").arg(model);
        }
        // The prompt is positional and goes last, after every flag — the order a live run was
        // verified with. Exactly one argument: a second one is read as a mistyped subcommand.
        cmd.arg(prompt_argument(&brief(inv)));
        cmd
    }

    fn interpret(&self, success: bool, status_label: &str, stdout: &str, stderr: &str) -> Result<AiRun, String> {
        interpret_output(success, status_label, stdout, stderr)
    }

    /// A turn that came back with nothing in it is worth asking again.
    ///
    /// Measured rather than assumed, on the run that prompted it: the same brief against
    /// `ollama/qwen2.5:7b-instruct`, six times, came back empty twice — the model produced an
    /// assistant message with no text and no tool call, which Cline reports as an error. Nothing
    /// about the request is wrong, and the second attempt is the remedy a person would apply
    /// themselves. Small local models are the ones this happens to, and they are also the ones a
    /// second attempt is cheapest for.
    ///
    /// Matched on the rewritten message rather than on Cline's own, because [`interpret`] has
    /// already turned it into ours by the time this is asked.
    fn retry_once_on(&self, error: &str) -> bool {
        empty_answer_hint(error).is_some() || error == EMPTY_ANSWER_MESSAGE
    }

    /// Cline keeps no server-side conversation a later run could pick up: `--id` forces the
    /// interactive TUI, and the JSON stream reports no resumable id. Chat therefore re-sends its
    /// system prompt and project context on every turn instead of only the first.
    fn resumes_sessions(&self) -> bool {
        false
    }

    /// Asked of the providers themselves, not of a process: Cline has no `models` subcommand, and
    /// `cline config --json` marks the run interactive and so refuses without a TTY. See the
    /// section below for where the list actually comes from.
    fn fetch_models(&self) -> Option<ModelListing> {
        Some(Box::pin(list_models()))
    }
}

/// Splits a stored model id into the provider and the model Cline should be given.
///
/// The `provider/model` shape is opencode's, for the same reason: which models exist depends on
/// what the user configured *inside* the CLI, so the provider has to travel with the id. The split
/// is on the **first** separator only, because a provider id never contains one while a model id
/// routinely does — Cline's own hosted catalog addresses models as `dots-studio/dots-3-note:free`,
/// and splitting greedily would hand `-P dots-studio` to a CLI that has never heard of it.
///
/// No separator means no `--provider` flag: the id goes through as-is and Cline picks the provider,
/// which is what a user who typed a bare model name meant.
fn split_model(model: &str) -> (Option<&str>, &str) {
    let model = model.trim();
    match model.split_once('/') {
        Some((provider, rest)) if !provider.is_empty() && !rest.is_empty() => (Some(provider), rest),
        _ => (None, model),
    }
}

/// The full brief for one turn: system instructions, the ask, then the data — the same order
/// opencode's attachment uses, so the ask reads as the instruction and the payload as its input.
fn brief(inv: &AiInvocation) -> String {
    let mut brief = String::new();
    if let Some(system) = inv.system_prompt {
        if !system.trim().is_empty() {
            brief.push_str(system);
            brief.push_str("\n\n");
        }
    }
    brief.push_str(inv.prompt);
    if !inv.skills_note.is_empty() || !inv.stdin_content.trim().is_empty() {
        brief.push_str("\n\n----- INPUT -----\n\n");
        brief.push_str(&inv.skills_note);
        brief.push_str(inv.stdin_content);
    }
    brief
}

/// Whether this brief has to be handed over as a file rather than as an argument. See the module
/// docs: on Windows the npm `.cmd` shim runs through cmd.exe, which rejects any argument containing
/// a newline — and every brief this app builds has one.
fn needs_file_handoff(brief: &str) -> bool {
    cfg!(windows) || brief.chars().count() > MAX_INLINE_PROMPT_CHARS
}

/// The single positional argument to pass: the brief itself where that works, and a one-line
/// pointer to a temp file where it doesn't.
///
/// A failed temp write falls back to the inline brief. That is the *worse* of the two paths on the
/// platform that needed the file — but a run that is likely to fail beats one that certainly does.
fn prompt_argument(brief: &str) -> String {
    if !needs_file_handoff(brief) {
        return brief.to_string();
    }
    match write_brief_file(brief) {
        Some(path) => format!("{FILE_POINTER}{}", path.to_string_lossy()),
        None => brief.to_string(),
    }
}

/// An empty directory for a run that has no repository — see [`AiEngine::build_command`].
///
/// Fresh per run rather than one shared scratch: two operations running at once would otherwise
/// share a working directory, and a file one of them wrote would be sitting there for the other to
/// find. Left for the OS to reap, like the brief files above; it is an empty directory.
fn scratch_dir() -> Option<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("codeflow-cline-scratch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).ok().map(|_| path)
}

/// Writes the brief where the model can read it. Uniquely named per run; not cleaned up, matching
/// `opencode.rs` — a temp file whose deletion raced the child reading it would be worse than one
/// the OS reaps later.
fn write_brief_file(content: &str) -> Option<std::path::PathBuf> {
    let path = std::env::temp_dir().join(format!("codeflow-cline-{}.md", uuid::Uuid::new_v4()));
    std::fs::write(&path, content).ok().map(|_| path)
}

// ---------------------------------------------------------------------------
// Which models the picker offers
// ---------------------------------------------------------------------------
//
// **Two sources, and neither one alone is the answer.**
//
// `~/.cline/data/settings/models.json` is written by `cline auth`. It is authoritative about *which
// providers are configured* — their ids, and the URL each one lists its models at — and it is the
// only place that is written down. What it is *not* is a list of models: it records the single one
// chosen at auth time. Reading it as a catalog is why this picker offered three models the user did
// not have and hid the one they did.
//
// The models come from the provider, at the `modelsSourceUrl` the catalog names. That is where
// Cline's own picker gets them, so the two agree — and for a local Ollama it is a request to
// `localhost` that costs nothing and needs no credential.
//
// **Unauthenticated, on purpose.** `providers.json` sits next to the catalog with the tokens in it,
// mode 600. Nothing here opens it: spending a credential this app does not own is the rule
// `ai_quota` is built on, and a hosted provider that answers 401 simply falls back to what the
// catalog recorded. The case this feature exists for — a local model server — needs no key at all.

/// Where `cline auth` records the providers it has configured.
fn models_catalog_path() -> Option<std::path::PathBuf> {
    Some(dirs::home_dir()?.join(".cline").join("data").join("settings").join("models.json"))
}

/// How long a provider gets to answer. Short deliberately: this is a dropdown opening, and a model
/// server that has gone away must not hold the Settings pane while it times out at TCP's pace.
const LISTING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// `{"providers": {"ollama": {"provider": {"modelsSourceUrl": …}, "models": {"<id>": {…}}}}}`.
#[derive(Deserialize)]
struct ModelsCatalog {
    #[serde(default)]
    providers: std::collections::BTreeMap<String, CatalogEntry>,
}

#[derive(Deserialize)]
struct CatalogEntry {
    #[serde(default)]
    models: std::collections::BTreeMap<String, serde_json::Value>,
    #[serde(default)]
    provider: Option<CatalogProviderInfo>,
}

#[derive(Deserialize)]
struct CatalogProviderInfo {
    #[serde(rename = "defaultModelId", default)]
    default_model_id: Option<String>,
    #[serde(rename = "modelsSourceUrl", default)]
    models_source_url: Option<String>,
}

/// One provider Cline is configured against.
struct ConfiguredProvider {
    /// The id `-P` takes, and the prefix every one of its models is addressed with.
    id: String,
    /// Where it lists what it serves, when it says.
    source_url: Option<String>,
    /// What the catalog itself recorded — the fallback when the provider can't be reached.
    known: Vec<String>,
}

/// The providers named in the catalog. Empty for an install that has never run `cline auth`.
fn parse_catalog(raw: &str) -> Vec<ConfiguredProvider> {
    let Ok(catalog) = serde_json::from_str::<ModelsCatalog>(raw) else {
        return Vec::new();
    };
    catalog
        .providers
        .into_iter()
        .map(|(id, entry)| {
            let info = entry.provider;
            // The default is included alongside the enumerated ones: it is the model `cline auth`
            // recorded, and it is not always among them.
            let default = info.as_ref().and_then(|p| p.default_model_id.clone());
            let mut known: Vec<String> = Vec::new();
            for model in entry.models.into_keys().chain(default) {
                let model = model.trim().to_string();
                if !model.is_empty() && !known.contains(&model) {
                    known.push(model);
                }
            }
            ConfiguredProvider { id, source_url: info.and_then(|p| p.models_source_url), known }
        })
        .collect()
}

/// Model ids out of a listing response, whatever shape it arrived in.
///
/// Cline can be pointed at providers that disagree on every name in the envelope: Ollama's
/// `/api/tags` answers `{"models":[{"name":…}]}`, an OpenAI-compatible `/v1/models` answers
/// `{"data":[{"id":…}]}`, and some answer a bare array. Reading all of them is a few lines here and
/// the difference between a populated picker and an empty one, so nothing is assumed about which
/// provider is on the other end.
fn model_ids(body: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let items = match &value {
        serde_json::Value::Array(items) => items.as_slice(),
        serde_json::Value::Object(map) => map
            .get("models")
            .or_else(|| map.get("data"))
            .and_then(serde_json::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default(),
        _ => &[],
    };
    items
        .iter()
        .filter_map(|item| match item {
            serde_json::Value::String(id) => Some(id.clone()),
            // `id` before `name` before `model`: an OpenAI-compatible listing carries the usable id
            // in `id` and a display name in `name`, while Ollama has no `id` at all.
            serde_json::Value::Object(map) => ["id", "name", "model"]
                .iter()
                .find_map(|key| map.get(*key).and_then(serde_json::Value::as_str))
                .map(str::to_string),
            _ => None,
        })
        .filter(|id| !id.trim().is_empty())
        .collect()
}

/// One provider's models as the app addresses them — `provider/model`, the exact string
/// [`split_model`] takes back apart. `listed` is what the provider answered; what the catalog knew
/// is appended, so a model recorded at auth time never disappears from the picker just because a
/// listing endpoint omitted it.
fn qualify(provider: &ConfiguredProvider, listed: Vec<String>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for model in listed.into_iter().chain(provider.known.iter().cloned()) {
        let id = format!("{}/{}", provider.id, model.trim());
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

/// One client for the process, cloned per call — same reasoning as [`crate::openai::client`].
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// What one provider is serving right now. Empty on any failure — unreachable, unauthenticated,
/// nonsense body — because the caller's answer to all three is the same: fall back to the catalog.
async fn fetch_listing(url: &str) -> Vec<String> {
    let Ok(response) = client().get(url).timeout(LISTING_TIMEOUT).send().await else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    response.text().await.map(|body| model_ids(&body)).unwrap_or_default()
}

/// Every model the picker can offer, across every provider `cline auth` has configured.
async fn list_models() -> Vec<String> {
    let Some(raw) = models_catalog_path().and_then(|path| std::fs::read_to_string(path).ok()) else {
        return Vec::new();
    };
    let providers = parse_catalog(&raw);
    // Concurrently: one slow provider should not decide how long the whole dropdown takes.
    let listings = futures_util::future::join_all(providers.iter().map(|provider| async move {
        match &provider.source_url {
            Some(url) => fetch_listing(url).await,
            None => Vec::new(),
        }
    }))
    .await;
    providers.iter().zip(listings).flat_map(|(provider, listed)| qualify(provider, listed)).collect()
}

/// The final `run_result` line of a JSON-mode run.
#[derive(Deserialize)]
struct RunResult {
    #[serde(rename = "finishReason", default)]
    finish_reason: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    usage: Option<RunUsage>,
    #[serde(default)]
    model: Option<RunModel>,
}

#[derive(Deserialize)]
struct RunUsage {
    #[serde(rename = "inputTokens", default)]
    input_tokens: i64,
    #[serde(rename = "outputTokens", default)]
    output_tokens: i64,
    #[serde(rename = "cacheReadTokens", default)]
    cache_read_tokens: i64,
    #[serde(rename = "cacheWriteTokens", default)]
    cache_write_tokens: i64,
    #[serde(rename = "totalCost", default)]
    total_cost: f64,
}

#[derive(Deserialize)]
struct RunModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    provider: String,
}

/// A CLI-level failure line: `{"type":"error","message":"…"}`, emitted on stderr (and on stdout for
/// the ones raised before the agent starts).
#[derive(Deserialize)]
struct ErrorLine {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    message: String,
}

/// The last `run_result` in a stream. Last rather than first because a resumed/continued run — plan
/// mode switching to act — emits one per segment, and the one that describes how the turn *ended*
/// is the final one.
fn parse_run_result(stdout: &str) -> Option<RunResult> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{') && line.contains("\"run_result\""))
        .filter_map(|line| serde_json::from_str::<RunResult>(line).ok())
        .next_back()
}

/// The **last** `{"type":"error"}` message in a buffer.
///
/// Last, not first: a failing run emits its real cause after whatever incidental complaint came
/// first — a live failure printed `hook dispatch failed: session.hook requires a valid hook event
/// payload` and *then* `model 'x' not found`, and reporting the hook noise would have sent the user
/// looking in the wrong place.
fn parse_error_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| line.starts_with('{'))
        .filter_map(|line| serde_json::from_str::<ErrorLine>(line).ok())
        .filter(|error| error.kind == "error")
        .map(|error| error.message.trim().to_string())
        .filter(|message| !message.is_empty())
        .next_back()
}

fn usage_of(result: &RunResult) -> Option<AiUsage> {
    let reported = result.usage.as_ref()?;
    let usage = AiUsage {
        input_tokens: reported.input_tokens,
        output_tokens: reported.output_tokens,
        cache_read_tokens: reported.cache_read_tokens,
        cache_write_tokens: reported.cache_write_tokens,
        // Cline always writes a number, so — as with opencode — a zero here is a real zero: a local
        // model genuinely cost nothing, which is a different fact from a CLI that never said.
        cost_usd: Some(reported.total_cost),
    };
    (!usage.is_empty()).then_some(usage)
}

/// What answered, in the same `provider/model` shape the setting is stored in, so the chat's
/// "what am I talking to" chip and the usage meter agree with the picker.
fn model_of(result: &RunResult) -> Option<String> {
    let model = result.model.as_ref()?;
    let id = model.id.trim();
    if id.is_empty() {
        return None;
    }
    let provider = model.provider.trim();
    Some(if provider.is_empty() { id.to_string() } else { format!("{provider}/{id}") })
}

/// Turns one finished `cline --json` run into its reply or a user-facing error.
///
/// The `run_result` line is authoritative in both directions: on failure its `text` *is* the error
/// (`model 'x' not found`), which is why it is consulted before the exit status and before stderr.
fn interpret_output(
    success: bool,
    status_label: &str,
    stdout: &str,
    stderr: &str,
) -> Result<AiRun, String> {
    if let Some(result) = parse_run_result(stdout) {
        let text = result.text.trim().to_string();
        if result.finish_reason != "completed" {
            let detail = [text.as_str(), parse_error_line(stderr).unwrap_or_default().as_str(), stderr.trim()]
                .into_iter()
                .find(|s| !s.is_empty())
                .unwrap_or("sin detalle")
                .to_string();
            if quota_signal(&detail) {
                return Err(format!("{QUOTA_MARKER}{detail}"));
            }
            return Err(empty_answer_hint(&detail)
                .unwrap_or_else(|| format!("cline terminó con '{}': {detail}", result.finish_reason)));
        }
        if text.is_empty() {
            return Err("cline no devolvió contenido".to_string());
        }
        if refusal_reply(&text) {
            return Err(format!("{QUOTA_MARKER}{text}"));
        }
        return Ok(AiRun {
            usage: usage_of(&result),
            model: model_of(&result),
            text,
            // No resumable session exists to report — see the module docs.
            session_id: None,
        });
    }

    // No `run_result` at all: the CLI failed before the agent ever started (a bad flag, a prompt it
    // refused to parse), which it reports as a single error line.
    let detail = parse_error_line(stderr)
        .or_else(|| parse_error_line(stdout))
        .or_else(|| nonblank(stderr))
        .or_else(|| nonblank(stdout));
    let Some(detail) = detail else {
        return Err(match success {
            true => "cline no devolvió contenido".to_string(),
            false => format!("cline falló ({status_label}) sin salida en stdout ni stderr"),
        });
    };
    if quota_signal(&detail) {
        return Err(format!("{QUOTA_MARKER}{detail}"));
    }
    Err(format!("cline falló ({status_label}): {detail}"))
}

/// Rewrites "the provider answered with nothing" into something a person can act on.
///
/// Cline raises this when an assistant turn comes back with zero content parts — no text and no
/// tool call — which is a *model* failure, not a broken install or a bad flag. It is common enough
/// with small local models to deserve its own wording: the raw `cline terminó con 'error': Model
/// returned empty response` reads like the app crashed, when the honest answer is "that one came
/// back blank, ask again". Same device as `opencode.rs`'s stale-session hint.
fn empty_answer_hint(detail: &str) -> Option<String> {
    let empty = detail.contains("Model returned empty response") || detail.contains("Model stream failed");
    empty.then(|| EMPTY_ANSWER_MESSAGE.to_string())
}

/// What the user is told when both attempts came back empty. A constant because
/// [`ClineEngine::retry_once_on`] has to recognise it: by the time the retry decision is made, the
/// engine's own words have already been replaced by these.
const EMPTY_ANSWER_MESSAGE: &str =
    "El modelo no devolvió ninguna respuesta, ni al reintentarlo. Con modelos locales pequeños \
     pasa de vez en cuando: vuelve a intentarlo, o usa un modelo más grande para esta tarea.";

fn nonblank(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from a live `cline --json -P ollama` run: the events this module skips, then the
    /// `run_result` it reads.
    const COMPLETED: &str = concat!(
        r#"{"ts":"2026-08-16T20:20:21.320Z","type":"hook_event","hookEventName":"agent_start","agentId":"agent_1","taskId":"conv_1"}"#,
        "\n",
        r#"{"ts":"2026-08-16T20:20:21.325Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}"#,
        "\n",
        r#"{"ts":"2026-08-16T20:20:53.162Z","type":"run_result","finishReason":"completed","iterations":1,"#,
        r#""usage":{"inputTokens":4368,"outputTokens":2,"cacheReadTokens":7,"cacheWriteTokens":3,"totalCost":0},"#,
        r#""durationMs":31801,"text":"  feat: add thing  ","model":{"id":"qwen2.5:7b-instruct","provider":"ollama"}}"#,
        "\n",
    );

    #[test]
    fn reads_the_reply_usage_and_model_out_of_the_run_result() {
        let run = interpret_output(true, "exit status: 0", COMPLETED, "").unwrap();
        assert_eq!(run.text, "feat: add thing");
        // `provider/model`, the same shape the setting is stored in.
        assert_eq!(run.model.as_deref(), Some("ollama/qwen2.5:7b-instruct"));
        let usage = run.usage.expect("the run reported tokens");
        assert_eq!(usage.input_tokens, 4368);
        assert_eq!(usage.output_tokens, 2);
        assert_eq!(usage.cache_read_tokens, 7);
        assert_eq!(usage.cache_write_tokens, 3);
        // A local model really did cost nothing, which is not the same as not saying.
        assert_eq!(usage.cost_usd, Some(0.0));
    }

    /// There is nothing to resume, so nothing is claimed — a fabricated id would send the next turn
    /// looking for a session the CLI never had.
    #[test]
    fn reports_no_session_to_resume() {
        let run = interpret_output(true, "exit status: 0", COMPLETED, "").unwrap();
        assert_eq!(run.session_id, None);
    }

    /// Verbatim from a run against a model the provider doesn't serve: the failure is described in
    /// the `run_result`'s own `text`, so that is what the user has to be shown.
    #[test]
    fn a_failed_run_reports_the_reason_from_its_run_result() {
        let stdout = concat!(
            r#"{"type":"run_result","finishReason":"error","iterations":1,"#,
            r#""usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"#,
            r#""durationMs":20,"text":"model 'no-existe' not found","model":{"id":"no-existe","provider":"ollama"}}"#,
        );
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.contains("model 'no-existe' not found"), "got {err}");
    }

    /// The incidental first error line of that same run must not become the reported cause.
    #[test]
    fn the_last_error_line_wins_over_the_incidental_first_one() {
        let stderr = concat!(
            r#"{"ts":"1","type":"error","message":"hook dispatch failed: session.hook requires a valid hook event payload"}"#,
            "\n",
            r#"{"ts":"2","type":"error","message":"model 'no-existe' not found"}"#,
            "\n",
        );
        let err = interpret_output(false, "exit status: 1", "", stderr).unwrap_err();
        assert!(err.contains("model 'no-existe' not found"), "got {err}");
        assert!(!err.contains("hook dispatch"), "got {err}");
    }

    /// A turn that came back with nothing is the one failure worth asking about twice — and the
    /// message must say so in words rather than repeating the CLI's English.
    #[test]
    fn an_empty_answer_is_explained_and_retried() {
        let stdout = concat!(
            r#"{"type":"run_result","finishReason":"error","text":"Model returned empty response","#,
            r#""model":{"id":"qwen2.5:7b-instruct","provider":"ollama"}}"#,
        );
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.contains("no devolvió ninguna respuesta"), "got {err}");
        assert!(!err.contains("Model returned empty"), "the CLI's own words are replaced: {err}");
        assert!(ClineEngine.retry_once_on(&err), "and it is worth one more attempt");
    }

    /// Everything else is reported, not retried: a second run costs the user another turn and
    /// answers the same way.
    #[test]
    fn an_ordinary_failure_is_not_retried() {
        assert!(!ClineEngine.retry_once_on("cline terminó con 'error': model 'x' not found"));
        assert!(!ClineEngine.retry_once_on(&format!("{QUOTA_MARKER}rate limit")));
    }

    /// A limit or billing refusal has to reach the frontend as a quota notice, not a red banner.
    #[test]
    fn a_quota_refusal_gets_the_marker() {
        let stdout = concat!(
            r#"{"type":"run_result","finishReason":"error","text":"You have hit your rate limit, try again in 1h","#,
            r#""model":{"id":"m","provider":"cline"}}"#,
        );
        let err = interpret_output(false, "exit status: 1", stdout, "").unwrap_err();
        assert!(err.starts_with(QUOTA_MARKER), "got {err}");
    }

    /// A CLI that rejected the invocation before starting an agent emits no `run_result` at all.
    #[test]
    fn a_prestart_failure_is_read_from_its_error_line() {
        let stderr = r#"{"ts":"1","type":"error","message":"JSON output mode requires a prompt argument"}"#;
        let err = interpret_output(false, "exit status: 1", "", stderr).unwrap_err();
        assert!(err.contains("JSON output mode requires a prompt argument"), "got {err}");
    }

    #[test]
    fn an_empty_reply_on_a_clean_exit_is_an_error_not_a_blank_answer() {
        let stdout = r#"{"type":"run_result","finishReason":"completed","text":"   ","model":{"id":"m","provider":"ollama"}}"#;
        let err = interpret_output(true, "exit status: 0", stdout, "").unwrap_err();
        assert_eq!(err, "cline no devolvió contenido");
    }

    /// The split has to be on the *first* separator only: Cline's hosted catalog addresses models
    /// as `vendor/model`, so a greedy split would invent a provider that does not exist.
    #[test]
    fn a_model_id_carries_its_provider_and_keeps_its_own_slashes() {
        assert_eq!(split_model("ollama/qwen2.5:7b-instruct"), (Some("ollama"), "qwen2.5:7b-instruct"));
        assert_eq!(
            split_model("cline/dots-studio/dots-3-note-preview:free"),
            (Some("cline"), "dots-studio/dots-3-note-preview:free")
        );
        // A bare id leaves the provider to Cline's own configuration.
        assert_eq!(split_model("qwen2.5-coder"), (None, "qwen2.5-coder"));
        assert_eq!(split_model("  "), (None, ""));
    }

    /// A verbatim `~/.cline/data/settings/models.json`, as `cline auth ollama` writes it.
    const CATALOG: &str = r#"{
      "version": 1,
      "providers": {
        "ollama": {
          "provider": {
            "name": "Ollama",
            "baseUrl": "http://localhost:11434",
            "defaultModelId": "qwen2.5:7b-instruct",
            "protocol": "openai-chat",
            "modelsSourceUrl": "http://localhost:11434/api/tags"
          },
          "models": {
            "qwen2.5:7b-instruct": { "id": "qwen2.5:7b-instruct", "supportsVision": false }
          }
        }
      }
    }"#;

    #[test]
    fn the_catalog_names_the_configured_providers_and_where_to_ask_each_one() {
        let providers = parse_catalog(CATALOG);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].id, "ollama");
        assert_eq!(providers[0].source_url.as_deref(), Some("http://localhost:11434/api/tags"));
        // What the catalog knows on its own — the fallback for a provider that cannot be reached.
        assert_eq!(providers[0].known, vec!["qwen2.5:7b-instruct"]);
    }

    /// Ollama's `/api/tags` and an OpenAI-compatible `/v1/models` disagree on every name in the
    /// envelope, and a picker that only understood one of them would be empty for half the
    /// providers Cline can be pointed at.
    #[test]
    fn model_ids_are_read_out_of_either_listing_shape() {
        let ollama = r#"{"models":[{"name":"qwen2.5:7b-instruct","model":"qwen2.5:7b-instruct"},
                                   {"name":"gemma4:26b","model":"gemma4:26b"}]}"#;
        assert_eq!(model_ids(ollama), vec!["qwen2.5:7b-instruct", "gemma4:26b"]);

        let openai = r#"{"data":[{"id":"gpt-5"},{"id":"o3"}]}"#;
        assert_eq!(model_ids(openai), vec!["gpt-5", "o3"]);

        // A bare array, and bare strings inside it, both turn up in the wild.
        assert_eq!(model_ids(r#"["a",{"id":"b"}]"#), vec!["a", "b"]);
        assert!(model_ids("not json").is_empty());
    }

    /// The whole point of asking the provider: the catalog holds the one model `cline auth`
    /// recorded, while the provider is serving more. Both are offered, without duplicates, and the
    /// provider travels with each id.
    #[test]
    fn the_live_listing_is_merged_with_what_the_catalog_already_knew() {
        let providers = parse_catalog(CATALOG);
        let listed = qualify(&providers[0], model_ids(r#"{"models":[{"name":"gemma4:26b"},{"name":"qwen2.5:7b-instruct"}]}"#));
        assert_eq!(listed, vec!["ollama/gemma4:26b", "ollama/qwen2.5:7b-instruct"]);
    }

    /// A provider that cannot be reached falls back to the catalog rather than vanishing from the
    /// picker — "Ollama is not running" must not read as "you have no models".
    #[test]
    fn an_unreachable_provider_still_offers_what_the_catalog_recorded() {
        let providers = parse_catalog(CATALOG);
        assert_eq!(qualify(&providers[0], Vec::new()), vec!["ollama/qwen2.5:7b-instruct"]);
    }

    /// The listing against the machine it is running on, rather than against a fixture.
    ///
    /// `#[ignore]`d and run by hand (`cargo test -- --ignored cline::tests::live`), for the same
    /// reason `debugger::live_tests` is: it needs something outside the repository to be running —
    /// here, `cline auth` having been done and the configured provider being up. What it checks is
    /// the one thing fixtures cannot, which is that the catalog on this machine and the provider it
    /// names still fit the shapes above.
    #[tokio::test]
    #[ignore = "needs a configured `cline auth` provider that is currently reachable"]
    async fn live_listing_reaches_the_configured_providers() {
        let models = list_models().await;
        assert!(!models.is_empty(), "a configured provider should offer at least one model");
        for id in &models {
            let (provider, model) = split_model(id);
            assert!(provider.is_some(), "'{id}' should carry its provider");
            assert!(!model.is_empty(), "'{id}' should carry a model");
        }
        println!("cline offers: {}", models.join(", "));
    }

    /// The arguments a built command carries, as plain strings.
    fn args_of(inv: &AiInvocation) -> Vec<String> {
        ClineEngine
            .build_command("cline", inv)
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// A review has a repository and must not change it: plan mode, pointed at that repository.
    #[test]
    fn a_read_only_run_over_a_repository_is_planned_not_acted() {
        let mut inv = AiInvocation::new("Revisa el diff.", "diff --git a/x b/x");
        inv.cwd = Some("/repo");
        let args = args_of(&inv);
        assert!(args.contains(&"--plan".to_string()), "got {args:?}");
        assert!(args.windows(2).any(|pair| pair == ["--cwd", "/repo"]), "got {args:?}");
    }

    /// "Fix with AI" has the same repository and must change it: act mode.
    #[test]
    fn a_write_run_over_a_repository_acts() {
        let mut inv = AiInvocation::new("Corrige el hallazgo.", "");
        inv.cwd = Some("/repo");
        inv.auto_approve_edits = true;
        let args = args_of(&inv);
        assert!(!args.contains(&"--plan".to_string()), "got {args:?}");
        assert!(args.windows(2).any(|pair| pair == ["--cwd", "/repo"]), "got {args:?}");
    }

    /// A described diagram has no repository. It must still be given a directory — without one the
    /// CLI takes the app's, and a run with nothing to look at would be looking at CodeFlow's own
    /// working directory.
    #[test]
    fn a_text_only_run_is_planned_inside_a_scratch_directory() {
        let inv = AiInvocation::new("Describe el diagrama como JSON.", "TÍTULO: Arquitectura");
        let args = args_of(&inv);
        assert!(args.contains(&"--plan".to_string()), "got {args:?}");
        let at = args.iter().position(|arg| arg == "--cwd").expect("a directory is always given");
        let dir = std::path::Path::new(&args[at + 1]);
        assert!(dir.starts_with(std::env::temp_dir()), "got {dir:?}");
        assert!(dir.is_dir() && dir.read_dir().unwrap().next().is_none(), "and it is empty");
        std::fs::remove_dir(dir).ok();
    }

    /// The brief is one argument with whitespace in it — both are requirements of the CLI's own
    /// "prompt or mistyped subcommand" check.
    #[test]
    fn the_brief_puts_the_system_prompt_first_and_the_data_last() {
        let mut inv = AiInvocation::new("Escribe el mensaje de commit.", "diff --git a/x b/x");
        inv.system_prompt = Some("Eres un revisor senior.");
        let brief = brief(&inv);
        let system = brief.find("Eres un revisor senior.").expect("system prompt is present");
        let ask = brief.find("Escribe el mensaje de commit.").expect("ask is present");
        let data = brief.find("diff --git").expect("data is present");
        assert!(system < ask && ask < data, "got {brief}");
    }

    /// An invocation with nothing on stdin must not grow an empty "INPUT" section.
    #[test]
    fn a_brief_with_no_data_has_no_input_section() {
        let inv = AiInvocation::new("Di OK.", "");
        assert_eq!(brief(&inv), "Di OK.");
    }
}
