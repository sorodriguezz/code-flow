//! Routines: fixed instructions the user writes once and starts with a sentence (the user,
//! 2026-10-22: «tener instrucciones fijas escritas, que por ejemplo si digo "codi el tiempo", busque
//! el tiempo para San Miguel, analice lo que dice y lo lea»).
//!
//! A routine is a few sentences that start it — `el tiempo`, `el tiempo en {lugar}`, where a `{slot}`
//! takes whatever words are said there and falls back to its default — and steps run in order:
//! search the web, read a page, read another app's window, open something, run a command, run one
//! of Codi's actions, say a sentence, and answer an instruction from everything read so far.
//!
//! **Matched before anything else** (`brain::think`), whole-sentence and without a model: a routine
//! is the user's own words for it, so «Codi, el tiempo» never waits for an engine to decide what it
//! meant. Only the answer step reads with one (`web::answer`).
//!
//! Kept as JSON in one setting (`codi_routines`); with none saved, three examples are offered (the
//! weather, the news, Teams' messages) — saved the first time the user edits the list.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::router::normalize;

pub const KEY: &str = "codi_routines";

/// How many routines run at once.
const MAX_RUNNING: usize = 3;
static RUNNING: AtomicUsize = AtomicUsize::new(0);
/// What a routine may hold.
const MAX_ROUTINES: usize = 50;
const MAX_STEPS: usize = 20;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub name: String,
    /// The sentences that start it; `{slot}` takes words.
    pub phrases: Vec<String>,
    /// What a slot is when nothing was said for it.
    #[serde(default)]
    pub defaults: BTreeMap<String, String>,
    pub steps: Vec<Step>,
    #[serde(default = "on")]
    pub enabled: bool,
}

fn on() -> bool {
    true
}

fn two() -> u8 {
    2
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Step {
    /// Searches the web and reads the first `pages` results.
    Search {
        query: String,
        #[serde(default = "two")]
        pages: u8,
    },
    /// Reads one page.
    Read { url: String },
    /// Reads another app's front window (`desktop::read`).
    #[serde(rename = "readApp")]
    ReadApp { app: String },
    /// Opens an app, an address, a file or a folder (`desktop::open`).
    Open { target: String },
    /// Says a sentence.
    Say { text: String },
    /// Runs a shell command out of sight; what it printed is read like a page.
    Command {
        command: String,
        #[serde(default)]
        cwd: String,
    },
    /// Runs one of Codi's actions (`app.open`, `flow.run`…) — confirmed as always when it destroys.
    Action {
        action: String,
        #[serde(default)]
        params: Value,
    },
    /// Answers `instruction` from what the steps before it read, aloud.
    Answer { instruction: String },
}

impl Step {
    /// A step left half written in the editor — no query, no app, no command: skipped, not failed.
    fn blank(&self) -> bool {
        let main = match self {
            Step::Search { query, .. } => query,
            Step::Read { url } => url,
            Step::ReadApp { app } => app,
            Step::Open { target } => target,
            Step::Say { text } => text,
            Step::Command { command, .. } => command,
            Step::Action { action, .. } => action,
            Step::Answer { instruction } => instruction,
        };
        main.trim().is_empty()
    }

    /// Whether this step leaves material for an answer.
    fn reads(&self) -> bool {
        matches!(self, Step::Search { .. } | Step::Read { .. } | Step::ReadApp { .. } | Step::Command { .. })
    }
}

/// The three a new installation starts with.
pub fn examples() -> Vec<Routine> {
    let routine = |id: &str, name: &str, phrases: &[&str], defaults: &[(&str, &str)], steps: Vec<Step>| Routine {
        id: id.into(),
        name: name.into(),
        phrases: phrases.iter().map(|p| p.to_string()).collect(),
        defaults: defaults.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        steps,
        enabled: true,
    };
    vec![
        routine(
            "weather",
            "El tiempo",
            &["el tiempo", "el tiempo en {lugar}", "el clima", "el clima en {lugar}", "que tiempo hace", "que tiempo hace en {lugar}", "como esta el tiempo", "the weather", "the weather in {lugar}"],
            &[("lugar", "San Miguel, Santiago")],
            vec![
                Step::Search { query: "tiempo en {lugar} hoy".into(), pages: 2 },
                Step::Answer { instruction: "Di qué tiempo hace ahora en {lugar}: la temperatura actual, la mínima y la máxima de hoy, y si va a llover.".into() },
            ],
        ),
        routine(
            "news",
            "Las noticias",
            &["las noticias", "noticias", "las noticias de {tema}", "noticias de {tema}", "the news"],
            &[("tema", "Chile")],
            vec![
                Step::Search { query: "noticias {tema} hoy".into(), pages: 2 },
                Step::Answer { instruction: "Cuenta los tres titulares más importantes de hoy, una frase cada uno.".into() },
            ],
        ),
        routine(
            "teams",
            "Mensajes de Teams",
            &["mis mensajes de teams", "mensajes de teams", "lee teams", "leeme teams", "que dice teams", "tengo mensajes en teams", "my teams messages"],
            &[],
            vec![
                Step::ReadApp { app: "Microsoft Teams".into() },
                Step::Answer { instruction: "Di si hay mensajes nuevos o sin leer y de quién, y resume los últimos en dos frases.".into() },
            ],
        ),
    ]
}

/// The routines saved, or the examples while none are.
pub fn load(app: &AppHandle) -> Vec<Routine> {
    let raw = app
        .try_state::<crate::db::Db>()
        .and_then(|db| db.0.lock().ok().and_then(|conn| crate::db::queries::get_setting(&conn, KEY).ok().flatten()));
    match raw.filter(|r| !r.trim().is_empty()) {
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
            crate::applog::warn(&format!("codi: the saved routines could not be read: {error}"));
            Vec::new()
        }),
        None => examples(),
    }
}

/// Checks and saves the list.
pub fn save(app: &AppHandle, routines: &[Routine]) -> Result<(), String> {
    check(routines)?;
    let json = serde_json::to_string(routines).map_err(|e| e.to_string())?;
    let db = app.state::<crate::db::Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    crate::db::queries::set_setting(&conn, KEY, &json).map_err(|e| e.to_string())
}

pub fn check(routines: &[Routine]) -> Result<(), String> {
    if routines.len() > MAX_ROUTINES {
        return Err(format!("at most {MAX_ROUTINES} routines"));
    }
    let mut ids = std::collections::HashSet::new();
    for routine in routines {
        if routine.name.trim().is_empty() {
            return Err("every routine needs a name".into());
        }
        if !ids.insert(routine.id.as_str()) {
            return Err(format!("two routines share the id {}", routine.id));
        }
        if routine.phrases.iter().all(|p| pattern(p).is_empty()) {
            return Err(format!("«{}» needs a sentence that starts it", routine.name));
        }
        if routine.steps.is_empty() || routine.steps.len() > MAX_STEPS {
            return Err(format!("«{}» needs between 1 and {MAX_STEPS} steps", routine.name));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------- matching

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(String),
    Slot(String),
}

/// A phrase as tokens: its words normalized, its `{slots}` named.
fn pattern(phrase: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    for raw in phrase.split_whitespace() {
        let trimmed = raw.trim_matches(|c: char| matches!(c, ',' | '.' | '¿' | '?' | '¡' | '!'));
        if let Some(name) = trimmed.strip_prefix('{').and_then(|t| t.strip_suffix('}')) {
            let name = name.trim();
            if !name.is_empty() {
                tokens.push(Token::Slot(name.to_string()));
            }
            continue;
        }
        tokens.extend(normalize(trimmed).split(' ').filter(|w| !w.is_empty()).map(|w| Token::Word(w.to_string())));
    }
    tokens
}

/// Words that may come before a routine's sentence without being part of it.
const BEFORE: &[&str] = &["codi", "oye", "hey", "ok", "okay", "dime", "dame", "cuentame", "a", "ver", "please", "tell", "me", "porfa", "y", "ahora"];
/// …and after it.
const AFTER: &[&str] = &["por", "favor", "porfa", "please", "hoy", "ahora", "today", "now", "codi"];

/// `words` (normalized, original) against `tokens`; slots take one word or more.
fn matches(tokens: &[Token], words: &[(String, String)], slots: &mut BTreeMap<String, String>) -> bool {
    match tokens.first() {
        None => words.is_empty(),
        Some(Token::Word(word)) => words.first().is_some_and(|(said, _)| said == word) && matches(&tokens[1..], &words[1..], slots),
        Some(Token::Slot(name)) => {
            for take in 1..=words.len() {
                if matches(&tokens[1..], &words[take..], slots) {
                    let value = words[..take].iter().map(|(_, original)| original.as_str()).collect::<Vec<_>>().join(" ");
                    slots.insert(name.clone(), value);
                    return true;
                }
            }
            false
        }
    }
}

/// A routine an order starts, and the words its slots took.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub routine: Routine,
    pub slots: BTreeMap<String, String>,
}

/// The routine `order` is the sentence of — the one with the most fixed words when several are —
/// with the name it was called by (`wake`) and courtesies around it allowed.
pub fn find(routines: &[Routine], order: &str, wake: &[String]) -> Option<Hit> {
    let words: Vec<(String, String)> = order
        .split_whitespace()
        .map(|w| (normalize(w), w.trim_matches(|c: char| !c.is_alphanumeric()).to_string()))
        .filter(|(n, _)| !n.is_empty())
        .collect();
    let skippable = |w: &str| BEFORE.contains(&w) || wake.iter().any(|name| name == w);
    let mut start = 0;
    while start < words.len() && skippable(&words[start].0) {
        start += 1;
    }
    let mut end = words.len();
    while end > start && AFTER.contains(&words[end - 1].0.as_str()) {
        end -= 1;
    }
    let mut best: Option<(usize, Hit)> = None;
    // Every start from the first word on: «oye a ver el tiempo» skips three, but «a» may also be the
    // routine's own first word.
    for from in 0..=start {
        for to in [words.len(), end] {
            if from >= to {
                continue;
            }
            let said = &words[from..to];
            for routine in routines.iter().filter(|r| r.enabled) {
                for phrase in &routine.phrases {
                    let tokens = pattern(phrase);
                    if tokens.is_empty() {
                        continue;
                    }
                    let mut slots = BTreeMap::new();
                    if matches(&tokens, said, &mut slots) {
                        let fixed = tokens.iter().filter(|t| matches!(t, Token::Word(_))).count();
                        if best.as_ref().is_none_or(|(score, _)| fixed > *score) {
                            best = Some((fixed, Hit { routine: routine.clone(), slots }));
                        }
                    }
                }
            }
        }
    }
    best.map(|(_, hit)| hit)
}

/// The routine `name` names (by its name, as a person says it).
pub fn by_name(routines: &[Routine], name: &str) -> Option<Routine> {
    let names: Vec<&str> = routines.iter().map(|r| r.name.as_str()).collect();
    match crate::desktop::apps::pick(&names, name) {
        crate::desktop::apps::Picked::One(i) => Some(routines[i].clone()),
        _ => routines.iter().find(|r| r.id == name).cloned(),
    }
}

/// `{slot}` in `text` replaced by what was said for it, or its default.
fn fill(text: &str, slots: &BTreeMap<String, String>, defaults: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|i| open + i) else { break };
        out.push_str(&rest[..open]);
        let name = rest[open + 1..close].trim();
        out.push_str(slots.get(name).or_else(|| defaults.get(name)).map(String::as_str).unwrap_or(""));
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ------------------------------------------------------------------------------------------ running

/// Runs `routine` with `slots`: what it says at the end (its `say` steps and its answers, in order).
pub async fn run(app: &AppHandle, routine: &Routine, slots: &BTreeMap<String, String>) -> Result<String, String> {
    if RUNNING.fetch_add(1, Ordering::SeqCst) >= MAX_RUNNING {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
        return Err("three routines are already running".into());
    }
    let result = steps(app, routine, slots).await;
    RUNNING.fetch_sub(1, Ordering::SeqCst);
    result
}

async fn steps(app: &AppHandle, routine: &Routine, slots: &BTreeMap<String, String>) -> Result<String, String> {
    let lang = super::lang(app);
    let mut material = String::new();
    // Whether something was read since the last answer: what an answer at the end is owed.
    let mut unread = false;
    let mut said: Vec<String> = Vec::new();
    // Another app's text was read and the user keeps that to the local model.
    let mut private = false;
    let text = |s: &str| fill(s, slots, &routine.defaults);
    for (index, step) in routine.steps.iter().enumerate() {
        if step.blank() {
            continue;
        }
        let failed = |error: String| format!("{} {}: {error}", if lang == "es" { "el paso" } else { "step" }, index + 1);
        match step {
            Step::Search { query, pages } => {
                let query = text(query);
                let found = super::web::search(&query, usize::from((*pages).min(4))).await.map_err(failed)?;
                material.push_str(&found);
                material.push('\n');
            }
            Step::Read { url } => {
                let address = text(url);
                let page = super::web::read(&address).await.map_err(failed)?;
                material.push_str(&format!("Página {address}:\n{page}\n"));
            }
            Step::ReadApp { app: name } => {
                let reading = super::read_app(app, &text(name)).await.map_err(failed)?;
                private |= super::read_apps_mode(app) == "local";
                material.push_str(&format!("Texto de la ventana de {} ({}):\n{}\n", reading.app, reading.title, reading.text));
            }
            Step::Open { target } => {
                let target = text(target);
                let es = lang == "es";
                tokio::task::spawn_blocking(move || crate::desktop::open(&target, es)).await.map_err(|e| failed(e.to_string()))?.map_err(|e| failed(e.message))?;
            }
            Step::Say { text: sentence } => said.push(text(sentence)),
            Step::Command { command, cwd } => {
                let folder = Some(text(cwd)).filter(|c| !c.is_empty()).or_else(|| dirs::home_dir().map(|h| h.display().to_string())).unwrap_or_else(|| ".".into());
                let ran = crate::commands::codi_cmd::codi_run_command(folder, text(command)).await.map_err(failed)?;
                material.push_str(&format!("Salida de `{}` (código {}):\n{}\n", text(command), ran.code.map(|c| c.to_string()).unwrap_or_else(|| "—".into()), ran.output));
            }
            Step::Action { action, params } => {
                let params = match params {
                    Value::String(s) => Value::String(text(s)),
                    Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), v.as_str().map(|s| Value::String(text(s))).unwrap_or_else(|| v.clone()))).collect()),
                    other => other.clone(),
                };
                let params = if params.is_null() { Value::Object(Default::default()) } else { params };
                // A routine starting routines would never end.
                if action.starts_with("routine.") {
                    return Err(failed(if lang == "es" { "una rutina no puede ejecutar rutinas".into() } else { "a routine cannot run routines".into() }));
                }
                let result = super::ui::act(app, action, params, super::ui::Asker::Codi, false).await.map_err(failed)?;
                if !result.ok {
                    return Err(failed(result.say.or(result.error).unwrap_or_default()));
                }
                if let Some(line) = result.say.filter(|s| !s.trim().is_empty()) {
                    said.push(line);
                }
            }
            Step::Answer { instruction } => {
                if material.trim().is_empty() {
                    return Err(failed(if lang == "es" { "no hay nada leído que responder".into() } else { "nothing was read to answer from".into() }));
                }
                said.push(super::web::answer_with(app, &text(instruction), &material, private).await.map_err(failed)?);
                unread = false;
                continue;
            }
        }
        if step.reads() {
            unread = true;
        }
    }
    if unread {
        let instruction = if lang == "es" { "Resume lo importante." } else { "Summarize what matters." };
        said.push(super::web::answer_with(app, instruction, &material, private).await?);
    }
    Ok(sentences(&said))
}

/// What a routine said, one sentence after another: «Buenos días Sebastián» and the weather do not
/// run together into one.
fn sentences(said: &[String]) -> String {
    let mut out = String::new();
    for line in said.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !out.is_empty() {
            if !out.ends_with(['.', '!', '?', '…', ':', ';']) {
                out.push('.');
            }
            out.push(' ');
        }
        out.push_str(line);
    }
    out
}

/// The blanks a routine's sentences name, in order.
pub fn slot_names(routine: &Routine) -> Vec<String> {
    let mut names = Vec::new();
    for phrase in &routine.phrases {
        for token in pattern(phrase) {
            if let Token::Slot(name) = token {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
        }
    }
    for name in routine.defaults.keys() {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    names
}

/// A routine an order started, run within the turn when it is quick, else told when it ends. What
/// the turn says now.
pub async fn start(app: &AppHandle, hit: Hit) -> String {
    let lang = super::lang(app);
    let name = hit.routine.name.clone();
    let worker = app.clone();
    let work = async move {
        run(&worker, &hit.routine, &hit.slots).await.map_err(|error| super::native::Failure {
            say: if lang == "es" { format!("No pude con «{}»: {error}", hit.routine.name) } else { format!("I couldn't finish «{}»: {error}", hit.routine.name) },
            error,
            offer: None,
        })
    };
    let still = if lang == "es" { format!("Sigo con «{name}», te aviso.") } else { format!("Still on «{name}», I'll tell you.") };
    let result = super::native::within_turn(app, format!("routine:{name}"), still, work).await;
    result.say.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| if lang == "es" { "Listo.".into() } else { "Done.".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wake() -> Vec<String> {
        vec!["codi".into()]
    }

    #[test]
    fn a_routine_starts_with_its_sentence_and_its_slots_take_words() {
        let routines = examples();
        let hit = find(&routines, "Codi, el tiempo", &wake()).unwrap();
        assert_eq!(hit.routine.id, "weather");
        assert!(hit.slots.is_empty());
        let hit = find(&routines, "oye codi, ¿qué tiempo hace en Puerto Montt?", &wake()).unwrap();
        assert_eq!(hit.routine.id, "weather");
        assert_eq!(hit.slots.get("lugar").map(String::as_str), Some("Puerto Montt"));
        let hit = find(&routines, "el tiempo hoy por favor", &wake()).unwrap();
        assert_eq!(hit.routine.id, "weather");
        assert_eq!(find(&routines, "las noticias de tecnología", &wake()).unwrap().slots.get("tema").map(String::as_str), Some("tecnología"));
        assert_eq!(find(&routines, "lee teams", &wake()).unwrap().routine.id, "teams");
    }

    #[test]
    fn anything_else_is_left_to_the_router_and_the_models() {
        let routines = examples();
        assert_eq!(find(&routines, "abre flujos", &wake()), None);
        assert_eq!(find(&routines, "el tiempo que tarda el build", &wake()), None);
        assert_eq!(find(&routines, "cambia el tiempo de espera", &wake()), None);
        let mut off = examples();
        off[0].enabled = false;
        assert_eq!(find(&off, "el tiempo", &wake()), None);
    }

    #[test]
    fn slots_fill_from_what_was_said_then_the_defaults() {
        let defaults: BTreeMap<String, String> = [("lugar".into(), "San Miguel".into())].into();
        assert_eq!(fill("tiempo en {lugar} hoy", &BTreeMap::new(), &defaults), "tiempo en San Miguel hoy");
        assert_eq!(fill("tiempo en {lugar} hoy", &[("lugar".into(), "Arica".into())].into(), &defaults), "tiempo en Arica hoy");
        assert_eq!(fill("noticias {tema} hoy", &BTreeMap::new(), &defaults), "noticias hoy");
    }

    #[test]
    fn what_a_routine_says_is_one_sentence_after_another() {
        assert_eq!(sentences(&["Buenos días Sebastián".into(), "En San Miguel llueve.".into()]), "Buenos días Sebastián. En San Miguel llueve.");
        assert_eq!(sentences(&["¿Listo?".into(), " ".into(), "Sí".into()]), "¿Listo? Sí");
        assert!(Step::Action { action: " ".into(), params: Value::Null }.blank());
        assert!(!Step::Say { text: "hola".into() }.blank());
    }

    #[test]
    fn the_saved_shape_reads_back_and_is_checked() {
        let json = serde_json::to_string(&examples()).unwrap();
        assert!(json.contains("\"kind\":\"search\"") && json.contains("\"kind\":\"readApp\""), "{json}");
        let back: Vec<Routine> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, examples());
        let mut bad = examples();
        bad[1].id = "weather".into();
        assert!(check(&bad).is_err());
        let mut empty = examples();
        empty[0].steps.clear();
        assert!(check(&empty).is_err());
    }
}
