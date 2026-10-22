//! The app's interface as actions anything can run — «Codi», a chat's agent (`cf ui`, the app's MCP
//! server), the local model.
//!
//! **The catalogue is the windows'.** What an action does lives where the stores are, in the
//! webview (`src/lib/codi/actions`), so every window registers the actions it can run at boot
//! ([`register`]) and answers requests addressed to it (`codi:act` → `codi_act_result`). This module
//! only routes: it knows which window holds what — an app detached into an island runs its actions
//! there — and waits for the answer.
//!
//! **One catalogue, three doors.** The same list becomes the generic tools every engine sees
//! (`ui_state`, `ui_actions`, `ui_act` — [`generic_tools`]) and the typed ones a small local model
//! needs ([`typed_tools`]): measured on Qwen3 4B (2026-10-21), one tool per action was right 16 times
//! of 16 at 0.9 s, the generic one 14 of 16 at 2.3 s — a typed call is a third of the tokens.
//!
//! **What destroys is confirmed first, by a person.** An action marked `destructive` (push, run a
//! command, delete…) runs only after a yes: Codi's own card and voice when Codi is on, the app's
//! approval dialog otherwise. Nothing an engine says can skip it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// A request to one window: `{ id, window, action, params }`.
pub const ACT_EVENT: &str = "codi:act";
/// How long a window has to answer. A dialog an action opens returns at once; nothing here waits
/// on the user except the confirmation, which happens before the request is sent.
const ACT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Read,
    Navigate,
    Write,
    Destructive,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Words {
    #[serde(default)]
    pub es: Vec<String>,
    #[serde(default)]
    pub en: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Title {
    #[serde(default)]
    pub es: String,
    #[serde(default)]
    pub en: String,
}

/// One action, as a window registered it (`CodiActionSpec` in `codiCommands.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSpec {
    pub id: String,
    pub title: Title,
    #[serde(default)]
    pub aliases: Option<Words>,
    /// For a param, for each of its enum values, the names a user says for it.
    #[serde(default)]
    pub vocabulary: Option<HashMap<String, HashMap<String, Words>>>,
    /// JSON Schema of the params (an object schema).
    pub params: Value,
    pub risk: Risk,
    /// `main` · `any` · `app:<key>`.
    #[serde(rename = "where")]
    pub place: String,
    #[serde(default)]
    pub frequent: bool,
}

impl ActionSpec {
    pub fn title(&self, lang: &str) -> &str {
        if lang == "es" && !self.title.es.is_empty() {
            &self.title.es
        } else {
            &self.title.en
        }
    }

    /// The tool name an engine calls it by: dots are not allowed in a function's name.
    pub fn tool_name(&self) -> String {
        self.id.replace('.', "_")
    }
}

/// What a window answered.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActResult {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Option<Value>,
    /// What Codi says when the action alone answers the order.
    #[serde(default)]
    pub say: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Every window's actions, by its label. Main's are the catalogue; an island's add the ones only it
/// can run.
fn catalogue() -> &'static Mutex<HashMap<String, Vec<ActionSpec>>> {
    static CATALOGUE: OnceLock<Mutex<HashMap<String, Vec<ActionSpec>>>> = OnceLock::new();
    CATALOGUE.get_or_init(Default::default)
}

fn pending() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<ActResult>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<ActResult>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// A window's catalogue, replacing what it registered before (a reload registers again).
pub fn register(window: &str, actions: Vec<ActionSpec>) {
    if let Ok(mut held) = catalogue().lock() {
        held.insert(window.to_string(), actions);
    }
}

/// A window that closed takes its actions with it.
pub fn forget(window: &str) {
    if let Ok(mut held) = catalogue().lock() {
        held.remove(window);
    }
}

/// Every action once, main's first.
pub fn specs() -> Vec<ActionSpec> {
    let Ok(held) = catalogue().lock() else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut all = Vec::new();
    let mut windows: Vec<&String> = held.keys().collect();
    windows.sort_by_key(|label| (label.as_str() != "main", label.as_str()));
    for window in windows {
        for spec in &held[window] {
            if seen.insert(spec.id.clone()) {
                all.push(spec.clone());
            }
        }
    }
    all
}

pub fn spec(id: &str) -> Option<ActionSpec> {
    let id = id.trim();
    // An engine may call a typed tool's name (`app_open`) where the id (`app.open`) was meant.
    specs().into_iter().find(|spec| spec.id == id || spec.tool_name() == id)
}

/// Whether any window has registered yet — before that there is nothing to drive.
pub fn ready() -> bool {
    catalogue().lock().is_ok_and(|held| !held.is_empty())
}

/// Which window runs `spec`: an app's island when it is detached, else main.
fn window_for(app: &AppHandle, spec: &ActionSpec) -> String {
    if let Some(key) = spec.place.strip_prefix("app:") {
        if let Some(label) = crate::windows::satellite_for_app(&app.state::<crate::windows::SatelliteRegistry>(), key) {
            return label;
        }
    }
    "main".to_string()
}

/// Sends `action` to `window` and waits for its answer.
async fn send(app: &AppHandle, window: &str, action: &str, params: &Value) -> Result<ActResult, String> {
    let id = format!("act-{}", NEXT.fetch_add(1, Ordering::SeqCst));
    let (sender, receiver) = tokio::sync::oneshot::channel();
    pending().lock().map_err(|e| e.to_string())?.insert(id.clone(), sender);
    let _ = app.emit(ACT_EVENT, json!({ "id": id, "window": window, "action": action, "params": params }));
    match tokio::time::timeout(ACT_TIMEOUT, receiver).await {
        Ok(Ok(answer)) => Ok(answer),
        _ => {
            if let Ok(mut held) = pending().lock() {
                held.remove(&id);
            }
            Err(format!("The window «{window}» did not answer «{action}»"))
        }
    }
}

/// A window's answer, from `codi_act_result`.
pub fn answer(result: ActResult) {
    let sender = pending().lock().ok().and_then(|mut held| held.remove(&result.id));
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
}

/// Who is asking, for the confirmation of a destructive action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Asker {
    /// Codi: its own card and voice.
    Codi,
    /// An engine through `cf ui` or the app's MCP server: the app's approval dialog.
    Agent,
}

/// What an action that needs a yes shows: its title and its params, verbatim.
pub fn describe(spec: &ActionSpec, params: &Value, lang: &str) -> String {
    let shown = match params {
        Value::Object(map) if map.is_empty() => String::new(),
        Value::Null => String::new(),
        other => format!(" {other}"),
    };
    format!("{}{shown}", spec.title(lang))
}

/// Runs `action` with `params`, wherever it has to run, after a yes when it destroys. `confirmed`
/// says a person already said yes to exactly this (a `ui.press` resent after its confirmation).
pub async fn act(app: &AppHandle, action: &str, params: Value, asker: Asker, confirmed: bool) -> Result<ActResult, String> {
    let spec = spec(action).ok_or_else(|| format!("Unknown action «{action}» — ui_actions lists them"))?;
    let lang = super::lang(app);
    if spec.risk == Risk::Destructive && !confirmed {
        let what = describe(&spec, &params, lang);
        let yes = match asker {
            Asker::Codi => super::confirm(app, &spec.id, &params, &what).await,
            Asker::Agent => crate::agentcli::guard(app, &format!("{} {}", spec.id, params), &what, "").await.is_ok(),
        };
        if !yes {
            return Ok(ActResult { ok: false, error: Some("The user said no".into()), ..ActResult::default() });
        }
    }
    let window = window_for(app, &spec);
    let mut params = params;
    if spec.risk == Risk::Destructive {
        // The window's own guard (a destructive-looking button pressed through `ui.press`) reads it.
        if let Value::Object(map) = &mut params {
            map.insert("confirmed".into(), Value::Bool(true));
        }
    }
    let answered = send(app, &window, &spec.id, &params).await?;
    // A press the window itself judged destructive: asked here, then sent again.
    if !answered.ok && answered.error.as_deref() == Some("needs-confirmation") && !confirmed {
        let what = describe(&spec, &params, lang);
        let yes = match asker {
            Asker::Codi => super::confirm(app, &spec.id, &params, &what).await,
            Asker::Agent => crate::agentcli::guard(app, &format!("{} {}", spec.id, params), &what, "").await.is_ok(),
        };
        if !yes {
            return Ok(ActResult { ok: false, error: Some("The user said no".into()), ..ActResult::default() });
        }
        if let Value::Object(map) = &mut params {
            map.insert("confirmed".into(), Value::Bool(true));
        }
        return send(app, &window, &spec.id, &params).await;
    }
    Ok(answered)
}

/// What every window shows right now, main first — and one summary line each, which is what goes
/// at the end of an engine's prompt.
pub async fn state(app: &AppHandle) -> Value {
    let mut windows = vec!["main".to_string()];
    windows.extend(crate::windows::satellite_labels(&app.state::<crate::windows::SatelliteRegistry>()));
    let mut shown = Vec::new();
    let mut summary = Vec::new();
    for window in windows {
        let Ok(answered) = send(app, &window, "ui.state", &json!({})).await else { continue };
        if let Some(result) = answered.result {
            if let Some(line) = result.get("summary").and_then(Value::as_str) {
                summary.push(line.to_string());
            }
            shown.push(result);
        }
    }
    json!({ "windows": shown, "summary": summary.join("\n") })
}

/// The compact summary alone — what Codi's prompts end with.
pub async fn summary(app: &AppHandle) -> String {
    state(app).await.get("summary").and_then(Value::as_str).unwrap_or_default().to_string()
}

/// The catalogue as a short list, one line an action: `id {params} — title`.
pub fn catalogue_text(lang: &str) -> String {
    specs()
        .iter()
        .map(|spec| {
            let params = spec
                .params
                .get("properties")
                .and_then(Value::as_object)
                .map(|props| {
                    props
                        .iter()
                        .map(|(name, schema)| match schema.get("enum").and_then(Value::as_array) {
                            Some(values) => format!("{name}: {}", values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("|")),
                            None => name.clone(),
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            format!("{} {{{params}}} — {}", spec.id, spec.title(lang))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One OpenAI-shaped tool per action — `frequent` ones only, for a small model's short list, or all.
pub fn typed_tools(lang: &str, frequent_only: bool) -> Vec<Value> {
    specs()
        .iter()
        .filter(|spec| !frequent_only || spec.frequent)
        .map(|spec| {
            let mut parameters = spec.params.clone();
            if !parameters.is_object() {
                parameters = json!({ "type": "object", "properties": {} });
            }
            json!({ "type": "function", "function": { "name": spec.tool_name(), "description": spec.title(lang), "parameters": parameters } })
        })
        .collect()
}

/// The three tools every engine gets: what is on screen, what can be done, and doing it.
pub fn generic_tools() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "ui_state",
            "What CodeFlow shows right now in every window: workspace, repository, branch, the view, panels, dialogs, islands, the focused field.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "ui_actions",
            "The actions CodeFlow's interface can run, one per line: `id {params} — what it does`. Pass `area` (the id's first part: app, view, repo, git…) to narrow it.",
            json!({ "type": "object", "properties": { "area": { "type": "string" } } }),
        ),
        (
            "ui_act",
            "Runs one action of `ui_actions` in CodeFlow's interface — opening apps and panels, switching workspace, repository or branch, islands, typing into fields, git, services. Destructive ones ask the user first.",
            json!({
                "type": "object",
                "properties": { "action": { "type": "string" }, "params": { "type": "object" } },
                "required": ["action"]
            }),
        ),
    ]
}

/// `ui_actions` narrowed to an area.
pub fn actions_text(lang: &str, area: &str) -> String {
    let area = area.trim().trim_end_matches('.');
    catalogue_text(lang).lines().filter(|line| area.is_empty() || line.starts_with(&format!("{area}."))).collect::<Vec<_>>().join("\n")
}

/// Turns a window's answer into what an engine reads back.
pub fn result_text(result: &ActResult) -> String {
    if result.ok {
        match (&result.say, &result.result) {
            (_, Some(value)) if !value.is_null() => format!("ok: {value}"),
            (Some(said), _) => format!("ok: {said}"),
            _ => "ok".into(),
        }
    } else {
        format!("failed: {}", result.error.clone().unwrap_or_else(|| "no reason given".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str, risk: Risk, place: &str) -> ActionSpec {
        ActionSpec {
            id: id.into(),
            title: Title { es: format!("es {id}"), en: format!("en {id}") },
            aliases: None,
            vocabulary: None,
            params: json!({ "type": "object", "properties": { "app": { "type": "string", "enum": ["flows", "notes"] } }, "required": ["app"] }),
            risk,
            place: place.into(),
            frequent: id == "app.open",
        }
    }

    #[test]
    fn the_catalogue_puts_main_first_and_lists_each_action_once() {
        register("sat-app-notes", vec![spec("notes.create", Risk::Write, "app:notes"), spec("app.open", Risk::Navigate, "any")]);
        register("main", vec![spec("app.open", Risk::Navigate, "main"), spec("git.push", Risk::Destructive, "main")]);
        let all = specs();
        let ids: Vec<&str> = all.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["app.open", "git.push", "notes.create"]);
        assert_eq!(all[0].place, "main", "main's copy wins");
        assert!(super::spec("app_open").is_some(), "a typed tool's name finds its action");
        let typed = typed_tools("es", true);
        assert_eq!(typed.len(), 1);
        assert_eq!(typed[0]["function"]["name"], "app_open");
        assert_eq!(typed[0]["function"]["description"], "es app.open");
        assert!(catalogue_text("en").contains("app.open {app: flows|notes} — en app.open"));
        assert_eq!(actions_text("en", "git").lines().count(), 1);
        forget("sat-app-notes");
        assert!(super::spec("notes.create").is_none());
        forget("main");
    }

    #[test]
    fn a_destructive_action_reads_the_way_it_will_be_confirmed() {
        let push = spec("git.push", Risk::Destructive, "main");
        assert_eq!(describe(&push, &json!({}), "es"), "es git.push");
        assert_eq!(describe(&push, &json!({ "force": true }), "en"), "en git.push {\"force\":true}");
    }

    #[test]
    fn results_read_back_short() {
        assert_eq!(result_text(&ActResult { ok: true, say: Some("Listo".into()), ..Default::default() }), "ok: Listo");
        assert_eq!(result_text(&ActResult { ok: false, error: Some("nope".into()), ..Default::default() }), "failed: nope");
        assert_eq!(result_text(&ActResult { ok: true, result: Some(json!({ "repo": "api" })), ..Default::default() }), "ok: {\"repo\":\"api\"}");
    }
}
