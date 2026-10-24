//! Codi's actions that need no window: what it does on the computer around CodeFlow — open an app or
//! a site, answer from the web, read another app, run the user's routines — and the two windows it
//! raises itself (the main window, the quick ask).
//!
//! **Why here and not in a window's catalogue** (the user, 2026-10-22: «quiero que Codi también haga
//! cosas en el sistema aunque la ventana principal esté abierta o hayan islas»): every other action
//! is run by the webview that registered it, and the main one may be hidden since login, closed to
//! the tray, or behind islands. These run in the backend, so they answer the same whatever is on
//! screen — before any window has registered at all.
//!
//! Each is an `ActionSpec` like any other (`where: "native"`), so the router, the local model's
//! tools, `cf ui` and the MCP server see one catalogue; `ui::act` runs them here.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::ui::{ActResult, ActionSpec, Offer};

/// Where these live in the catalogue.
pub const PLACE: &str = "native";
/// How long a turn waits for one of them before saying it is still at it and telling the end later.
const ANSWER_WITHIN: Duration = Duration::from_secs(9);

fn spec(value: Value) -> ActionSpec {
    serde_json::from_value(value).expect("a native action's spec is written right")
}

/// The native actions, as the catalogue lists them.
pub fn specs() -> Vec<ActionSpec> {
    let object = |properties: Value, required: &[&str]| json!({ "type": "object", "properties": properties, "required": required });
    let text = |description: &str| json!({ "type": "string", "description": description, "minLength": 1 });
    let optional = |description: &str| json!({ "type": "string", "description": description });
    vec![
        spec(json!({
            "id": "app.front",
            "title": {
                "en": "Bring CodeFlow's main window back on screen and to the front — also when it was closed (it goes on running in the background) or is behind another app.",
                "es": "Trae la ventana principal de CodeFlow de vuelta a la pantalla y al frente, también cuando se cerró (sigue corriendo en segundo plano) o está detrás de otra app."
            },
            "aliases": {
                "es": ["trae la aplicacion al frente", "trae la app al frente", "trae la aplicacion", "trae la app", "trae codeflow", "trae la ventana",
                       "trae la ventana principal", "muestra la aplicacion", "muestra la app", "muestra codeflow", "abre codeflow", "abre la aplicacion",
                       "abre la app", "abre la ventana principal", "vuelve a abrir la app", "reabre la app", "pon la app al frente", "trae al frente"],
                "en": ["bring the app forward", "bring the app back", "bring codeflow back", "bring it to the front", "show the app", "show codeflow", "open codeflow", "open the app", "open the main window", "reopen the app"]
            },
            "params": object(json!({}), &[]),
            "risk": "navigate",
            "where": PLACE
        })),
        spec(json!({
            "id": "quick.open",
            "title": {
                "en": "Open a new quick ask — CodeFlow's small question box, on top of whatever is on screen — with `question` already written in it when given (the user sends it).",
                "es": "Abre una nueva consulta rápida —la caja de preguntas pequeña de CodeFlow, encima de lo que haya en pantalla— con `question` ya escrita cuando se da (el usuario la envía)."
            },
            "aliases": {
                "es": ["nueva consulta rapida", "abre una consulta rapida", "abre la consulta rapida", "consulta rapida", "abre una pregunta rapida", "pregunta rapida"],
                "en": ["new quick ask", "open a quick ask", "open the quick ask", "quick ask", "quick question"]
            },
            "params": object(json!({ "question": optional("What to write in the box, when the user said it.") }), &[]),
            "risk": "navigate",
            "where": PLACE
        })),
        spec(json!({
            "id": "system.open",
            "title": {
                "en": "Open something outside CodeFlow: an installed app by its name (Teams, Outlook, Chrome, the browser…), a web address (emol.com), a file or a folder. CodeFlow's own apps open with app.open.",
                "es": "Abre algo fuera de CodeFlow: una app instalada por su nombre (Teams, Outlook, Chrome, el navegador…), una dirección web (emol.com), un archivo o una carpeta. Las apps de CodeFlow se abren con app.open."
            },
            // Not a bare «inicia» or «lanza»: services, meetings and queries are started with those.
            "aliases": {
                "es": ["abre la app de", "abre el programa", "abre la aplicacion de", "abre el navegador", "abre la pagina", "abre el sitio", "entra a la pagina"],
                "en": ["open the program", "open the browser", "open the website", "open the page"]
            },
            "params": object(json!({ "target": text("The app's name as said, a web address, or a file or folder path.") }), &["target"]),
            // Opening another app changes nothing in CodeFlow.
            "risk": "write",
            "where": PLACE
        })),
        spec(json!({
            "id": "web.search",
            "title": {
                "en": "Answer a question about the world from the web — the weather, the news, a price, a fact, a date — by searching and reading the first pages in the background; the answer is said. With show, open the search in the browser instead. Never for the user's code or CodeFlow's data.",
                "es": "Responde una pregunta sobre el mundo desde la web —el tiempo, las noticias, un precio, un dato, una fecha— buscando y leyendo las primeras páginas en segundo plano; la respuesta se dice. Con show, abre la búsqueda en el navegador. Nunca para el código del usuario ni los datos de CodeFlow."
            },
            "aliases": {
                "es": ["busca en internet", "busca en google", "busca en la web", "googlea", "buscame en internet", "averigua en internet"],
                "en": ["search the web for", "search the internet for", "google", "look up online"]
            },
            "params": object(json!({
                "query": text("What to search for, as a search engine wants it."),
                "question": optional("What to answer from it, as the user asked; left out, the query."),
                "show": { "type": "boolean", "description": "Open the search in the browser instead of answering — only when the user asked to see it." }
            }), &["query"]),
            "risk": "read",
            "where": PLACE
        })),
        spec(json!({
            "id": "desktop.read",
            "title": {
                "en": "Read what another app's open window says (Teams, Outlook, Slack, a browser tab…) and answer about it — new messages, what someone wrote, what is pending. Read only: nothing in that app is clicked or sent. `question`: the user's request, whole.",
                "es": "Lee lo que dice la ventana abierta de otra app (Teams, Outlook, Slack, una pestaña del navegador…) y responde sobre ella: mensajes nuevos, qué escribió alguien, qué queda pendiente. Solo lectura: no hace clic ni envía nada en esa app. `question`: la petición del usuario, entera."
            },
            "aliases": {
                "es": ["lee la ventana de", "leeme la ventana de", "revisa la app de", "que dice la ventana de"],
                "en": ["read the window of", "what does the window of"]
            },
            "params": object(json!({
                "app": text("The app whose window to read, as said («Teams», «Outlook»)."),
                "question": optional("What to answer about it, the user's words; left out, a summary of what is new.")
            }), &["app"]),
            "risk": "read",
            "where": PLACE
        })),
        spec(json!({
            "id": "desktop.windows",
            "title": { "en": "Which other apps have a window open on screen, front to back.", "es": "Qué otras apps tienen una ventana abierta en pantalla, de adelante hacia atrás." },
            "questions": {
                "es": ["que apps tengo abiertas", "que ventanas tengo abiertas", "que programas tengo abiertos"],
                "en": ["which apps are open", "which windows are open", "what do i have open"]
            },
            "params": object(json!({}), &[]),
            "risk": "read",
            "where": PLACE
        })),
        spec(json!({
            "id": "routine.run",
            "title": {
                "en": "Run one of the user's routines (Settings › Codi › Routines) by its name; `input` fills its blank, when it has one («el tiempo» in «Arica»). routine.list names them.",
                "es": "Ejecuta una de las rutinas del usuario (Configuración › Codi › Rutinas) por su nombre; `input` llena su hueco, si tiene uno («el tiempo» en «Arica»). routine.list las nombra."
            },
            "aliases": { "es": ["ejecuta la rutina", "corre la rutina", "haz la rutina", "lanza la rutina"], "en": ["run the routine", "start the routine", "do the routine"] },
            "params": object(json!({
                "name": text("The routine's name, as said."),
                "input": optional("What fills the routine's blank (a place, a topic), when said.")
            }), &["name"]),
            "risk": "write",
            "where": PLACE
        })),
        spec(json!({
            "id": "routine.list",
            "title": { "en": "The user's routines: their names and the sentences that start them.", "es": "Las rutinas del usuario: sus nombres y las frases que las inician." },
            "questions": { "es": ["que rutinas tengo", "cuales son mis rutinas"], "en": ["which routines do i have", "what are my routines"] },
            "params": object(json!({}), &[]),
            "risk": "read",
            "where": PLACE
        })),
        // «¿qué hice ayer?» — the work summary, kept in Notas (user, 2026-10-23).
        crate::worklog::codi::spec(),
    ]
}

fn done(say: String, result: Value) -> ActResult {
    ActResult { ok: true, say: Some(say), result: Some(result), ..ActResult::default() }
}

fn failed(error: String, say: String, offer: Option<Offer>) -> ActResult {
    ActResult { ok: false, error: Some(error), say: Some(say), offer, ..ActResult::default() }
}

fn es(app: &AppHandle) -> bool {
    super::lang(app) == "es"
}

fn string(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// What failed, said as what to do about it, and what to offer instead.
pub struct Failure {
    pub error: String,
    pub say: String,
    pub offer: Option<Offer>,
}

/// `work` answered within the turn when it is quick; else `still` now and the end told later (with
/// its offer asked, when it failed with one).
pub async fn within_turn<F>(app: &AppHandle, source: String, still: String, work: F) -> ActResult
where
    F: Future<Output = Result<String, Failure>> + Send + 'static,
{
    let mut handle = tauri::async_runtime::spawn(work);
    match tokio::time::timeout(ANSWER_WITHIN, &mut handle).await {
        Ok(Ok(Ok(said))) => done(said, json!({ "done": true })),
        Ok(Ok(Err(failure))) => failed(failure.error, failure.say, failure.offer),
        Ok(Err(error)) => failed(error.to_string(), error.to_string(), None),
        Err(_) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match handle.await {
                    Ok(Ok(said)) => super::tell(&app, &said, &source).await,
                    Ok(Err(failure)) => match failure.offer {
                        // The failure's sentence is its question: asked once.
                        Some(offer) => super::offer(&app, &offer.action, offer.params, &failure.say, &source).await,
                        None => super::tell(&app, &failure.say, &source).await,
                    },
                    Err(error) => super::tell(&app, &error.to_string(), &source).await,
                }
            });
            done(still, json!({ "running": true }))
        }
    }
}

/// The reason in an error, short enough to be said.
fn spoken(error: &str) -> String {
    let error = error.trim();
    let short: String = error.chars().take(140).collect();
    if short.len() < error.len() {
        format!("{short}…")
    } else {
        short
    }
}

/// Another app's reader failing, said as what to do.
fn read_failure(app: &AppHandle, name: &str, error: String) -> Failure {
    failure_reading(es(app), name, error)
}

fn failure_reading(es: bool, name: &str, error: String) -> Failure {
    let (say, offer) = if error.contains("open it first") || error.contains("no open window") {
        (
            if es { format!("{name} no tiene una ventana abierta. ¿Lo abro?") } else { format!("{name} has no window open. Shall I open it?") },
            Some(Offer { action: "system.open".into(), params: json!({ "target": name }), question: None }),
        )
    } else if error.contains("Accessibility permission") {
        (
            if es {
                "Para leer otras apps necesito el permiso de Accesibilidad: dalo en Configuración › Codi › Escritorio.".into()
            } else {
                "To read other apps I need the Accessibility permission: give it in Settings › Codi › Desktop.".into()
            },
            None,
        )
    } else if error.contains("Screen Recording") {
        (
            if es {
                "Esa ventana no tiene texto legible, y leerla desde una captura necesita el permiso de Grabación de pantalla: dalo en Configuración › Codi › Escritorio.".into()
            } else {
                "That window has no readable text, and reading it from a screenshot needs the Screen Recording permission: give it in Settings › Codi › Desktop.".into()
            },
            None,
        )
    } else if error.contains("reading other apps is off") || error.contains("leer otras apps está desactivado") {
        (error.clone(), None)
    } else {
        (if es { format!("No pude leer {name}: {}", spoken(&error)) } else { format!("I couldn't read {name}: {}", spoken(&error)) }, None)
    };
    Failure { error, say, offer }
}

/// Runs the native action `id`. `None` when `id` is not one of them.
///
/// A boxed future rather than an `async fn`: a routine's step can run an action, and an action can
/// run a routine, so `ui::act` and this reach each other — a named type is what lets the compiler see
/// the cycle is `Send`.
pub fn run<'a>(app: &'a AppHandle, id: &'a str, params: &'a Value) -> std::pin::Pin<Box<dyn Future<Output = Option<ActResult>> + Send + 'a>> {
    Box::pin(run_now(app, id, params))
}

async fn run_now(app: &AppHandle, id: &str, params: &Value) -> Option<ActResult> {
    let es = es(app);
    Some(match id {
        "app.front" => {
            crate::tray::show_main_window(app);
            done(if es { "Listo, traje CodeFlow al frente".into() } else { "Here it is — CodeFlow is in front".into() }, json!({ "shown": true }))
        }
        "quick.open" => {
            let question = string(params, "question");
            crate::windows::set_quick_ask_draft(question.clone());
            match crate::windows::open_quick_ask(app.clone()).await {
                Ok(label) => {
                    // An open box takes it now; a new one takes it as it mounts.
                    let _ = tauri::Emitter::emit_to(app, label.as_str(), "quick-ask:codi", ());
                    done(
                    match (&question, es) {
                        (Some(_), true) => "Abrí una consulta rápida con tu pregunta; envíala con Enter.".into(),
                        (Some(_), false) => "I opened a quick ask with your question; send it with Enter.".into(),
                        (None, true) => "Abrí una consulta rápida.".into(),
                        (None, false) => "I opened a quick ask.".into(),
                    },
                    json!({ "opened": true }),
                    )
                }
                Err(error) => failed(error.clone(), if es { format!("No pude abrir la consulta rápida: {}", spoken(&error)) } else { format!("I couldn't open the quick ask: {}", spoken(&error)) }, None),
            }
        }
        "system.open" => {
            let target = string(params, "target").unwrap_or_default();
            let wanted = target.clone();
            let opened = tokio::task::spawn_blocking(move || crate::desktop::open(&wanted, es))
                .await
                .map_err(|e| crate::desktop::NotOpened { message: e.to_string(), near: Vec::new() })
                .and_then(|r| r);
            match opened {
                Ok(opened) => {
                    let name = opened.name.trim_start_matches("https://").trim_start_matches("http://").to_string();
                    let say = match (opened.kind, es) {
                        ("url", true) => format!("Abrí {name} en el navegador."),
                        ("url", false) => format!("I opened {name} in the browser."),
                        (_, true) => format!("Abrí {name}."),
                        (_, false) => format!("I opened {name}."),
                    };
                    done(say, json!(opened))
                }
                // An app nobody installed under that name, but one nearly so: asked, and a yes opens it.
                Err(error) if error.near.len() == 1 => {
                    let guess = error.near[0].clone();
                    let question = if es { format!("No encontré «{target}». ¿Quisiste decir {guess}?") } else { format!("I didn't find «{target}». Did you mean {guess}?") };
                    failed(error.message, question.clone(), Some(Offer { action: "system.open".into(), params: json!({ "target": guess }), question: None }))
                }
                Err(error) => {
                    let message = error.message;
                    failed(message.clone(), if es { format!("No pude abrir {target}: {}", spoken(&message)) } else { format!("I couldn't open {target}: {}", spoken(&message)) }, None)
                }
            }
        }
        "web.search" => {
            let query = string(params, "query").unwrap_or_default();
            if params.get("show").and_then(Value::as_bool) == Some(true) {
                return Some(match crate::desktop::open_search(&query) {
                    Ok(opened) => done(if es { format!("Abrí la búsqueda de «{query}».") } else { format!("I opened the search for «{query}».") }, json!(opened)),
                    Err(error) => failed(error.clone(), spoken(&error), None),
                });
            }
            let question = string(params, "question").unwrap_or_else(|| query.clone());
            let worker = app.clone();
            let work = async move {
                let lose = |error: String| Failure {
                    say: if super::lang(&worker) == "es" { format!("No pude buscarlo: {}", spoken(&error)) } else { format!("I couldn't look it up: {}", spoken(&error)) },
                    error,
                    offer: None,
                };
                let material = super::web::search(&query, 2).await.map_err(lose)?;
                super::web::answer(&worker, &question, &material).await.map_err(lose)
            };
            let still = if es { "Lo estoy buscando, ya te digo…" } else { "Looking it up, I'll tell you…" };
            within_turn(app, format!("web:{}", string(params, "query").unwrap_or_default()), still.into(), work).await
        }
        "desktop.read" => {
            let name = string(params, "app").unwrap_or_default();
            let question = string(params, "question");
            let worker = app.clone();
            let reading = name.clone();
            let work = async move {
                let found = super::read_app(&worker, &reading).await.map_err(|error| read_failure(&worker, &reading, error))?;
                let instruction = question.unwrap_or_else(|| {
                    if super::lang(&worker) == "es" { "Resume lo que muestra la ventana: lo nuevo o pendiente primero.".into() } else { "Summarize what the window shows: what is new or pending first.".into() }
                });
                let material = format!("Texto de la ventana de {} ({}):\n{}", found.app, found.title, found.text);
                super::web::answer_with(&worker, &instruction, &material, super::read_apps_mode(&worker) == "local").await.map_err(|error| read_failure(&worker, &reading, error))
            };
            let still = if es { format!("Estoy leyendo {name}, ya te digo…") } else { format!("Reading {name}, I'll tell you…") };
            within_turn(app, format!("app:{name}"), still, work).await
        }
        "desktop.windows" => match tokio::task::spawn_blocking(crate::desktop::read::windows).await.map_err(|e| e.to_string()).and_then(|r| r) {
            Ok(windows) => {
                let mut apps: Vec<String> = Vec::new();
                for window in &windows {
                    if !apps.contains(&window.app) {
                        apps.push(window.app.clone());
                    }
                }
                let say = match (apps.is_empty(), es) {
                    (true, true) => "Ninguna otra app tiene una ventana abierta.".into(),
                    (true, false) => "No other app has a window open.".into(),
                    (false, true) => format!("Tienes abiertas: {}.", list(&apps, "y")),
                    (false, false) => format!("You have open: {}.", list(&apps, "and")),
                };
                done(say, json!({ "apps": apps, "windows": windows.iter().take(20).map(|w| json!({ "app": w.app, "title": w.title })).collect::<Vec<_>>() }))
            }
            Err(error) => failed(error.clone(), spoken(&error), None),
        },
        "routine.run" => {
            let name = string(params, "name").unwrap_or_default();
            let routines = super::routines::load(app);
            let Some(routine) = super::routines::by_name(&routines, &name) else {
                let known: Vec<String> = routines.iter().filter(|r| r.enabled).map(|r| r.name.clone()).collect();
                let say = if es { format!("No tengo una rutina «{name}». Tienes: {}.", list(&known, "y")) } else { format!("I have no routine «{name}». You have: {}.", list(&known, "and")) };
                return Some(failed(format!("no routine is called «{name}»"), say, None));
            };
            let mut slots = BTreeMap::new();
            if let Some(input) = string(params, "input") {
                if let [only] = super::routines::slot_names(&routine).as_slice() {
                    slots.insert(only.clone(), input);
                }
            }
            let worker = app.clone();
            let title = routine.name.clone();
            let work = async move {
                super::routines::run(&worker, &routine, &slots).await.map_err(|error| Failure {
                    say: if super::lang(&worker) == "es" { format!("No pude con «{}»: {}", routine.name, spoken(&error)) } else { format!("I couldn't finish «{}»: {}", routine.name, spoken(&error)) },
                    error,
                    offer: None,
                })
            };
            let still = if es { format!("Sigo con «{title}», te aviso.") } else { format!("Still on «{title}», I'll tell you.") };
            within_turn(app, format!("routine:{title}"), still, work).await
        }
        "routine.list" => {
            let routines: Vec<_> = super::routines::load(app).into_iter().filter(|r| r.enabled).collect();
            let names: Vec<String> = routines.iter().map(|r| r.name.clone()).collect();
            let say = match (names.is_empty(), es) {
                (true, true) => "No tienes rutinas activas.".into(),
                (true, false) => "You have no routines on.".into(),
                (false, true) => format!("Tus rutinas: {}.", list(&names, "y")),
                (false, false) => format!("Your routines: {}.", list(&names, "and")),
            };
            done(say, json!({ "routines": routines.iter().map(|r| json!({ "name": r.name, "phrases": r.phrases })).collect::<Vec<_>>() }))
        }
        crate::worklog::codi::ID => crate::worklog::codi::act(app, params).await,
        _ => return None,
    })
}

/// «a, b y c» — at most six, then how many more.
fn list(names: &[String], and: &str) -> String {
    let shown: Vec<&str> = names.iter().take(6).map(String::as_str).collect();
    let mut out = match shown.as_slice() {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} {and} {last}", rest.join(", ")),
    };
    if names.len() > shown.len() {
        out.push_str(&format!(" (+{})", names.len() - shown.len()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_native_spec_reads_and_lives_here() {
        let specs = specs();
        assert!(specs.len() >= 8);
        for spec in &specs {
            assert_eq!(spec.place, PLACE, "{}", spec.id);
            assert_eq!(spec.params.get("type").and_then(Value::as_str), Some("object"), "{}", spec.id);
        }
        let ids: std::collections::HashSet<&str> = specs.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), specs.len(), "an id twice");
    }

    #[test]
    fn a_reader_failing_says_what_to_do() {
        let closed = failure_reading(true, "Teams", "no open window belongs to «Teams» — open it first".into());
        assert_eq!(closed.say, "Teams no tiene una ventana abierta. ¿Lo abro?");
        let offer = closed.offer.expect("offers to open it");
        assert_eq!((offer.action.as_str(), offer.params), ("system.open", json!({ "target": "Teams" })));
        assert!(failure_reading(true, "Teams", "CodeFlow needs the Accessibility permission to read other apps".into()).say.contains("Accesibilidad"));
        assert!(failure_reading(false, "Teams", "reading it from a screenshot needs the Screen Recording permission".into()).say.contains("Screen Recording"));
        assert!(failure_reading(true, "Teams", "boom".into()).say.starts_with("No pude leer Teams"));
    }

    #[test]
    fn a_list_is_said_the_way_people_say_it() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(list(&names(&["Teams"]), "y"), "Teams");
        assert_eq!(list(&names(&["Teams", "Chrome", "Outlook"]), "y"), "Teams, Chrome y Outlook");
        assert_eq!(list(&names(&["a", "b", "c", "d", "e", "f", "g", "h"]), "and"), "a, b, c, d, e and f (+2)");
    }
}
