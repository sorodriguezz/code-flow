//! What Codi's window and the rest of the app ask of `crate::codi`: its state and switches, an order
//! typed instead of said, the answer to a confirmation, an announcement, and — from every window —
//! the interface's catalogue and the answers to its requests (`codi::ui`).

use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use crate::codi::{self, ui, CodiState};

#[tauri::command]
pub fn codi_status(app: AppHandle) -> CodiState {
    codi::state(&app)
}

/// Opens (or brings forward) Codi's window.
#[tauri::command]
pub async fn codi_open_window(app: AppHandle) -> Result<String, String> {
    crate::windows::open_codi(app).await
}

/// The user's routines — the examples while none are saved.
#[tauri::command]
pub fn codi_routines(app: AppHandle) -> Vec<codi::routines::Routine> {
    codi::routines::load(&app)
}

#[tauri::command]
pub fn codi_set_routines(app: AppHandle, routines: Vec<codi::routines::Routine>) -> Result<(), String> {
    codi::routines::save(&app, &routines)
}

/// Runs the routine `name` names (its name or its id) — `input` fills its one slot, when it has
/// one — and answers what it says at the end. «Probar» in Settings, and `routine.run`.
#[tauri::command]
pub async fn codi_run_routine(app: AppHandle, name: String, input: Option<String>) -> Result<String, String> {
    let routines = codi::routines::load(&app);
    let routine = codi::routines::by_name(&routines, &name).ok_or_else(|| {
        let known: Vec<&str> = routines.iter().map(|r| r.name.as_str()).collect();
        format!("no routine is called «{name}»; there are: {}", known.join(", "))
    })?;
    let mut slots = std::collections::BTreeMap::new();
    if let Some(input) = input.map(|i| i.trim().to_string()).filter(|i| !i.is_empty()) {
        if let [only] = codi::routines::slot_names(&routine).as_slice() {
            slots.insert(only.clone(), input);
        }
    }
    codi::routines::run(&app, &routine, &slots).await
}

/// What the system has granted for reading other apps (macOS; Windows asks nothing).
#[tauri::command]
pub fn desktop_permissions() -> crate::desktop::read::Permissions {
    crate::desktop::read::permissions()
}

/// Asks the system for `kind` (`accessibility` · `screen`).
#[tauri::command]
pub fn desktop_ask_permission(kind: String) {
    crate::desktop::read::ask(&kind)
}

/// «Volver a la esquina»: Codi's window forgets where it was left and goes to the top-right corner.
#[tauri::command]
pub fn codi_window_to_corner(app: AppHandle) {
    crate::windows::codi_to_corner(&app);
}

/// «Abrir Codi al encender el equipo»: the setting, and the login item it needs — switched on with
/// it (never off: CodeFlow starting at login may be wanted for itself). Answers whether CodeFlow
/// now starts at login.
#[tauri::command]
pub fn codi_set_at_login(app: AppHandle, on: bool) -> Result<bool, String> {
    use tauri::Manager;
    {
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::queries::set_setting(&conn, codi::keys::AT_LOGIN, if on { "on" } else { "off" }).map_err(|e| e.to_string())?;
    }
    use tauri_plugin_autostart::ManagerExt;
    if on {
        return crate::tray::set_autostart(app, true);
    }
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// The microphone switch. On, with something missing, says what (`CODI_MISSING:library,listener`).
#[tauri::command]
pub async fn codi_set_mic(app: AppHandle, on: bool) -> Result<CodiState, String> {
    let worker = app.clone();
    tokio::task::spawn_blocking(move || if on { codi::start(&worker) } else { Ok(codi::stop(&worker)) }).await.map_err(|e| e.to_string())??;
    Ok(codi::state(&app))
}

#[tauri::command]
pub fn codi_set_sound(app: AppHandle, on: bool) -> CodiState {
    codi::set_sound(&app, on);
    codi::state(&app)
}

/// Push-to-talk, held or let go.
#[tauri::command]
pub fn codi_talk(app: AppHandle, held: bool) {
    codi::set_talking(&app, held);
}

/// The push-to-talk chord: the one chosen (`None` = switched off) and this build's default.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PttHotkey {
    accelerator: Option<String>,
    default_accelerator: &'static str,
}

#[tauri::command]
pub fn codi_ptt_hotkey(app: AppHandle) -> PttHotkey {
    PttHotkey { accelerator: codi::hotkey::chosen(&app), default_accelerator: codi::hotkey::DEFAULT }
}

/// Records a chord (`off`, or `""` for the default); `Err` when the system refused it.
#[tauri::command]
pub fn codi_set_ptt_hotkey(app: AppHandle, accelerator: String) -> Result<(), String> {
    codi::hotkey::set(&app, &accelerator)?;
    let _ = app.emit(codi::STATE_EVENT, codi::state(&app));
    Ok(())
}

/// Frees the chord while Settings records a new one.
#[tauri::command]
pub fn codi_suspend_ptt_hotkey(app: AppHandle, suspended: bool) -> Result<(), String> {
    codi::hotkey::suspend(&app, suspended)
}

/// An order typed into Codi's window — the same turn as a spoken one.
#[tauri::command]
pub fn codi_order(app: AppHandle, text: String) {
    codi::order(&app, text);
}

/// The answer to the confirmation Codi is asking (its card's buttons).
#[tauri::command]
pub fn codi_confirm(id: String, yes: bool) -> bool {
    codi::answer(Some(&id), yes)
}

/// «Callar».
#[tauri::command]
pub fn codi_hush() {
    codi::hush();
}

/// Researches `question` in the repository at `path` (named `name`) in the background, read-only;
/// the answer is told when it is ready (`codi::research`).
#[tauri::command]
pub fn codi_research(app: AppHandle, path: String, name: String, question: String) -> Result<(), String> {
    codi::research::start(&app, path, name, question)
}

/// Explains `material` (a container's log, credentials already redacted) to answer `question`
/// about `subject`, in the background; the answer is told when it is ready.
#[tauri::command]
pub fn codi_explain(app: AppHandle, subject: String, question: String, material: String) -> Result<(), String> {
    codi::research::explain(&app, subject, question, material)
}

/// Answers `question` from what the app has indexed — the repository at `path`, or the workspace
/// when there is none — and says the answer when written. `deep` is the action offered when the index
/// does not answer it: `{ action, params }`.
#[tauri::command]
pub async fn codi_know(
    app: AppHandle,
    path: Option<String>,
    workspace_id: String,
    subject: String,
    question: String,
    deep: Option<serde_json::Value>,
) -> Result<codi::research::Looked, String> {
    let place = match path.filter(|p| !p.trim().is_empty()) {
        Some(path) => codi::research::Place::Repo(path),
        None => codi::research::Place::Workspace(workspace_id),
    };
    let deep = deep.and_then(|d| Some((d.get("action")?.as_str()?.to_string(), d.get("params").cloned().unwrap_or_default())));
    codi::research::know(&app, place, subject, question, deep).await
}

/// Explains why the run `run_id` of `project_id` failed, from its failed job's log, in the
/// background; the answer is told when it is ready.
#[tauri::command]
pub fn codi_explain_pipeline(app: AppHandle, project_id: String, run_id: String, subject: String, question: String) -> Result<(), String> {
    codi::research::explain_pipeline(&app, project_id, run_id, subject, question)
}

/// The apps installed on this computer, by name — what a routine's «Abrir» and «Leer una app» pick from.
#[tauri::command]
pub async fn codi_installed_apps() -> Vec<String> {
    tokio::task::spawn_blocking(|| crate::desktop::apps::installed().into_iter().map(|app| app.name).collect()).await.unwrap_or_default()
}

/// Every action Codi can run right now — its own and the windows' — for a routine's «Acción de Codi».
#[tauri::command]
pub fn codi_action_catalog() -> Vec<ui::ActionSpec> {
    ui::specs()
}

/// One recollection as the settings list it: when, and what it says.
#[derive(serde::Serialize)]
pub struct RecollectionRow {
    pub id: i64,
    pub at: i64,
    pub text: String,
}

/// What Codi keeps from earlier sessions, newest first — the settings' «guardados» list.
#[tauri::command]
pub fn codi_recollections(db: tauri::State<'_, crate::db::Db>) -> Result<Vec<RecollectionRow>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let all = codi::recollections::all(&conn).map_err(|e| e.to_string())?;
    Ok(all.into_iter().map(|r| RecollectionRow { id: r.id, at: r.at, text: r.text }).collect())
}

/// One recollection forgotten.
#[tauri::command]
pub fn codi_forget(db: tauri::State<'_, crate::db::Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    codi::recollections::forget(&conn, id).map_err(|e| e.to_string())
}

/// «Olvidar todo»: every recollection of earlier sessions goes.
#[tauri::command]
pub fn codi_forget_all(db: tauri::State<'_, crate::db::Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    codi::recollections::forget_all(&conn).map_err(|e| e.to_string())
}

/// One step of a guided tour, said in Codi's voice: `done` · `stopped` · `silent` · `failed`.
#[tauri::command]
pub async fn codi_narrate(app: AppHandle, text: String) -> String {
    codi::narrate(&app, &text).await.to_string()
}

/// Something finished elsewhere while Codi is on — said and logged (the main window sends the
/// notifications it would have spoken).
#[tauri::command]
pub async fn codi_announce(app: AppHandle, text: String, source: String) {
    codi::announce(&app, &text, &source).await;
}

/// What an action finished after its turn had answered — a pull that outlasted the wait, a flow or a
/// review worked on out of sight — told in Codi's voice and logged, like a research's answer. With an
/// `offer` that carries a question («¿Te lo muestro?»), it is asked next, and a yes runs it.
#[tauri::command]
pub async fn codi_tell(app: AppHandle, text: String, source: String, offer: Option<ui::Offer>) {
    let offer = offer.filter(|offer| !offer.action.trim().is_empty());
    let question = offer.as_ref().and_then(|offer| offer.question.clone()).filter(|question| !question.trim().is_empty());
    // A failure that is itself the question («…se separaron. ¿Lo abro?») is asked once, not said and
    // then asked.
    if question.as_deref().map(str::trim) != Some(text.trim()) {
        codi::tell(&app, &text, &source).await;
    }
    if let (Some(offer), Some(question)) = (offer, question) {
        codi::offer(&app, &offer.action, offer.params, &question, &source).await;
    }
}

/// What a shell command Codi ran out of sight came to ([`codi_run_command`]).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRun {
    /// Its exit code — `None` when it was stopped (the time ran out) or ended by a signal.
    pub code: Option<i32>,
    /// The end of what it printed, both streams, without colours and with any credential masked: it
    /// is said aloud and may reach a cloud model.
    pub output: String,
    pub timed_out: bool,
    pub ms: u64,
}

/// How long a command run out of sight may take before it is stopped — a test suite, a build.
const RUN_LIMIT: std::time::Duration = std::time::Duration::from_secs(600);
/// How much of its output comes back: the end, where the verdict is.
const RUN_OUTPUT_CHARS: usize = 2_000;

/// A shell command run by Codi without a terminal on screen (`terminal.run` in the background): in
/// `cwd`, after the user said yes to it in Codi's window, with the same environment a terminal's
/// shell gets minus the app's own secrets (`tool_gateway::shell_command`). A command that is still
/// running after [`RUN_LIMIT`] is stopped with everything it started — a server or a watcher belongs
/// in a terminal, which the frontend picks for one.
#[tauri::command]
pub async fn codi_run_command(cwd: String, command: String) -> Result<CommandRun, String> {
    let line = command.trim();
    if line.is_empty() {
        return Err("the command is empty".to_string());
    }
    let root = std::path::Path::new(&cwd);
    if !root.is_dir() {
        return Err(format!("{cwd} is not a folder"));
    }
    let started = std::time::Instant::now();
    let mut cmd = crate::tool_gateway::shell_command(line, root, false);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    crate::ai::apply_command_path(&mut cmd);
    crate::proc::hide_console(&mut cmd);
    crate::proc::own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|error| format!("could not start the command: {error}"))?;
    let ceiling = RUN_OUTPUT_CHARS * 4;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let out = tokio::spawn(async move {
        match stdout {
            Some(pipe) => crate::tool_gateway::read_tail(pipe, ceiling).await,
            None => Vec::new(),
        }
    });
    let err = tokio::spawn(async move {
        match stderr {
            Some(pipe) => crate::tool_gateway::read_tail(pipe, ceiling).await,
            None => Vec::new(),
        }
    });
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = tokio::time::sleep(RUN_LIMIT) => {
            crate::ai_runs::kill_tree(&mut child).await;
            None
        }
    };
    let mut text = String::from_utf8_lossy(&out.await.unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&err.await.unwrap_or_default()).to_string();
    if !err.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&err);
    }
    let text = crate::ai::strip_ansi(&text);
    let tail: String = {
        let count = text.chars().count();
        text.chars().skip(count.saturating_sub(RUN_OUTPUT_CHARS)).collect()
    };
    Ok(CommandRun {
        code: status.and_then(|s| s.code()),
        output: crate::secret_scan::redact(tail.trim()).0,
        timed_out: status.is_none(),
        ms: started.elapsed().as_millis() as u64,
    })
}

/// Downloads what Codi needs and is missing: sherpa-onnx, the voice detector, and the model this
/// machine is recommended for listening when none usable is in. Progress arrives as `codi:prepare`.
#[tauri::command]
pub async fn codi_prepare(app: AppHandle) -> Result<CodiState, String> {
    use crate::reviewer::download;
    let cancel = CancellationToken::new();
    let emit = |item: &str, done: u64, total: u64| {
        let _ = app.emit("codi:prepare", serde_json::json!({ "item": item, "done": done, "total": total }));
    };
    crate::meetings::ensure_sherpa(&cancel, |done| emit("library", done, crate::meetings::SHERPA.map_or(0, |s| s.size)))
        .await
        .map_err(|e| match e {
            download::FetchError::Cancelled => "cancelled".to_string(),
            download::FetchError::Failed(message) => message,
        })?;
    let detector = codi::vad::MODEL;
    if !codi::vad::model_path().is_file() {
        download::fetch(detector.url, detector.size, detector.sha256, &codi::vad::model_path(), &cancel, |done, total| emit("detector", done, total))
            .await
            .map_err(|e| match e {
                download::FetchError::Cancelled => "cancelled".to_string(),
                download::FetchError::Failed(message) => message,
            })?;
    }
    let settings = {
        use tauri::Manager;
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        codi::load_settings(&conn)
    };
    if codi::listener(&settings).is_none() {
        let pick = crate::voice_fit::picks(crate::voice_fit::class(), 16.0, crate::asr::supported()).codi;
        let model = crate::asr::model(&pick).ok_or_else(|| format!("CODI_MISSING:listener:{pick}"))?;
        let archive = crate::asr::root().join("downloads").join(model.archive);
        download::fetch(model.url, model.size, model.sha256, &archive, &cancel, |done, total| emit(model.id, done, total))
            .await
            .map_err(|e| match e {
                download::FetchError::Cancelled => "cancelled".to_string(),
                download::FetchError::Failed(message) => message,
            })?;
        let from = archive.clone();
        tokio::task::spawn_blocking(move || crate::asr::unpack(model, &from)).await.map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&archive);
        crate::voice_fit::measure_in_background(&app, model.id);
    }
    let state = codi::state(&app);
    let _ = app.emit(codi::STATE_EVENT, &state);
    Ok(state)
}

// ------------------------------------------------------------------------------- the interface

/// A window's catalogue (`src/lib/codi/actions`), registered at boot and again when its language
/// changes.
#[tauri::command]
pub fn codi_register_actions(window: String, actions: Vec<ui::ActionSpec>) {
    ui::register(&window, actions);
}

/// A window's answer to a `codi:act` request.
#[tauri::command]
pub fn codi_act_result(answer: ui::ActResult) {
    ui::answer(answer);
}

/// Runs one interface action from the window (a test, a shortcut): the same door as an engine's.
#[tauri::command]
pub async fn codi_act(app: AppHandle, action: String, params: Value) -> Result<ui::ActResult, String> {
    ui::act(&app, &action, params, ui::Asker::Codi, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command run out of sight comes back with its exit code and the end of what it printed — both
    /// streams, a credential in it masked — and a folder that is not one is refused before anything runs.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_out_of_sight_says_how_it_ended() {
        let dir = std::env::temp_dir().join(format!("codi-run-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        let run = codi_run_command(cwd.clone(), format!("echo hola; echo {token} >&2; pwd; exit 3")).await.unwrap();
        assert_eq!(run.code, Some(3));
        assert!(!run.timed_out);
        assert!(run.output.contains("hola") && run.output.contains("codi-run-"), "{}", run.output);
        assert!(!run.output.contains("ghp_abc"), "{}", run.output);
        assert!(codi_run_command("/no/such/folder".into(), "true".into()).await.is_err());
        assert!(codi_run_command(cwd, "   ".into()).await.is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
