//! Contenedores › Catálogo de servicios' commands: the catalogue, provisioning a stack, its
//! lifecycle, and the integrations that make it worth more than a `docker run` — a connection in
//! Base de datos, an environment and an OAuth2 preset in the API client, a Llavero entry per
//! password. See `crate::containers::marketplace` for what a stack is and where its secrets live.
//!
//! The integrations are made through the other modules' own commands (`db_cmd`, `api_cmd`,
//! `keyvault_cmd`), called as functions: each of those already seals what it must (the database
//! password into the keychain, an environment's secret variable into the OS store, the Llavero
//! payload under its key), and a second path to the same tables would be a second place for that to
//! go wrong.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroize;

use crate::commands::{api_cmd, db_cmd, keyvault_cmd};
use crate::containers::engine::{self, check_ref, ContainerRow, EngineKind, Target};
use crate::containers::marketplace::{self as market, Created, IntegrationKind, ServiceDef, StackPort, StackRow, StackService};
use crate::containers::session;
use crate::db::Db;
use crate::keyvault::session::VaultSession;
use crate::terminal::TerminalRegistry;

fn locked_error() -> String {
    "the Llavero is locked — unlock it first: the stack's passwords are kept there".to_string()
}

// ------------------------------------------------------------------------------------ views

/// One service of a stack as the page shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub category: String,
    pub image: String,
    pub ports: Vec<StackPort>,
    /// `running`, `exited`, … as the engine says, `missing` when it has no container, `unknown`
    /// when the engine did not answer.
    pub state: String,
    pub health: String,
    pub console: Option<String>,
    pub address: Option<String>,
    pub user: String,
    pub secret_item: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackView {
    pub id: String,
    pub name: String,
    pub runtime: String,
    pub context: Option<String>,
    pub workspace_id: String,
    pub dir: String,
    pub compose_file: String,
    pub created_at: String,
    pub last_error: String,
    pub integrations: Vec<Created>,
    pub services: Vec<ServiceView>,
    /// The engine answered when the state was read.
    pub reachable: bool,
}

fn view_of(row: &StackRow, containers: Option<&[ContainerRow]>) -> StackView {
    let states = containers.map(|c| market::states_of(row, c));
    StackView {
        id: row.id.clone(),
        name: row.name.clone(),
        runtime: row.runtime.clone(),
        context: row.context.clone(),
        workspace_id: row.workspace_id.clone(),
        dir: row.dir.clone(),
        compose_file: row.compose_file().to_string_lossy().into_owned(),
        created_at: row.created_at.clone(),
        last_error: row.last_error.clone(),
        integrations: row.integrations.clone(),
        reachable: containers.is_some(),
        services: row
            .services
            .iter()
            .map(|service| {
                let def = market::find(&service.id);
                let state = states.as_ref().and_then(|s| s.get(&service.id));
                ServiceView {
                    id: service.id.clone(),
                    name: def.map(|d| d.name.to_string()).unwrap_or_else(|| service.id.clone()),
                    category: def.map(|d| d.category).unwrap_or_default().to_string(),
                    image: def.map(|d| d.image).unwrap_or_default().to_string(),
                    ports: service.ports.clone(),
                    state: state.map(|s| s.state.clone()).unwrap_or_else(|| "unknown".into()),
                    health: state.map(|s| s.health.clone()).unwrap_or_default(),
                    console: def.and_then(|d| d.console).map(|c| market::fill(c, service)),
                    address: def.and_then(|d| d.address).map(|a| market::fill(a, service)),
                    user: def.map(|d| d.user).unwrap_or_default().to_string(),
                    secret_item: service.secret_item.clone(),
                }
            })
            .collect(),
    }
}

fn load(app: &AppHandle, id: &str) -> Result<StackRow, String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    market::get(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("there is no service stack {id}"))
}

fn save(app: &AppHandle, row: &StackRow) -> Result<(), String> {
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    market::save(&conn, row).map_err(|e| e.to_string())
}

async fn view(row: &StackRow) -> StackView {
    let containers = engine::list_containers(&row.target()).await.ok();
    view_of(row, containers.as_deref())
}

// ---------------------------------------------------------------------------------- catalogue

/// The services the catalogue offers, with their images, ports, healthchecks and integration.
#[tauri::command]
pub fn containers_market_catalog() -> Vec<ServiceDef> {
    market::catalog().to_vec()
}

/// The host ports every service would get on this engine right now — its defaults, or the next free
/// ones — for the provisioning form to show and let the user change.
#[tauri::command]
pub async fn containers_market_suggest_ports(app: AppHandle, runtime: String, context: Option<String>, services: Vec<String>) -> Result<Vec<StackService>, String> {
    let defs = resolve(&services)?;
    let reserved = reserved_ports(&app, &Target { runtime, context }).await;
    market::plan_ports(&defs, &BTreeMap::new(), &|p| !reserved.contains(&p) && market::port_is_free(p))
}

fn resolve(ids: &[String]) -> Result<Vec<&'static ServiceDef>, String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for id in ids {
        let def = market::find(id).ok_or_else(|| format!("{id} is not in the catalogue"))?;
        // An entry that does not hold together would write a Compose file that cannot work.
        market::validate(def)?;
        if seen.insert(def.id) {
            out.push(def);
        }
    }
    if out.is_empty() {
        return Err("choose at least one service".into());
    }
    Ok(out)
}

/// What no new port may take: what the engine already publishes, and the ports every stack already
/// provisioned holds — a stopped one publishes nothing, and would collide the moment it starts.
async fn reserved_ports(app: &AppHandle, target: &Target) -> BTreeSet<u16> {
    let mut reserved = match engine::list_containers(target).await {
        Ok(rows) => market::published_ports(&rows),
        Err(_) => BTreeSet::new(),
    };
    let db = app.state::<Db>();
    if let Ok(conn) = db.0.lock() {
        for row in market::list(&conn).unwrap_or_default() {
            reserved.extend(row.services.iter().flat_map(|s| s.ports.iter().map(|p| p.host)));
        }
    }
    reserved
}

// ------------------------------------------------------------------------------- provisioning

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceChoice {
    pub id: String,
    /// Host ports the user typed, by port key. Kept as they are, or refused when taken.
    #[serde(default)]
    pub ports: BTreeMap<String, u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionRequest {
    pub runtime: String,
    #[serde(default)]
    pub context: Option<String>,
    pub name: String,
    /// The workspace the connections and environments are filed under.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub services: Vec<ServiceChoice>,
}

/// The first half of provisioning a stack: plans its ports, writes the Compose file and keeps a
/// generated password per service in the Llavero — nothing runs yet. The page then brings it up with
/// [`containers_market_up_job`], whose output shows in the jobs panel. A stack whose passwords could
/// not be kept answers with that as its `last_error`, and is not brought up.
#[tauri::command]
pub async fn containers_market_prepare(app: AppHandle, request: ProvisionRequest) -> Result<StackView, String> {
    let name = request.name.trim().to_string();
    market::check_stack_name(&name)?;
    let context = request.context.clone().filter(|c| !c.trim().is_empty());
    if let Some(c) = &context {
        check_ref(c)?;
    }
    let target = Target { runtime: request.runtime.clone(), context: context.clone() };
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr has no Compose — install nerdctl for it".into());
    }
    // The integrations point at 127.0.0.1: on another machine's engine they would point at nothing.
    if let Ok(endpoint) = target.endpoint().await {
        if !engine::is_local_endpoint(&endpoint) {
            return Err(format!("{endpoint} is another machine: the service catalogue provisions on this computer's engine"));
        }
    }
    let ids: Vec<String> = request.services.iter().map(|s| s.id.clone()).collect();
    let defs = resolve(&ids)?;
    if defs.iter().any(|d| d.has_secret()) && !app.state::<VaultSession>().is_unlocked() {
        return Err(locked_error());
    }
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if market::name_taken(&conn, &name, &target.runtime, context.as_deref()).map_err(|e| e.to_string())? {
            return Err(format!("there is already a service stack named {name} on this engine"));
        }
    }
    let containers = engine::list_containers(&target).await?;
    if containers.iter().any(|c| c.project == name) {
        return Err(format!("a Compose project named {name} already exists on this engine"));
    }
    let overrides: BTreeMap<String, BTreeMap<String, u16>> = request.services.iter().filter(|s| !s.ports.is_empty()).map(|s| (s.id.clone(), s.ports.clone())).collect();
    let reserved = reserved_ports(&app, &target).await;
    let services = market::plan_ports(&defs, &overrides, &|p| !reserved.contains(&p) && market::port_is_free(p))?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = market::stacks_dir().join(&id);
    let mut row = StackRow {
        id,
        name,
        runtime: target.runtime.clone(),
        context,
        workspace_id: request.workspace_id.clone().unwrap_or_default(),
        dir: dir.to_string_lossy().into_owned(),
        services,
        integrations: vec![],
        created_at: chrono::Utc::now().to_rfc3339(),
        last_error: String::new(),
    };
    let yaml = market::compose_yaml(&row.name, &row.id, &row.services, engine)?;
    market::write_compose(&dir, &yaml)?;
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        market::insert(&conn, &row).map_err(|e| e.to_string())?;
    }

    // From here on the stack exists: a failure is its `last_error`, and removing it undoes the rest.
    let mut failed: Option<String> = None;
    for index in 0..row.services.len() {
        let Some(def) = market::find(&row.services[index].id) else { continue };
        if !def.has_secret() {
            continue;
        }
        let password = market::generate_secret();
        match vault_store(&app, &row, def, &row.services[index], &password) {
            Ok(item) => {
                row.services[index].secret_item = Some(item.clone());
                row.integrations.push(Created { kind: "vaultItem".into(), id: item, label: format!("{} · {}", row.name, def.name), service: def.id.into() });
            }
            Err(e) => {
                failed = Some(e);
                break;
            }
        }
    }
    if let Some(e) = failed {
        row.last_error = e;
    }
    save(&app, &row)?;
    Ok(view(&row).await)
}

/// A Llavero entry for a service's password: `database` for the engines Base de datos opens, so the
/// database dialog's «fill from the Llavero» finds it; `login` for the rest.
fn vault_store(app: &AppHandle, row: &StackRow, def: &ServiceDef, service: &StackService, password: &str) -> Result<String, String> {
    let secret = market::vault_secret(def, service, password);
    let kind = if def.db_kind.is_some() { "database" } else { "login" };
    let site = def.console.map(|c| market::fill(c, service)).unwrap_or_default();
    let item = keyvault_cmd::keyvault_create_item(
        app.state::<Db>(),
        app.state::<VaultSession>(),
        None,
        kind.into(),
        format!("{} · {}", row.name, def.name),
        format!("{}@127.0.0.1:{}", def.user, service.ports.first().map(|p| p.host).unwrap_or_default()),
        site,
        "codeflow,service-stack".into(),
        String::new(),
        secret,
    )?;
    Ok(item.id)
}

/// A service's password, read back from its Llavero entry — the same way Servicios injects one.
fn vault_read(app: &AppHandle, item_id: &str) -> Result<String, String> {
    let session = app.state::<VaultSession>();
    if !session.is_unlocked() {
        return Err(locked_error());
    }
    let db = app.state::<Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let sealed = crate::db::keyvault_queries::get_sealed(&conn, item_id).map_err(|e| e.to_string())?;
    let Some((meta, nonce, blob)) = sealed.filter(|(meta, _, _)| meta.deleted_at.is_empty()) else {
        return Err(format!("the Llavero entry {item_id} of this stack is gone"));
    };
    let _ = meta;
    let bytes = session.with_key(|dek| crate::keyvault::crypto::open(dek, item_id, &nonce, &blob)).map_err(|_| locked_error())?.map_err(|_| "the Llavero entry could not be opened".to_string())?;
    let secret: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let value = secret.get("password").and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string).ok_or_else(|| format!("the Llavero entry {item_id} holds no password"))?;
    crate::db::keyvault_queries::record_audit(&conn, item_id, "use");
    Ok(value)
}

fn has(row: &StackRow, service: &str, kind: &str) -> bool {
    row.integrations.iter().any(|c| c.service == service && c.kind == kind)
}

/// Makes every integration the stack does not have yet; answers with what could not be made.
fn integrate(app: &AppHandle, row: &mut StackRow, passwords: &BTreeMap<String, String>) -> Vec<String> {
    let mut notes = Vec::new();
    let workspace = row.workspace_id.clone();
    for service in row.services.clone() {
        let Some(def) = market::find(&service.id) else { continue };
        let needs_workspace = matches!(def.integration, IntegrationKind::Database | IntegrationKind::Keycloak | IntegrationKind::ApiEnvironment);
        if needs_workspace && workspace.is_empty() {
            notes.push(format!("{}: no workspace is open, so nothing was added to the other modules", def.name));
            continue;
        }
        let label = format!("{} · {}", row.name, def.name);
        let result: Result<(), String> = (|| {
            match def.integration {
                IntegrationKind::Database if !has(row, def.id, "dbConnection") => {
                    let Some(spec) = market::db_spec(def, &service) else { return Ok(()) };
                    let kind = def.db_kind.unwrap_or_default().to_string();
                    let created = db_cmd::db_create_connection(app.state::<Db>(), workspace.clone(), label.clone(), String::new(), kind, spec.to_string(), String::new())?;
                    if let Some(password) = passwords.get(def.id) {
                        db_cmd::db_set_password(app.state(), created.id.clone(), password.clone())?;
                    }
                    row.integrations.push(Created { kind: "dbConnection".into(), id: created.id, label: label.clone(), service: def.id.into() });
                }
                IntegrationKind::Keycloak => {
                    if !has(row, def.id, "apiEnvironment") {
                        let password = passwords.get(def.id).cloned().unwrap_or_default();
                        let mut environment = api_cmd::api_create_environment(app.state::<Db>(), workspace.clone(), label.clone())?;
                        environment.variables = market::keycloak_variables(&service, def, &password).to_string();
                        let env_id = environment.id.clone();
                        row.integrations.push(Created { kind: "apiEnvironment".into(), id: env_id, label: label.clone(), service: def.id.into() });
                        api_cmd::api_update_environment(app.state::<Db>(), environment)?;
                    }
                    if !has(row, def.id, "apiCollection") {
                        let mut collection = api_cmd::api_create_collection(app.state::<Db>(), workspace.clone(), format!("{label} · OAuth2"))?;
                        row.integrations.push(Created { kind: "apiCollection".into(), id: collection.id.clone(), label: format!("{label} · OAuth2"), service: def.id.into() });
                        collection.auth = market::keycloak_collection_auth().to_string();
                        collection.description = format!("OAuth2 (password grant) against the Keycloak of the {} stack. Select its environment, «{label}», to send.", row.name);
                        let collection_id = collection.id.clone();
                        api_cmd::api_update_collection(app.state::<Db>(), collection)?;
                        api_cmd::api_create_request(app.state::<Db>(), collection_id, None, "OpenID configuration".into(), "http".into(), market::keycloak_request_spec().to_string())?;
                    }
                }
                IntegrationKind::ApiEnvironment if !has(row, def.id, "apiEnvironment") => {
                    let mut environment = api_cmd::api_create_environment(app.state::<Db>(), workspace.clone(), label.clone())?;
                    environment.variables = market::http_variables(&service, def).to_string();
                    row.integrations.push(Created { kind: "apiEnvironment".into(), id: environment.id.clone(), label: label.clone(), service: def.id.into() });
                    api_cmd::api_update_environment(app.state::<Db>(), environment)?;
                }
                _ => {}
            }
            Ok(())
        })();
        if let Err(e) = result {
            notes.push(format!("{}: {e}", def.name));
        }
    }
    notes
}

// ---------------------------------------------------------------------------------- lifecycle

/// Every provisioned stack, with each service's state as its engine reports it (by the Compose
/// project's label). Each engine is asked once.
#[tauri::command]
pub async fn containers_market_list(app: AppHandle) -> Result<Vec<StackView>, String> {
    let rows = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        market::list(&conn).map_err(|e| e.to_string())?
    };
    let mut answers: BTreeMap<(String, String), Option<Vec<ContainerRow>>> = BTreeMap::new();
    for row in &rows {
        let key = (row.runtime.clone(), row.context.clone().unwrap_or_default());
        if !answers.contains_key(&key) {
            let answer = engine::list_containers(&row.target()).await.ok();
            answers.insert(key, answer);
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            let key = (row.runtime.clone(), row.context.clone().unwrap_or_default());
            view_of(row, answers.get(&key).and_then(|a| a.as_deref()))
        })
        .collect())
}

/// Brings a stack up — just prepared, or again after a failed `up`, a `down` from elsewhere, an edit
/// of its file — as a job of the jobs panel: `compose up -d`, waiting for the healthchecks where the
/// engine's Compose can (`--wait`), its output live. Answers with the job's terminal session.
///
/// The passwords are read from the Llavero now and handed to that one process in its environment
/// (`session::PreparedJob`): never on its command line, its label or a file. When it ends the stack
/// is settled here, before the panel hears of it — the integrations still missing are made only
/// after an `up` that succeeded; a failed one leaves Compose's last lines as the stack's error; one
/// closed from the panel leaves [`market::UP_CANCELLED`]. Either way the stack is kept, to be brought
/// up again or removed.
#[tauri::command]
pub async fn containers_market_up_job(app: AppHandle, registry: State<'_, TerminalRegistry>, id: String) -> Result<String, String> {
    let mut row = load(&app, &id)?;
    let target = row.target();
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("ctr has no Compose — install nerdctl for it".into());
    }
    let mut passwords = BTreeMap::new();
    for service in &row.services {
        if let Some(item) = &service.secret_item {
            passwords.insert(service.id.clone(), vault_read(&app, item)?);
        }
    }
    if !row.compose_file().is_file() {
        let yaml = market::compose_yaml(&row.name, &row.id, &row.services, engine)?;
        market::write_compose(Path::new(&row.dir), &yaml)?;
    }
    let wait = market::probe_up_wait(&target).await;
    let (program, args) = market::up_command(&row, wait)?;
    row.last_error.clear();
    save(&app, &row)?;

    let output = Arc::new(Mutex::new(String::new()));
    let kept = Arc::clone(&output);
    let on_output: Arc<dyn Fn(u64, &str) + Send + Sync> = Arc::new(move |_, chunk: &str| {
        if let Ok(mut buffer) = kept.lock() {
            market::keep_output_tail(&mut buffer, chunk);
        }
    });
    let finish_app = app.clone();
    let stack_id = row.id.clone();
    let mut held = passwords.clone();
    let on_exit: Box<dyn FnOnce(Option<i32>) + Send> = Box::new(move |code| {
        let printed = output.lock().map(|b| b.clone()).unwrap_or_default();
        finish_up(&finish_app, &stack_id, code, &printed, &held);
        for value in held.values_mut() {
            value.zeroize();
        }
    });
    let job = session::PreparedJob {
        program,
        args,
        label: format!("{} compose up · {}", row.runtime, row.name),
        secret_env: market::up_env(&passwords),
        on_output: Some(on_output),
        on_exit: Some(on_exit),
    };
    for value in passwords.values_mut() {
        value.zeroize();
    }
    match session::open_prepared(app.clone(), &registry, job) {
        Ok(session) => Ok(session),
        Err(e) => {
            row.last_error = e.clone();
            save(&app, &row)?;
            Err(e)
        }
    }
}

/// Settles a stack once its `up` job has ended — see [`containers_market_up_job`]. A stack removed
/// while it ran has nothing left to settle.
fn finish_up(app: &AppHandle, id: &str, code: Option<i32>, printed: &str, passwords: &BTreeMap<String, String>) {
    let Ok(mut row) = load(app, id) else { return };
    row.last_error = match code {
        Some(0) => integrate(app, &mut row, passwords).join("\n"),
        Some(code) => {
            let secrets: Vec<&str> = passwords.values().map(String::as_str).collect();
            market::up_failure(code, printed, &secrets)
        }
        None => market::UP_CANCELLED.to_string(),
    };
    let _ = save(app, &row);
    let _ = app.emit("containers:market-changed", json!({ "id": row.id }));
}

/// `start` or `stop` of the stack's project. Neither needs a password.
#[tauri::command]
pub async fn containers_market_start(app: AppHandle, id: String) -> Result<StackView, String> {
    lifecycle(&app, &id, "start").await
}

#[tauri::command]
pub async fn containers_market_stop(app: AppHandle, id: String) -> Result<StackView, String> {
    lifecycle(&app, &id, "stop").await
}

async fn lifecycle(app: &AppHandle, id: &str, action: &str) -> Result<StackView, String> {
    let row = load(app, id)?;
    engine::act(&row.target(), "project", action, std::slice::from_ref(&row.name), &row.compose_options()).await?;
    Ok(view(&row).await)
}

/// What a removal takes with it, besides the containers.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveOptions {
    /// The named volumes — the databases' data.
    #[serde(default)]
    pub volumes: bool,
    /// The connections made in Base de datos.
    #[serde(default)]
    pub connections: bool,
    /// The environments and collections made in the API client.
    #[serde(default)]
    pub api: bool,
    /// The Llavero entries (to its trash, where they can still be restored).
    #[serde(default)]
    pub vault: bool,
}

/// Takes a stack down and forgets it, undoing the integrations the options name. Answers with what
/// was kept that the user asked to remove (a locked Llavero keeps its entries).
#[tauri::command]
pub async fn containers_market_remove(app: AppHandle, id: String, options: RemoveOptions) -> Result<Vec<String>, String> {
    let row = load(&app, &id)?;
    let target = row.target();
    let mut down_options = row.compose_options();
    down_options["volumes"] = json!(options.volumes);
    if let Err(error) = engine::act(&target, "project", "down", std::slice::from_ref(&row.name), &down_options).await {
        // Gone already — taken down from a terminal, the engine reset — is not a reason to keep it.
        let left = engine::list_containers(&target).await.map(|rows| rows.iter().any(|r| r.project == row.name));
        if left.unwrap_or(true) {
            return Err(error);
        }
    }
    let mut notes = Vec::new();
    for created in &row.integrations {
        let result = match created.kind.as_str() {
            "dbConnection" if options.connections => db_cmd::db_delete_connection(app.state::<Db>(), app.state(), created.id.clone()),
            "apiEnvironment" if options.api => api_cmd::api_delete_environment(app.state::<Db>(), created.id.clone()),
            "apiCollection" if options.api => api_cmd::api_delete_collection(app.state::<Db>(), created.id.clone()),
            "vaultItem" if options.vault => keyvault_cmd::keyvault_delete_item(app.state::<Db>(), app.state::<VaultSession>(), created.id.clone()),
            _ => Ok(()),
        };
        if let Err(e) = result {
            notes.push(format!("{}: {e}", created.label));
        }
    }
    // Only ever a folder of the stacks' own root: the path is read from a row, and a row is data.
    let dir = Path::new(&row.dir);
    if dir.starts_with(market::stacks_dir()) && dir != market::stacks_dir() {
        let _ = std::fs::remove_dir_all(dir);
    }
    {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        market::delete(&conn, &row.id).map_err(|e| e.to_string())?;
    }
    Ok(notes)
}
