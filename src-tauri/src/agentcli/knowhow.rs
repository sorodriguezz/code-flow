//! The verbs about what the app knows: the code map and the knowledge index (the same answers the
//! `/mcp/code` server gives, for an agent or a script with no MCP), memories — read, and proposed for
//! the user to approve — and the local model, for work too cheap to spend a subscription on.

use serde_json::json;
use tauri::AppHandle;

use super::{place, Reply, Request};
use crate::ai::{task, AiInvocation};
use crate::hybrid::{budget, config, runtime};

/// `cf symbol|usages|outline|map|search|recall`: one of the code map's or the knowledge index's
/// answers, for the checkout `cf` ran in.
///
/// The code map reads the checkout itself — a worktree's own files. Knowledge and memories are keyed
/// by the project, so a worktree asks with its project's folder: otherwise it would read nothing the
/// user filed under the project and index a second copy of the repository from scratch.
pub async fn tool(request: &Request, app: &AppHandle) -> Reply {
    let text = request.text.trim();
    let place = place::of(app, &request.cwd, &request.session);
    let needs = |what: &str| Reply::no(format!("usage: cf {} {what}", request.verb));
    let (name, args, root) = match request.verb.as_str() {
        "symbol" if text.is_empty() => return needs("<name>"),
        "symbol" => ("find_symbol", json!({ "name": text }), place.root.clone()),
        "usages" if text.is_empty() => return needs("<name>"),
        "usages" => ("find_usages", json!({ "name": text }), place.root.clone()),
        "outline" if text.is_empty() => return needs("<file>"),
        "outline" => {
            let Some(relative) = relative_to(&place.root, &request.cwd, text) else {
                return Reply::no(format!("{text} is not inside this checkout ({})", place.root));
            };
            ("file_outline", json!({ "path": relative }), place.root.clone())
        }
        "map" => ("project_map", json!({}), place.root.clone()),
        "search" if text.is_empty() => return needs("<question>"),
        "search" => ("search_knowledge", json!({ "query": text }), place.knowledge_root().to_string()),
        _ => ("recall", json!({ "topic": text }), place.knowledge_root().to_string()),
    };
    let map_tool = matches!(name, "find_symbol" | "find_usages" | "file_outline" | "project_map");
    if map_tool && !crate::codemap::mcp::enabled() {
        return Reply::no("the code map is turned off (Settings › AI tools › MCP)");
    }
    // `cloud: true`, as the MCP server asks: what `cf` prints goes to an agent that may be a cloud
    // model, so local-only folders and memories stay out, and the workspace's cloud switch holds.
    match crate::codemap::mcp::call_tool_as(&root, name, &args, true).await {
        Ok(answer) => Reply::ok(answer),
        Err(error) => Reply::no(error),
    }
}

/// `file` (absolute, or relative to `cwd`) relative to `root`, `/`-separated — `None` outside it.
/// Compared without case (macOS and Windows folders have none) but returned as spelled: the code
/// map's paths are the files' own names.
fn relative_to(root: &str, cwd: &str, file: &str) -> Option<String> {
    let resolve = |path: std::path::PathBuf| std::fs::canonicalize(&path).unwrap_or(path).to_string_lossy().replace('\\', "/");
    let full = resolve(std::path::Path::new(cwd).join(file));
    let base = resolve(std::path::PathBuf::from(root));
    let base = base.trim_end_matches('/');
    place::within(&full.to_ascii_lowercase(), &base.to_ascii_lowercase())
        .then(|| full[base.len()..].trim_start_matches('/').to_string())
        .filter(|relative| !relative.is_empty())
}

/// How much of a fact names it in the Memory pane.
const MEMORY_TITLE: usize = 80;

/// `cf remember <fact>`: a memory proposed for the project — a *candidate*, which no model reads
/// until the user approves it in Settings › Local intelligence › Memory.
pub fn remember(request: &Request, app: &AppHandle) -> Reply {
    // `--kind decision|convention|fact|preference` first, as the MCP tool's `kind` arrives. A fact by
    // default: a proposed *preference*, once approved, rides every question of every turn.
    let (kind, rest) = match request.args.as_slice() {
        [flag, kind, rest @ ..] if flag == "--kind" => (memory_kind(kind), rest.join(" ")),
        _ => (None, request.text.clone()),
    };
    let text = rest.trim();
    if text.is_empty() {
        return Reply::no("usage: cf remember [--kind decision|convention|fact|preference] <fact>");
    }
    let place = place::of(app, &request.cwd, &request.session);
    let first = text.lines().next().unwrap_or(text).trim();
    let title = if first.chars().count() > MEMORY_TITLE { format!("{}…", first.chars().take(MEMORY_TITLE).collect::<String>()) } else { first.to_string() };
    let scope = match (&place.project, &place.workspace_id) {
        (Some(_), _) => crate::ai_memory::Scope::Project,
        (None, Some(_)) => crate::ai_memory::Scope::Workspace,
        (None, None) => crate::ai_memory::Scope::Global,
    };
    let input = crate::ai_memory::NewMemory {
        scope: Some(scope),
        workspace_id: place.workspace_id.clone(),
        project_id: place.project.as_ref().map(|p| p.id.clone()),
        title,
        body: text.to_string(),
        approved: false,
        source: Some("agent".to_string()),
        kind: Some(kind.unwrap_or(crate::ai_memory::Kind::Fact)),
        ..Default::default()
    };
    match crate::ai_usage::with_conn(|conn| crate::ai_memory::propose(conn, input)) {
        Some(Ok((memory, crate::ai_memory::Remembered::New))) => Reply::ok(format!(
            "proposed «{}»; models read it only after the user approves it in Settings › Local intelligence › Memory",
            memory.title
        )),
        Some(Ok((memory, _))) if memory.status == "candidate" => Reply::ok(format!(
            "already proposed as «{}» (waiting for the user's approval); your wording was added to it",
            memory.title
        )),
        Some(Ok((memory, _))) => Reply::ok(format!("already remembered: «{}»", memory.title)),
        Some(Err(error)) => Reply::no(error),
        None => Reply::no("the app's database is not available yet"),
    }
}

/// `cf contradict <memory title> -- <why> [--evidence <where>]`: an approved memory the agent found
/// contradicted by the code. It waits for the user's review in the Memory pane; nothing about it
/// changes — the agent may be the one that is wrong.
pub fn contradict(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf contradict <memory title> -- <what in the code says otherwise> [--evidence <path:line>]");
    let mut title = Vec::new();
    let mut reason = Vec::new();
    let mut evidence = Vec::new();
    let mut args = request.args.iter();
    let mut after = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" if !after => after = true,
            "--evidence" => evidence.extend(args.next().cloned()),
            _ if after => reason.push(arg.clone()),
            _ => title.push(arg.clone()),
        }
    }
    let (title, reason) = (title.join(" "), reason.join(" "));
    if title.trim().is_empty() || reason.trim().is_empty() {
        return usage();
    }
    let place = place::of(app, &request.cwd, &request.session);
    let project = place.project.as_ref().map(|p| p.id.clone());
    match crate::ai_usage::with_conn(|conn| crate::ai_memory::flag(conn, place.workspace_id.as_deref(), project.as_deref(), &title, &reason, &evidence, "agent")) {
        Some(Ok(memory)) => Reply::ok(format!("«{}» is now waiting for the user's review in Settings › Local intelligence › Memory, with your reason", memory.title)),
        Some(Err(error)) => Reply::no(error),
        None => Reply::no("the app's database is not available yet"),
    }
}

fn memory_kind(word: &str) -> Option<crate::ai_memory::Kind> {
    use crate::ai_memory::Kind;
    match word.trim().to_ascii_lowercase().as_str() {
        "decision" => Some(Kind::Decision),
        "convention" => Some(Kind::Convention),
        "fact" => Some(Kind::Fact),
        "preference" => Some(Kind::Preference),
        _ => None,
    }
}

/// What every `cf llm` call is told, before the agent's own instruction.
const LLM_SYSTEM: &str = "You are a careful assistant answering a request from a coding agent. Follow the instruction \
exactly, using only the material given. Be concise and keep exact names, numbers, paths and error messages as written.";

/// Parts one `cf llm` call is cut into at most. A part is a whole window of the local model, so more
/// than this is minutes of waiting; the middle goes, and the answer says so.
const MAX_PARTS: usize = 12;

/// `cf llm <instruction> [< material]`: the local model's answer, for work too cheap to send to the
/// agent's own model — reading a long log, summarising a diff, sorting a list.
///
/// Only a model on this machine: the bundled engine, or an Ollama / OpenAI-compatible server on
/// loopback. A material longer than the model's window is read in parts, each answered, and the
/// answers merged — never cut in the middle without saying so.
pub async fn llm(request: &Request) -> Reply {
    let instruction = request.text.trim();
    let material = request.stdin.as_str();
    if instruction.is_empty() && material.trim().is_empty() {
        return Reply::no("usage: cf llm <instruction> [< file]");
    }
    let Some(Ok(settings)) = crate::ai_usage::with_conn(config::read) else {
        return Reply::no("the local model's settings are not available");
    };
    let resolved = runtime::resolve(&settings, runtime::Freshness::Now).await;
    if let Some(code) = resolved.error_code {
        return Reply::no(resolved.error.unwrap_or_else(|| format!("the local model is not ready ({code}) — set it up in Settings › AI engines › Local model")));
    }
    if resolved.kind != crate::hybrid::local_llm::BackendKind::Bundled && !crate::hybrid::local_llm::is_loopback(&resolved.url) {
        return Reply::no(format!("cf llm only uses a model on this machine, and the local model's server is at {}", resolved.url));
    }
    let instruction = if instruction.is_empty() { "Summarise this." } else { instruction };

    // Room for the material in one call: the window's input budget, less the instruction and the
    // system note, in characters at the estimate the rest of the app budgets with.
    let overhead = budget::estimate_tokens(LLM_SYSTEM) + budget::estimate_tokens(instruction) + 600;
    let room = ((resolved.budget.input as u64).saturating_sub(overhead) as f64 * budget::CHARS_PER_TOKEN) as usize;
    let room = room.max(2_000);
    if material.len() <= room {
        return answer(instruction, material).await;
    }

    let mut parts = crate::meetings::ai::split_lines(material, room);
    let mut note = String::new();
    if parts.len() > MAX_PARTS {
        let left_out = parts.len() - MAX_PARTS;
        let tail = parts.split_off(parts.len() - MAX_PARTS / 2);
        parts.truncate(MAX_PARTS / 2);
        parts.extend(tail);
        note = format!("\n\n[cf llm read the first and last parts of the material; {left_out} parts in the middle were left out]");
    }
    let total = parts.len();
    let mut partial = Vec::with_capacity(total);
    for (i, part) in parts.iter().enumerate() {
        let asked = format!("{instruction}\n\n(This is part {} of {total} of the material; answer for this part only.)", i + 1);
        match run(&asked, part).await {
            Ok(text) => partial.push(format!("--- part {} of {total} ---\n{}", i + 1, text.trim())),
            Err(error) => return Reply::no(error),
        }
    }
    let merge = format!(
        "{instruction}\n\nThe material was too long to read at once, so it was read in {total} consecutive parts and the \
         instruction answered for each. Below are those answers, in order. Merge them into one answer to the instruction, \
         without repeating yourself and without saying that it came in parts."
    );
    match run(&merge, &partial.join("\n\n")).await {
        Ok(text) => Reply::ok(format!("{}{note}", text.trim())),
        Err(error) => Reply::no(error),
    }
}

async fn answer(instruction: &str, material: &str) -> Reply {
    match run(instruction, material).await {
        Ok(text) => Reply::ok(text.trim().to_string()),
        Err(error) => Reply::no(error),
    }
}

/// One call to the local model, in text mode (no tools: `cwd` is unset), counted in the usage meter.
async fn run(instruction: &str, material: &str) -> Result<String, String> {
    let mut inv = AiInvocation::new(instruction, material);
    inv.system_prompt = Some(LLM_SYSTEM);
    inv.task = task::OTHER;
    let run = crate::local_agent::run(&inv, &None, &mut None).await?;
    if let Some(usage) = &run.usage {
        crate::ai_usage::record(crate::local_agent::PROVIDER_ID, run.model.as_deref().unwrap_or_default(), task::OTHER, None, usage);
    }
    Ok(run.text)
}

#[cfg(test)]
mod tests {
    use super::relative_to;

    #[test]
    fn an_outline_path_is_relative_to_the_checkout_and_never_outside_it() {
        let root = std::env::temp_dir().join("cf-knowhow-root");
        let root = root.to_string_lossy();
        assert_eq!(relative_to(&root, &root, "src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(relative_to(&root, &format!("{root}/src"), "a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(relative_to(&root, &root, "/elsewhere/a.ts"), None);
    }
}
