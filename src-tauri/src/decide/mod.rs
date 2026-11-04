//! The decision layer: «the model writes, the decider decides, the code acts».
//!
//! A team run makes many small, finite choices — retry a failed item or hand it on, which way a
//! question goes — that used to cost a full planner turn each. Here a choice is put to a cheap voter
//! several times ("forks"); the share of votes the winner got is its probability `p`. When `p`
//! reaches the threshold the choice is **sharp** and the code acts on it; when the votes split, the
//! decision **escalates** to the planner, the advisor or the user, exactly as before this existed.
//!
//! Voters, cheapest first and all opt-in: the local model the user downloaded in Settings
//! (`crate::hybrid`, free), else the cloud's fast model (Haiku for Claude, through
//! `ai::decide_vote`). An adapter for an external decision service (Jev) is a config value away and
//! stays off until its API is reachable. Every decision is logged (`agent_decisions`) so the live
//! view can show what was decided, how sure, and what it saved.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::crew::{self, DecisionRow};
use crate::db::{queries, Db};

pub const SETTING_KEY: &str = "agents_decider";

/// Tokens a planner turn costs on average — what a sharp decision saves, for the live view's tally.
pub const PLANNER_TURN_TOKENS: i64 = 6_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config {
    pub enabled: bool,
    /// `auto` (local if ready, else cloud), `local`, `cloud`, `jev` (an external service), `off`.
    pub engine: String,
    /// Votes per decision.
    pub forks: i64,
    /// The share of votes a choice needs to be acted on.
    pub threshold: f64,
    /// The same for risky choices (running something destructive), which should almost never be
    /// decided without a person.
    pub risk_threshold: f64,
    /// The Jev endpoint, when there is one.
    pub jev_url: String,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: true, engine: "auto".into(), forks: 5, threshold: 0.8, risk_threshold: 0.95, jev_url: String::new() }
    }
}

impl Config {
    pub fn sane(mut self) -> Self {
        if !["auto", "local", "cloud", "jev", "off"].contains(&self.engine.as_str()) {
            self.engine = "auto".into();
        }
        self.forks = self.forks.clamp(1, 9);
        self.threshold = if self.threshold.is_finite() { self.threshold.clamp(0.5, 1.0) } else { 0.8 };
        self.risk_threshold = if self.risk_threshold.is_finite() { self.risk_threshold.clamp(self.threshold, 1.0) } else { 0.95 };
        self
    }
}

pub fn read_config(conn: &rusqlite::Connection) -> Config {
    queries::get_setting(conn, SETTING_KEY).ok().flatten().and_then(|raw| serde_json::from_str::<Config>(&raw).ok()).unwrap_or_default().sane()
}

#[derive(Debug, Clone, Default)]
pub struct Decision {
    /// `retry`, `route`, `model`, `risk`, `ask`, `review`.
    pub kind: String,
    pub question: String,
    pub options: Vec<String>,
    pub context: String,
    pub workspace_id: String,
    pub run_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Verdict {
    pub choice: Option<String>,
    pub p: f64,
    pub sharp: bool,
    pub source: String,
    pub votes: Vec<String>,
    pub ms: i64,
}

/// The winner of a vote and its share. Votes outside the options do not count for any of them
/// but do count in the total — a voter that cannot answer is not agreement.
pub fn tally(votes: &[String], options: &[String]) -> (Option<String>, f64) {
    if votes.is_empty() || options.is_empty() {
        return (None, 0.0);
    }
    let mut best: Option<(&String, usize)> = None;
    for option in options {
        let count = votes.iter().filter(|v| v.trim().eq_ignore_ascii_case(option)).count();
        if count > 0 && best.is_none_or(|(_, c)| count > c) {
            best = Some((option, count));
        }
    }
    match best {
        Some((choice, count)) => (Some(choice.clone()), count as f64 / votes.len() as f64),
        None => (None, 0.0),
    }
}

fn schema(options: &[String]) -> Value {
    serde_json::json!({
        "type": "object",
        "properties": { "choice": { "type": "string", "enum": options } },
        "required": ["choice"],
        "additionalProperties": false
    })
}

const SYSTEM: &str = "Eres la capa de decisión de un equipo de agentes de programación. Te hacen una pregunta cerrada \
    con opciones fijas. Elige la opción más razonable con el contexto dado. Responde solo con JSON: {\"choice\": \"<opción>\"}.";

fn prompt(d: &Decision) -> String {
    format!("Pregunta: {}\nOpciones: {}\n\nContexto:\n{}", d.question, d.options.join(" | "), d.context.chars().take(4_000).collect::<String>())
}

fn choice_of(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let value: Value = serde_json::from_str(&text[start..=end]).ok()?;
    value.get("choice").and_then(Value::as_str).map(|s| s.trim().to_string())
}

async fn local_votes(db: &Db, d: &Decision, forks: i64) -> Result<Vec<String>, String> {
    use crate::hybrid::local_llm::{self, BackendKind, ChatRequest};
    let settings = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::hybrid::config::read(&conn)?
    };
    let resolved = crate::hybrid::runtime::resolve(&settings, crate::hybrid::runtime::Freshness::Recent).await;
    if let Some(error) = resolved.error.clone() {
        return Err(error);
    }
    let model = resolved.model.clone().ok_or("no hay un modelo local listo")?;
    let live = crate::hybrid::runtime::connect(resolved.kind, &resolved.url, &model, resolved.ctx).await?;
    let user = prompt(d);
    let schema = schema(&d.options);
    let mut votes = Vec::new();
    for _ in 0..forks {
        let request = ChatRequest {
            model: &live.model,
            system: SYSTEM,
            user: &user,
            num_ctx: (live.endpoint.kind == BackendKind::Ollama).then_some(resolved.ctx),
            max_tokens: 32,
            temperature: 0.8,
            think: Some(false),
            keep_alive: (live.endpoint.kind == BackendKind::Ollama).then_some("5m"),
            schema: Some(&schema),
        };
        match crate::hybrid::scheduler::background(local_llm::chat(&live.endpoint, &request, |_| {}, std::future::pending::<()>())).await {
            Ok(outcome) => votes.push(choice_of(&outcome.text).unwrap_or_default()),
            Err(error) => return if votes.is_empty() { Err(error.sentence()) } else { Ok(votes) },
        }
    }
    Ok(votes)
}

async fn cloud_votes(db: &Db, d: &Decision, forks: i64) -> Result<Vec<String>, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let workspace = (!d.workspace_id.is_empty()).then_some(d.workspace_id.as_str());
        crate::commands::claude_cmd::load_ai_config_in(&conn, crate::commands::claude_cmd::AiTask::ChatTitle, workspace)?
    };
    let model = if config.model.is_empty() { config.engine.commit_message_model().to_string() } else { config.model.clone() };
    let schema = schema(&d.options).to_string();
    let question = prompt(d);
    // Cloud votes are not free: three at most, and in parallel.
    let n = forks.clamp(1, 3) as usize;
    let calls = (0..n).map(|_| crate::ai::decide_vote(&*config.engine, &config.binary, &model, SYSTEM, &question, &schema));
    let answers = futures_util::future::join_all(calls).await;
    let votes: Vec<String> = answers.into_iter().filter_map(|a| a.ok()).map(|text| choice_of(&text).unwrap_or_default()).collect();
    if votes.is_empty() {
        return Err("el modelo rápido no respondió".into());
    }
    Ok(votes)
}

/// Puts a decision to the voters and logs it. Never fails: a voter that cannot run is a split
/// decision, which leaves the choice to whoever made it before this layer existed.
pub async fn decide(db: &Db, d: Decision) -> Verdict {
    let config = db.0.lock().map(|c| read_config(&c)).unwrap_or_default();
    let started = Instant::now();
    let threshold = if d.kind == "risk" { config.risk_threshold } else { config.threshold };
    let (votes, source) = if !config.enabled || config.engine == "off" {
        (Vec::new(), "off".to_string())
    } else {
        match config.engine.as_str() {
            "local" => (local_votes(db, &d, config.forks).await.unwrap_or_default(), "local".to_string()),
            "cloud" => (cloud_votes(db, &d, config.forks).await.unwrap_or_default(), "cloud".to_string()),
            // The external service has no adapter yet: decisions escalate as if it were off.
            "jev" => (Vec::new(), "jev".to_string()),
            _ => match local_votes(db, &d, config.forks).await {
                Ok(votes) if !votes.is_empty() => (votes, "local".to_string()),
                _ => (cloud_votes(db, &d, config.forks).await.unwrap_or_default(), "cloud".to_string()),
            },
        }
    };
    let (choice, p) = tally(&votes, &d.options);
    let sharp = choice.is_some() && p >= threshold;
    let verdict = Verdict { choice: choice.clone(), p, sharp, source: if votes.is_empty() { "escalated".into() } else { source }, votes, ms: started.elapsed().as_millis() as i64 };
    if let Ok(conn) = db.0.lock() {
        let _ = crew::decision_insert(
            &conn,
            &DecisionRow {
                workspace_id: d.workspace_id.clone(),
                run_id: d.run_id.clone(),
                item_id: d.item_id.clone(),
                kind: d.kind.clone(),
                question: d.question.clone(),
                options: d.options.clone(),
                choice: choice.unwrap_or_default(),
                p,
                sharp,
                source: verdict.source.clone(),
                votes: verdict.votes.clone(),
                ms: verdict.ms,
                saved_tokens: if sharp { PLANNER_TURN_TOKENS } else { 0 },
                ..Default::default()
            },
        );
    }
    verdict
}

#[tauri::command]
pub fn decider_config(db: tauri::State<'_, Db>) -> Config {
    db.0.lock().map(|c| read_config(&c)).unwrap_or_default()
}

#[tauri::command]
pub fn decider_set(db: tauri::State<'_, Db>, config: Config) -> Result<Config, String> {
    let config = config.sane();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_setting(&conn, SETTING_KEY, &serde_json::to_string(&config).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(config)
}

/// Tries the layer with a sample question — Settings' «Probar», which shows which voter answered
/// and how sure it was.
#[tauri::command]
pub async fn decider_try(db: tauri::State<'_, Db>) -> Result<Verdict, String> {
    let decision = Decision {
        kind: "retry".into(),
        question: "Un test falló por un timeout de red al descargar dependencias. ¿Qué conviene?".into(),
        options: vec!["reintentar".into(), "escalar".into(), "replanificar".into()],
        context: "Primer intento. El error es «ETIMEDOUT registry.npmjs.org». El código no cambió.".into(),
        ..Default::default()
    };
    Ok(decide(db.inner(), decision).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn tally_counts_agreement_over_every_vote() {
        let options = v(&["reintentar", "escalar"]);
        assert_eq!(tally(&v(&["reintentar", "reintentar", "escalar", "reintentar", "reintentar"]), &options), (Some("reintentar".into()), 0.8));
        assert_eq!(tally(&v(&["escalar", "?", "?"]), &options), (Some("escalar".into()), 1.0 / 3.0));
        assert_eq!(tally(&v(&["?", "nada"]), &options), (None, 0.0));
        assert_eq!(tally(&[], &options), (None, 0.0));
    }

    #[test]
    fn reads_the_choice_out_of_the_answer() {
        assert_eq!(choice_of("```json\n{\"choice\": \"escalar\"}\n```").as_deref(), Some("escalar"));
        assert_eq!(choice_of("no sé"), None);
    }

    #[test]
    fn config_is_clamped() {
        let config = Config { engine: "x".into(), forks: 40, threshold: 0.1, risk_threshold: 0.2, ..Default::default() }.sane();
        assert_eq!(config.engine, "auto");
        assert_eq!(config.forks, 9);
        assert_eq!(config.threshold, 0.5);
        assert!(config.risk_threshold >= config.threshold);
    }

    #[tokio::test]
    async fn an_engine_that_is_off_escalates_and_is_logged() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        queries::set_setting(&conn, SETTING_KEY, r#"{"engine":"off"}"#).unwrap();
        let db = Db::new(conn);
        let verdict = decide(&db, Decision { kind: "retry".into(), question: "q".into(), options: v(&["a", "b"]), run_id: "r".into(), ..Default::default() }).await;
        assert!(!verdict.sharp);
        assert_eq!(verdict.source, "escalated");
        let rows = crew::decisions_for_run(&db.0.lock().unwrap(), "r", 10).unwrap();
        assert_eq!(rows.len(), 1);
    }
}
