//! Agents in a flow: one of the roster's agents answering as itself, several of them at once, a lead
//! that hands work to helpers, and a run of one of the workspace's agent teams.
//!
//! **Nothing here iterates without an end.** Agents at once are capped by «A la vez» and by the flow's
//! AI calls an hour; a lead has a fixed number of rounds and of calls per round, and its last round
//! must answer; a team run is the team's own engine, with the team's budgets.
//!
//! **The desk.** In the run's own folder («Carpeta temporal») every agent gets a folder of its own on
//! the node's desk, and may write there: long deliverables and the files it makes stay whole instead of
//! squeezed into an answer, and agents at once never write to the same place. Whoever reads them all —
//! the lead, the judge — works at the desk itself, read-only, and opens what it needs. In a repository or
//! another folder agents only read: several of them editing one working copy at once would undo each
//! other's work; that is a team's job, each member in its own worktree.

use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::{
    ask, conform, ensure_room, failure_of, output_item, output_schema, protect_repo, schema_instruction, text, work_folder, Ask, NodeCtx, NodeError,
    Reply,
};
use crate::flows::engine::{EngineChoice, LogStream, RosterAgent, TeamRequest};
use crate::flows::nodes::{failed_item, carry_on, number, strings, with_failures};
use crate::flows::run::{Item, Ports};

/// Most agents one node asks at once, and most helpers a lead may have.
const MAX_AGENTS: usize = 8;
/// What a helper's answer is cut to before the lead reads it again, round after round.
const MAX_RESULT_CHARS: usize = 6_000;

// ------------------------------------------------------------------------------------- the roster

/// The roster agent the AI agent node answers as — `None` when it runs on an engine of its own.
pub(super) fn chosen_agent(ctx: &NodeCtx) -> Result<Option<RosterAgent>, NodeError> {
    if ctx.param_str("runAs") != "rosterAgent" {
        return Ok(None);
    }
    roster(ctx, "agent").map(Some)
}

fn roster(ctx: &NodeCtx, param: &str) -> Result<RosterAgent, NodeError> {
    let id = ctx.param_str(param);
    if id.trim().is_empty() {
        return Err(NodeError::failed("Choose an agent of your roster"));
    }
    ctx.run.host.roster_agent(id.trim()).map_err(NodeError::Failed)
}

fn roster_list(ctx: &NodeCtx, param: &str) -> Result<Vec<RosterAgent>, NodeError> {
    let mut ids = strings(&ctx.params, param);
    ids.dedup();
    let mut list = Vec::new();
    for id in ids.iter().filter(|id| !id.trim().is_empty()) {
        list.push(ctx.run.host.roster_agent(id.trim()).map_err(NodeError::Failed)?);
    }
    if list.len() > MAX_AGENTS {
        return Err(NodeError::failed(format!("Choose up to {MAX_AGENTS} agents")));
    }
    Ok(list)
}

/// The agent's own instructions, then the node's.
pub(super) fn with_persona(agent: &RosterAgent, extra: Option<&str>) -> String {
    let mut system = format!("Eres «{}»", agent.name);
    if !agent.role.trim().is_empty() {
        system.push_str(&format!(", {}", agent.role.trim()));
    }
    system.push('.');
    if !agent.prompt.trim().is_empty() {
        system.push_str("\n\n");
        system.push_str(agent.prompt.trim());
    }
    if let Some(extra) = extra.map(str::trim).filter(|extra| !extra.is_empty()) {
        system.push_str("\n\n");
        system.push_str(extra);
    }
    system
}

pub(super) fn effort_of_agent(agent: &RosterAgent) -> Option<String> {
    Some(agent.effort.trim().to_string()).filter(|effort| !effort.is_empty() && effort != "default")
}

/// How many agents run at once: «A la vez», never more than [`MAX_AGENTS`].
fn at_once(ctx: &NodeCtx) -> usize {
    number(&ctx.params, "concurrency").unwrap_or(3.0).clamp(1.0, MAX_AGENTS as f64) as usize
}

/// Where the agents work: the node's folder (behind a restore point where an engine only *asks* to stay
/// read-only), and whether it is the node's desk — the run's own folder, where each agent gets one of
/// its own to write in.
fn reading_folder(ctx: &NodeCtx, agents: &[&RosterAgent]) -> Result<(String, bool), NodeError> {
    let desk = matches!(ctx.param_str("workIn").as_str(), "" | "temp");
    let (cwd, repo) = work_folder(ctx)?;
    if let Some(root) = repo.as_ref().filter(|_| !desk) {
        let engines: Vec<EngineChoice> = agents.iter().map(|agent| agent.engine.clone()).collect();
        protect_repo(ctx, &engines, root, false)?;
    }
    Ok((cwd, desk))
}

/// Where one agent works.
#[derive(Debug, Clone)]
struct Place {
    cwd: String,
    /// Its own folder on the desk, where it may write.
    own: bool,
}

/// A folder name from an agent's name: letters, digits and dashes.
fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "agente".into() } else { out }
}

/// `label`'s folder on the desk at `root` — or, off the desk, the folder everyone reads.
fn place_in(root: &str, desk: bool, label: &str) -> Result<Place, NodeError> {
    if !desk {
        return Ok(Place { cwd: root.to_string(), own: false });
    }
    let dir = std::path::Path::new(root).join(slug(label));
    std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("Could not prepare a folder for {label}: {e}")))?;
    Ok(Place { cwd: dir.to_string_lossy().into_owned(), own: true })
}

/// The files under `dir`, relative to it — at most a couple hundred.
fn files_in(dir: &str) -> Vec<String> {
    let root = std::path::Path::new(dir);
    let mut out = Vec::new();
    let mut queue = vec![root.to_path_buf()];
    while let Some(next) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
            } else if let Ok(relative) = path.strip_prefix(root) {
                out.push(relative.to_string_lossy().replace('\\', "/"));
                if out.len() >= 200 {
                    out.sort();
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

/// What an agent with a folder of its own is told about it.
const OWN_FOLDER: &str = "\n\nTrabajas en tu propia carpeta (la carpeta actual), donde puedes escribir. Si tu entrega es larga o produce \
     archivos, guárdala ahí (la entrega principal en `entrega.md`) y responde con un resumen breve que diga qué archivos dejaste. \
     No escribas fuera de esta carpeta.";

fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut kept: String = text.chars().take(limit).collect();
    kept.push_str("\n… (recortado)");
    kept
}

/// A piece of work to run alongside others.
type Job<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// Runs `jobs`, at most `limit` at a time, in the order they finish.
fn bounded<'a, T: 'a>(jobs: Vec<Job<'a, T>>, limit: usize) -> impl futures_util::Stream<Item = T> + Send + 'a
where
    T: Send,
{
    stream::iter(jobs).buffer_unordered(limit.max(1))
}

/// One agent's answer to one question, as itself, read-only.
struct Answer {
    agent: RosterAgent,
    outcome: Result<(Reply, Option<Value>), NodeError>,
    ms: u64,
    /// Its own folder on the desk, when it had one.
    folder: Option<String>,
}

#[allow(clippy::too_many_arguments)]
async fn ask_agent(
    ctx: &NodeCtx,
    agent: &RosterAgent,
    prompt: &str,
    data: &str,
    place: &Place,
    schema: Option<&Value>,
    cancel: Option<CancellationToken>,
) -> Answer {
    let started = Instant::now();
    let mut full = prompt.trim().to_string();
    let writes = place.own && agent.edits;
    if writes {
        full.push_str(OWN_FOLDER);
    }
    if let Some(schema) = schema {
        full.push_str(&schema_instruction(schema));
    }
    let question = Ask {
        prompt: full,
        data: data.to_string(),
        system: Some(with_persona(agent, None)),
        cwd: Some(place.cwd.clone()),
        can_edit: writes,
        schema: schema.cloned(),
        effort: effort_of_agent(agent),
        cancel,
        ..Default::default()
    };
    let engines = vec![agent.engine.clone()];
    let outcome = async {
        let (reply, used) = ask(ctx, &engines, &question).await?;
        match schema {
            Some(_) => {
                let (reply, object) = conform(ctx, &engines, &question, reply, used).await?;
                Ok((reply, Some(object)))
            }
            None => Ok((reply, None)),
        }
    }
    .await;
    let folder = place.own.then(|| place.cwd.clone());
    Answer { agent: agent.clone(), outcome, ms: started.elapsed().as_millis() as u64, folder }
}

/// An answer as the item shows it.
fn row_of(answer: &Answer) -> Value {
    let mut row = Map::new();
    row.insert("agent".into(), json!(answer.agent.name));
    if !answer.agent.role.trim().is_empty() {
        row.insert("role".into(), json!(answer.agent.role));
    }
    match &answer.outcome {
        Ok((reply, data)) => {
            row.insert("text".into(), json!(reply.text.trim()));
            if let Some(data) = data {
                row.insert("data".into(), data.clone());
            }
            row.insert("engine".into(), json!(reply.provider));
            if !reply.model.is_empty() {
                row.insert("model".into(), json!(reply.model));
            }
            if let Some(usage) = &reply.usage {
                row.insert("usage".into(), usage.clone());
            }
        }
        Err(error) => {
            row.insert("error".into(), json!(error.to_string()));
        }
    }
    if let Some(folder) = &answer.folder {
        let files = files_in(folder);
        if !files.is_empty() {
            row.insert("folder".into(), json!(folder));
            row.insert("files".into(), json!(files));
        }
    }
    row.insert("durationMs".into(), json!(answer.ms));
    Value::Object(row)
}

// ------------------------------------------------------------------------------------ at once

/// «Agentes en paralelo»: the same task to several agents — their answers joined — or one agent over
/// every item, several items at a time.
pub(super) async fn parallel(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let schema = output_schema(&ctx.params)?;
    let limit = at_once(ctx);
    if ctx.param_str("mode") == "perItem" {
        return per_item(ctx, schema.as_ref(), limit).await;
    }
    let agents = roster_list(ctx, "agents")?;
    if agents.len() < 2 {
        return Err(NodeError::failed("Choose at least two agents"));
    }
    let combine = ctx.param_str("combine");
    let judge = if combine == "judgeByAgent" { Some(roster(ctx, "judgeAgent")?) } else { None };
    let (cwd, desk) = reading_folder(ctx, &agents.iter().collect::<Vec<_>>())?;
    let all = ctx.resolve_each().await?;
    ensure_room(ctx, all.len() * (agents.len() + usize::from(judge.is_some())))?;

    let mut out = Vec::with_capacity(all.len());
    let mut failed: Vec<Item> = Vec::new();
    for (index, params) in all.iter().enumerate() {
        let prompt = text(params, "prompt");
        if prompt.trim().is_empty() {
            return Err(NodeError::failed("Write what the agents should do"));
        }
        let data = text(params, "data");
        let started = Instant::now();
        // One desk per item, so the agents' folders of item 2 are not item 1's.
        let root = if desk && all.len() > 1 { place_in(&cwd, true, &format!("item-{}", index + 1))?.cwd } else { cwd.clone() };
        let mut places = Vec::with_capacity(agents.len());
        for agent in &agents {
            places.push(place_in(&root, desk, &agent.name)?);
        }
        let joined = match combine.as_str() {
            "firstAnswer" => first_answer(ctx, &agents, &places, &prompt, &data, schema.as_ref(), limit).await,
            _ => {
                let answers = everyone(ctx, &agents, &places, &prompt, &data, schema.as_ref(), limit).await?;
                match combine.as_str() {
                    "majority" => Ok(majority(&answers)),
                    "judgeByAgent" => {
                        let at_the_desk = Place { cwd: root.clone(), own: false };
                        judged(ctx, judge.as_ref().expect("judge"), &prompt, &answers, &at_the_desk, desk, &text(params, "judgeCriteria")).await
                    }
                    _ => Ok(all_answers(&answers)),
                }
            }
        };
        let mut json = match joined {
            Ok(json) => json,
            Err(error) if error != NodeError::Cancelled && carry_on(ctx) => {
                failed.push(failed_item(ctx, index, &error));
                continue;
            }
            Err(error) => return Err(error),
        };
        json.insert("durationMs".into(), json!(started.elapsed().as_millis() as u64));
        out.push(output_item(ctx, index, Value::Object(json)));
    }
    Ok(with_failures(ctx, vec![out], failed, 0))
}

/// Every agent's answer, at most `limit` asking at a time, in the agents' order. Fails only when no
/// agent answered.
#[allow(clippy::too_many_arguments)]
async fn everyone(ctx: &NodeCtx, agents: &[RosterAgent], places: &[Place], prompt: &str, data: &str, schema: Option<&Value>, limit: usize) -> Result<Vec<Answer>, NodeError> {
    let jobs: Vec<Job<'_, (usize, Answer)>> = agents
        .iter()
        .zip(places)
        .enumerate()
        .map(|(position, (agent, place))| -> Job<'_, (usize, Answer)> {
            Box::pin(async move { (position, ask_agent(ctx, agent, prompt, data, place, schema, None).await) })
        })
        .collect();
    let mut answers: Vec<(usize, Answer)> = bounded(jobs, limit).collect().await;
    if ctx.cancel.is_cancelled() || answers.iter().any(|(_, answer)| matches!(answer.outcome, Err(NodeError::Cancelled))) {
        return Err(NodeError::Cancelled);
    }
    answers.sort_by_key(|(position, _)| *position);
    let answers: Vec<Answer> = answers.into_iter().map(|(_, answer)| answer).collect();
    for answer in &answers {
        if let Err(error) = &answer.outcome {
            ctx.log(LogStream::Info, &format!("{} did not answer: {error}", answer.agent.name));
        }
    }
    if answers.iter().all(|answer| answer.outcome.is_err()) {
        let first = answers.iter().find_map(|answer| answer.outcome.as_ref().err().map(ToString::to_string)).unwrap_or_default();
        return Err(NodeError::failed(format!("No agent answered: {first}")));
    }
    Ok(answers)
}

fn all_answers(answers: &[Answer]) -> Map<String, Value> {
    let mut text = String::new();
    for answer in answers {
        if let Ok((reply, _)) = &answer.outcome {
            text.push_str(&format!("## {}\n{}\n\n", answer.agent.name, reply.text.trim()));
        }
    }
    let mut json = Map::new();
    json.insert("text".into(), json!(text.trim()));
    json.insert("answers".into(), json!(answers.iter().map(row_of).collect::<Vec<_>>()));
    json
}

/// The first agent to answer; the others are stopped.
#[allow(clippy::too_many_arguments)]
async fn first_answer(ctx: &NodeCtx, agents: &[RosterAgent], places: &[Place], prompt: &str, data: &str, schema: Option<&Value>, limit: usize) -> Result<Map<String, Value>, NodeError> {
    let stop = ctx.cancel.child_token();
    let jobs: Vec<Job<'_, Answer>> = agents
        .iter()
        .zip(places)
        .map(|(agent, place)| -> Job<'_, Answer> {
            let stop = stop.clone();
            Box::pin(async move { ask_agent(ctx, agent, prompt, data, place, schema, Some(stop)).await })
        })
        .collect();
    let mut running = std::pin::pin!(bounded(jobs, limit));
    let mut errors = Vec::new();
    while let Some(answer) = running.next().await {
        if answer.outcome.is_ok() {
            stop.cancel();
            let mut json = Map::new();
            let row = row_of(&answer);
            if let Value::Object(fields) = row {
                json.extend(fields);
            }
            return Ok(json);
        }
        if ctx.cancel.is_cancelled() {
            return Err(NodeError::Cancelled);
        }
        if let Err(error) = &answer.outcome {
            ctx.log(LogStream::Info, &format!("{} did not answer: {error}", answer.agent.name));
            errors.push(error.to_string());
        }
    }
    Err(NodeError::failed(format!("No agent answered: {}", errors.first().cloned().unwrap_or_default())))
}

/// What a vote compares: the structured answer as written, or the words without case, spacing or a
/// closing full stop.
fn ballot(reply: &Reply, data: Option<&Value>) -> String {
    match data {
        Some(data) => data.to_string(),
        None => reply.text.split_whitespace().collect::<Vec<_>>().join(" ").trim_end_matches(['.', '!', '。']).to_lowercase(),
    }
}

/// The answer most agents gave; a tie goes to the one given first in the agents' order.
fn majority(answers: &[Answer]) -> Map<String, Value> {
    let mut tally: Vec<(String, Vec<&Answer>)> = Vec::new();
    for answer in answers {
        let Ok((reply, data)) = &answer.outcome else { continue };
        let key = ballot(reply, data.as_ref());
        match tally.iter_mut().find(|(seen, _)| *seen == key) {
            Some((_, voters)) => voters.push(answer),
            None => tally.push((key, vec![answer])),
        }
    }
    let voted = tally.iter().map(|(_, voters)| voters.len()).sum::<usize>();
    let (_, winners) = tally.iter().fold(None::<&(String, Vec<&Answer>)>, |best, entry| match best {
        Some(best) if best.1.len() >= entry.1.len() => Some(best),
        _ => Some(entry),
    }).expect("someone answered");
    let mut json = Map::new();
    if let Ok((reply, data)) = &winners[0].outcome {
        json.insert("text".into(), json!(reply.text.trim()));
        if let Some(data) = data {
            json.insert("data".into(), data.clone());
        }
    }
    json.insert("votes".into(), json!(winners.len()));
    json.insert("of".into(), json!(voted));
    json.insert("unanimous".into(), json!(tally.len() == 1));
    json.insert(
        "tally".into(),
        json!(tally
            .iter()
            .map(|(_, voters)| {
                let text = voters[0].outcome.as_ref().map(|(reply, _)| reply.text.trim().to_string()).unwrap_or_default();
                json!({"answer": text, "votes": voters.len(), "agents": voters.iter().map(|voter| voter.agent.name.clone()).collect::<Vec<_>>()})
            })
            .collect::<Vec<_>>()),
    );
    json.insert("answers".into(), json!(answers.iter().map(row_of).collect::<Vec<_>>()));
    json
}

/// Another agent reads every answer and picks the best — or writes one from them.
async fn judged(ctx: &NodeCtx, judge: &RosterAgent, prompt: &str, answers: &[Answer], place: &Place, desk: bool, criteria: &str) -> Result<Map<String, Value>, NodeError> {
    let answered: Vec<&Answer> = answers.iter().filter(|answer| answer.outcome.is_ok()).collect();
    let mut json = all_answers(answers);
    if answered.len() < 2 {
        return Ok(json);
    }
    let names: Vec<String> = answered.iter().map(|answer| answer.agent.name.clone()).collect();
    let schema = json!({
        "type": "object",
        "properties": {
            "winner": {"type": "string", "enum": names},
            "reason": {"type": "string"},
            "answer": {"type": "string"},
        },
        "required": ["winner", "reason", "answer"],
        "additionalProperties": false,
    });
    let criteria = if criteria.trim().is_empty() { "La respuesta más correcta, completa y útil." } else { criteria.trim() };
    let mut data = format!("TAREA:\n{}\n", prompt.trim());
    for answer in &answered {
        if let Ok((reply, _)) = &answer.outcome {
            data.push_str(&format!("\n--- RESPUESTA DE {} ---\n{}\n", answer.agent.name, reply.text.trim()));
            if desk && answer.folder.as_deref().is_some_and(|folder| !files_in(folder).is_empty()) {
                data.push_str(&format!("(sus archivos están en la carpeta `{}/` de la carpeta actual)\n", slug(&answer.agent.name)));
            }
        }
    }
    let task = format!(
        "Varios agentes respondieron la misma tarea. Elige la mejor respuesta según este criterio: {criteria}\n\
         En `answer` escribe la respuesta final: la ganadora tal cual, o mejorada con lo que aporten las otras. \
         Explica la elección en una o dos frases en `reason`."
    );
    let verdict = ask_agent(ctx, judge, &task, &data, place, Some(&schema), None).await;
    let (reply, object) = verdict.outcome?;
    let object = object.unwrap_or_default();
    json.insert("text".into(), json!(text(&object, "answer")));
    json.insert("winner".into(), json!(text(&object, "winner")));
    json.insert("reason".into(), json!(text(&object, "reason")));
    json.insert("judge".into(), json!({"agent": judge.name, "engine": reply.provider, "model": reply.model}));
    Ok(json)
}

/// One agent over every item, `limit` items at a time; each answer paired with its item.
async fn per_item(ctx: &NodeCtx, schema: Option<&Value>, limit: usize) -> Result<Ports, NodeError> {
    let agent = roster(ctx, "agent")?;
    let (cwd, desk) = reading_folder(ctx, &[&agent])?;
    let all = ctx.resolve_each().await?;
    ensure_room(ctx, all.len())?;
    let mut places = Vec::with_capacity(all.len());
    for (index, params) in all.iter().enumerate() {
        if text(params, "prompt").trim().is_empty() {
            return Err(NodeError::failed("Write what the agent should do"));
        }
        places.push(place_in(&cwd, desk, &format!("item-{}", index + 1))?);
    }
    let agent = &agent;
    let jobs: Vec<Job<'_, (usize, Answer)>> = all
        .iter()
        .zip(&places)
        .enumerate()
        .map(|(index, (params, place))| -> Job<'_, (usize, Answer)> {
            Box::pin(async move { (index, ask_agent(ctx, agent, &text(params, "prompt"), &text(params, "data"), place, schema, None).await) })
        })
        .collect();
    let mut answers: Vec<(usize, Answer)> = bounded(jobs, limit).collect().await;
    if ctx.cancel.is_cancelled() {
        return Err(NodeError::Cancelled);
    }
    answers.sort_by_key(|(index, _)| *index);
    let mut out = Vec::with_capacity(answers.len());
    let mut failed: Vec<Item> = Vec::new();
    for (index, answer) in answers {
        match &answer.outcome {
            Ok(_) => out.push(output_item(ctx, index, row_of(&answer))),
            Err(error) if *error != NodeError::Cancelled && carry_on(ctx) => failed.push(failed_item(ctx, index, error)),
            Err(error) => return Err(error.clone()),
        }
    }
    Ok(with_failures(ctx, vec![out], failed, 0))
}

// ------------------------------------------------------------------------------------- the lead

/// Someone the lead can hand work to: an agent of the roster, or a flow called as a tool.
enum Helper {
    Agent(RosterAgent),
    Flow(super::super::tools::FlowTool),
}

impl Helper {
    fn name(&self) -> &str {
        match self {
            Helper::Agent(agent) => &agent.name,
            Helper::Flow(tool) => &tool.name,
        }
    }

    fn line(&self) -> String {
        match self {
            Helper::Agent(agent) => {
                let role = if agent.role.trim().is_empty() { "agente".to_string() } else { agent.role.trim().to_string() };
                format!("- «{}» (agente): {role}", agent.name)
            }
            Helper::Flow(tool) => format!(
                "- «{}» (flujo): {}. En `task` va un objeto JSON con estos campos: {}",
                tool.name,
                tool.description.trim(),
                tool.schema.get("properties").map(Value::to_string).unwrap_or_else(|| "{}".into())
            ),
        }
    }
}

/// One piece of work the lead handed out, and what came back.
struct Call {
    round: usize,
    to: String,
    task: String,
    outcome: Result<String, String>,
    ms: u64,
    /// The helper's folder on the desk, relative to it, when it left files there.
    folder: Option<String>,
}

fn lead_schema(names: &[String]) -> Value {
    json!({
        "type": "object",
        "properties": {
            "done": {"type": "boolean"},
            "answer": {"type": "string"},
            "calls": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "to": {"type": "string", "enum": names},
                        "task": {"type": "string"},
                    },
                    "required": ["to", "task"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["done", "answer", "calls"],
        "additionalProperties": false,
    })
}

fn lead_prompt(goal: &str, helpers: &[Helper], calls: &[Call], round: usize, rounds: usize, per_round: usize, desk: bool) -> String {
    let mut text = format!("Coordinas a un grupo de ayudantes para cumplir este objetivo:\n\n{}\n\n## Ayudantes\n", goal.trim());
    for helper in helpers {
        text.push_str(&helper.line());
        text.push('\n');
    }
    if !calls.is_empty() {
        text.push_str("\n## Lo que ya hicieron\n");
        for call in calls {
            let result = match &call.outcome {
                Ok(text) => cut(text, MAX_RESULT_CHARS),
                Err(error) => format!("FALLÓ: {error}"),
            };
            text.push_str(&format!("\n### Ronda {} · «{}» ← {}\n{}\n", call.round, call.to, call.task.trim(), result));
            if let Some(folder) = &call.folder {
                text.push_str(&format!("(su trabajo completo está en `{folder}/`)\n"));
            }
        }
    }
    text.push_str(&format!(
        "\n## Reglas\n\
         - Ve a lo concreto. Delega solo lo que de verdad haga falta; si ya puedes responder, responde.\n\
         - Como mucho {per_round} encargos por ronda; los de una misma ronda corren a la vez, así que no dependen entre sí.\n\
         - Cada encargo debe bastarse solo: el ayudante no ve el objetivo ni lo que hicieron los demás, solo su `task`.\n\
         - Cuando termines, `done` = true y en `answer` la respuesta final completa para quien pidió el objetivo (no un resumen de quién hizo qué). \
         Mientras delegas, `done` = false y `answer` vacío.\n\
         - Esta es la ronda {round} de {rounds}."
    ));
    if desk {
        text.push_str(
            "\n- La carpeta actual es la mesa de trabajo: cada agente ayudante deja su trabajo en su propia carpeta. \
             Lee los archivos que necesites antes de decidir; el texto de arriba puede estar recortado.",
        );
    }
    if round >= rounds {
        text.push_str(" Es la ÚLTIMA: `done` = true, `calls` vacío y la respuesta final con lo que hay.");
    }
    text
}

/// «Orquestador»: a lead that hands work to agents and flows, a few at a time, for a fixed number of
/// rounds, and then answers.
pub(super) async fn orchestrator(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let lead_agent = chosen_agent(ctx)?;
    let mut lead_engines = super::engines(&ctx.params);
    if let Some(agent) = &lead_agent {
        lead_engines[0] = agent.engine.clone();
        lead_engines.dedup_by(|later, first| later.provider == first.provider);
    }
    let mut helpers: Vec<Helper> = roster_list(ctx, "helpers")?.into_iter().map(Helper::Agent).collect();
    for tool in super::super::tools::flow_tools(ctx, &ctx.params).await? {
        helpers.push(Helper::Flow(tool));
    }
    if helpers.is_empty() {
        return Err(NodeError::failed("Give the lead at least one helper: an agent or a flow"));
    }
    let names: Vec<String> = helpers.iter().map(|helper| helper.name().to_string()).collect();
    if names.iter().enumerate().any(|(index, name)| names[..index].contains(name)) {
        return Err(NodeError::failed("Two helpers have the same name — the lead could not tell them apart"));
    }
    let rounds = number(&ctx.params, "maxRounds").unwrap_or(3.0).clamp(1.0, 8.0) as usize;
    let per_round = number(&ctx.params, "maxCalls").unwrap_or(4.0).clamp(1.0, MAX_AGENTS as f64) as usize;
    let limit = at_once(ctx);
    let readers: Vec<&RosterAgent> = helpers.iter().filter_map(|helper| if let Helper::Agent(agent) = helper { Some(agent) } else { None }).collect();
    let (cwd, desk) = reading_folder(ctx, &readers)?;
    let params = ctx.resolve_once().await?;
    let goal = text(&params, "prompt");
    if goal.trim().is_empty() {
        return Err(NodeError::failed("Write the goal the lead works towards"));
    }
    let data = text(&params, "data");
    ensure_room(ctx, 2)?;
    let schema = lead_schema(&names);
    let started = Instant::now();
    let mut calls: Vec<Call> = Vec::new();
    let mut last: Option<(Reply, Value)> = None;
    for round in 1..=rounds {
        let question = Ask {
            prompt: format!("{}{}", lead_prompt(&goal, &helpers, &calls, round, rounds, per_round, desk), schema_instruction(&schema)),
            data: data.clone(),
            system: lead_agent.as_ref().map(|agent| with_persona(agent, None)),
            cwd: Some(cwd.clone()),
            schema: Some(schema.clone()),
            effort: super::effort_of(ctx).or_else(|| lead_agent.as_ref().and_then(effort_of_agent)),
            ..Default::default()
        };
        let (reply, used) = ask(ctx, &lead_engines, &question).await?;
        let (reply, plan) = conform(ctx, &lead_engines, &question, reply, used).await?;
        let wanted: Vec<(String, String)> = plan
            .get("calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|call| (text(call, "to"), text(call, "task")))
            .filter(|(to, task)| !to.is_empty() && !task.trim().is_empty())
            .collect();
        let finished = plan.get("done").and_then(Value::as_bool).unwrap_or(false) || wanted.is_empty() || round >= rounds;
        last = Some((reply, plan));
        if finished {
            break;
        }
        if wanted.len() > per_round {
            ctx.log(LogStream::Info, &format!("The lead asked for {} pieces of work — only the first {per_round} run this round", wanted.len()));
        }
        let wanted: Vec<(String, String)> = wanted.into_iter().take(per_round).collect();
        ctx.log(
            LogStream::Info,
            &format!("Round {round}: {}", wanted.iter().map(|(to, _)| to.as_str()).collect::<Vec<_>>().join(", ")),
        );
        // A helper keeps its folder from round to round; called twice in one round, the second works
        // in a folder of its own, so the two never write to the same place.
        let mut labels: Vec<String> = Vec::new();
        let mut placed = Vec::with_capacity(wanted.len());
        for (to, task) in wanted {
            let mut label = to.clone();
            let mut n = 1;
            while labels.contains(&label) {
                n += 1;
                label = format!("{to}-{n}");
            }
            labels.push(label.clone());
            let place = place_in(&cwd, desk, &label)?;
            placed.push((to, task, place));
        }
        let helpers_ref = &helpers;
        let jobs: Vec<Job<'_, Call>> = placed
            .into_iter()
            .map(|(to, task, place)| -> Job<'_, Call> {
                Box::pin(async move {
                    let began = Instant::now();
                    let outcome = run_helper(ctx, helpers_ref, &to, &task, &place).await;
                    let folder = (place.own && !files_in(&place.cwd).is_empty())
                        .then(|| std::path::Path::new(&place.cwd).file_name().map(|name| name.to_string_lossy().into_owned()))
                        .flatten();
                    Call { round, to, task, outcome, ms: began.elapsed().as_millis() as u64, folder }
                })
            })
            .collect();
        let done: Vec<Call> = bounded(jobs, limit).collect().await;
        if ctx.cancel.is_cancelled() {
            return Err(NodeError::Cancelled);
        }
        calls.extend(done);
    }
    let (reply, plan) = last.expect("at least one round");
    let mut answer = text(&plan, "answer");
    if answer.trim().is_empty() {
        // The lead stopped delegating without writing the answer: the last thing anyone said is the
        // closest there is.
        answer = calls.iter().rev().find_map(|call| call.outcome.as_ref().ok().cloned()).unwrap_or_default();
    }
    let mut json = Map::new();
    json.insert("text".into(), json!(answer.trim()));
    json.insert("rounds".into(), json!(calls.iter().map(|call| call.round).max().unwrap_or(0) + 1));
    json.insert(
        "calls".into(),
        json!(calls
            .iter()
            .map(|call| {
                let mut row = json!({"round": call.round, "to": call.to, "task": call.task, "durationMs": call.ms});
                if let Some(folder) = &call.folder {
                    row["folder"] = json!(folder);
                }
                match &call.outcome {
                    Ok(text) => row["text"] = json!(text),
                    Err(error) => row["error"] = json!(error),
                }
                row
            })
            .collect::<Vec<_>>()),
    );
    if let Some(agent) = &lead_agent {
        json.insert("lead".into(), json!(agent.name));
    }
    if desk {
        let files = files_in(&cwd);
        if !files.is_empty() {
            json.insert("folder".into(), json!(cwd));
            json.insert("files".into(), json!(files));
        }
    }
    reply.stamp(&mut json, started);
    Ok(vec![vec![output_item(ctx, 0, Value::Object(json))]])
}

async fn run_helper(ctx: &NodeCtx, helpers: &[Helper], to: &str, task: &str, place: &Place) -> Result<String, String> {
    let Some(helper) = helpers.iter().find(|helper| helper.name() == to) else {
        return Err(format!("There is no helper called {to}"));
    };
    match helper {
        Helper::Agent(agent) => {
            let answer = ask_agent(ctx, agent, task, "", place, None, None).await;
            answer.outcome.map(|(reply, _)| reply.text.trim().to_string()).map_err(|error| error.to_string())
        }
        Helper::Flow(tool) => {
            let arguments = match serde_json::from_str::<Value>(task.trim()) {
                Ok(Value::Object(fields)) => Value::Object(fields),
                _ => json!({ "task": task.trim() }),
            };
            let call = super::super::tools::ToolCall { id: String::new(), name: tool.name.clone(), arguments };
            let mut log = Vec::new();
            let result = super::super::tools::run_call(ctx, std::slice::from_ref(tool), call, &mut log).await;
            if result.error {
                Err(result.text)
            } else {
                Ok(result.text)
            }
        }
    }
}

// --------------------------------------------------------------------------------------- the team

/// «Equipo de agentes»: a run of one of the workspace's teams on one repository — its lead plans, its
/// members work in parallel, each in a worktree, and the work lands on the branch chosen.
pub(super) async fn team(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let team_id = text(&params, "team");
    if team_id.trim().is_empty() {
        return Err(NodeError::failed("Choose one of your agent teams"));
    }
    let project_id = text(&params, "project");
    if project_id.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository the team works in"));
    }
    let goal = text(&params, "prompt");
    if goal.trim().is_empty() {
        return Err(NodeError::failed("Tell the team what to do"));
    }
    let hours = number(&params, "timeoutHours").unwrap_or(0.0);
    let request = TeamRequest {
        node_id: ctx.node.id.clone(),
        node_name: ctx.node.name.clone(),
        team_id: team_id.trim().to_string(),
        goal: goal.trim().to_string(),
        title: text(&params, "title"),
        project_id: project_id.trim().to_string(),
        target_branch: text(&params, "targetBranch"),
        wait: params.get("waitEnd").and_then(Value::as_bool).unwrap_or(true),
        decide_in_flow: text(&params, "decideIn") != "inAgents",
        wait_timeout: (hours > 0.0).then(|| Duration::from_secs_f64(hours * 3600.0)),
    };
    let outcome = ctx.run.host.team_run(request, ctx.cancel.clone()).await.map_err(failure_of)?;
    Ok(vec![vec![output_item(ctx, 0, outcome)]])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str) -> RosterAgent {
        RosterAgent { name: name.into(), ..Default::default() }
    }

    fn said(name: &str, text: &str) -> Answer {
        Answer { agent: agent(name), outcome: Ok((Reply { text: text.into(), ..Default::default() }, None)), ms: 1, folder: None }
    }

    #[test]
    fn the_majority_wins_and_a_tie_goes_to_the_first() {
        let answers = vec![said("Ana", "Sí."), said("Beto", "no"), said("Caro", "  sí "), Answer { agent: agent("Dani"), outcome: Err(NodeError::failed("x")), ms: 1, folder: None }];
        let json = majority(&answers);
        assert_eq!(json["text"], "Sí.");
        assert_eq!(json["votes"], 2);
        assert_eq!(json["of"], 3);
        assert_eq!(json["unanimous"], false);
        assert_eq!(json["tally"][0]["agents"], json!(["Ana", "Caro"]));
        let tie = majority(&[said("Ana", "rojo"), said("Beto", "azul")]);
        assert_eq!(tie["text"], "rojo");
    }

    #[test]
    fn a_persona_carries_role_and_instructions() {
        let mut writer = agent("Redactora");
        writer.role = "escribe informes".into();
        writer.prompt = "Sé breve.".into();
        assert_eq!(with_persona(&writer, Some("Responde en inglés.")), "Eres «Redactora», escribe informes.\n\nSé breve.\n\nResponde en inglés.");
        assert_eq!(with_persona(&agent("X"), None), "Eres «X».");
    }

    #[test]
    fn the_last_round_must_answer() {
        let helpers = vec![Helper::Agent(agent("Ana"))];
        assert!(!lead_prompt("objetivo", &helpers, &[], 1, 3, 4, false).contains("ÚLTIMA"));
        assert!(lead_prompt("objetivo", &helpers, &[], 3, 3, 4, true).contains("ÚLTIMA"));
        let schema = lead_schema(&["Ana".into()]);
        assert_eq!(schema["properties"]["calls"]["items"]["properties"]["to"]["enum"], json!(["Ana"]));
    }
}
