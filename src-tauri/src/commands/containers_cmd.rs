//! The Contenedores panel's commands: detect the runtimes, list and act on what they hold, open a
//! container's logs or a shell inside it, and keep Kubernetes port-forwards. See `crate::containers`.

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::claude_cmd::{load_ai_config_in, AiTask};
use crate::containers::{self, engine, forward, kube, session};
use crate::db::Db;
use crate::terminal::TerminalRegistry;
use crate::{ai, ai_runs};

#[tauri::command]
pub async fn containers_detect() -> Result<Vec<containers::RuntimeInfo>, String> {
    Ok(containers::detect().await)
}

/// One list of an engine: `containers`, `images`, `volumes`, `networks` — or, for Kubernetes, a
/// kind (`pods`, `deployments`, …) in a namespace (`""` = all).
#[tauri::command]
pub async fn containers_list(runtime: String, context: Option<String>, namespace: Option<String>, what: String) -> Result<Value, String> {
    if runtime == "kubernetes" {
        let target = kube::KubeTarget { context, namespace };
        return kube::list(&target, &what).await.map(|rows| json!(rows));
    }
    let target = engine::Target { runtime, context };
    engine::list(&target, &what).await
}

/// Does `action` to `ids` — containers, images, volumes, networks or Compose projects of an engine,
/// or Kubernetes objects of a kind (`object` is the kind there).
#[tauri::command]
pub async fn containers_act(
    runtime: String,
    context: Option<String>,
    namespace: Option<String>,
    object: String,
    action: String,
    ids: Vec<String>,
    options: Option<Value>,
) -> Result<String, String> {
    let options = options.unwrap_or_else(|| json!({}));
    if runtime == "kubernetes" {
        let target = kube::KubeTarget { context, namespace };
        if action == "useContext" {
            return kube::use_context(ids.first().map(String::as_str).unwrap_or_default()).await;
        }
        return kube::act(&target, &object, &ids, &action, &options).await;
    }
    let target = engine::Target { runtime, context };
    engine::act(&target, &object, &action, &ids, &options).await
}

/// Text about one object: an engine's `inspect` (pretty JSON), or Kubernetes' `describe` / `yaml`.
#[tauri::command]
pub async fn containers_text(
    runtime: String,
    context: Option<String>,
    namespace: Option<String>,
    object: String,
    id: String,
    view: String,
    reveal: Option<bool>,
) -> Result<String, String> {
    if runtime == "kubernetes" {
        let target = kube::KubeTarget { context, namespace };
        return kube::text(&target, &object, &id, &view, reveal.unwrap_or(false)).await;
    }
    let target = engine::Target { runtime, context };
    engine::inspect(&target, &object, &id).await
}

/// A container's inspect document read into what its detail shows, plus what it uses right now.
#[tauri::command]
pub async fn containers_container_detail(runtime: String, context: Option<String>, id: String, running: bool) -> Result<Value, String> {
    let target = engine::Target { runtime, context };
    let doc_text = engine::inspect(&target, "container", &id).await?;
    let doc: Value = serde_json::from_str(&doc_text).unwrap_or(Value::Null);
    let mut summary = engine::summary_of_inspect(&doc);
    if running {
        if let Ok(stats) = engine::stats(&target, &id).await {
            summary["stats"] = stats;
        }
    }
    Ok(summary)
}

/// The last `lines` of a container's log, credentials redacted — what Codi reads to say why one
/// stopped, without opening the panel.
#[tauri::command]
pub async fn containers_logs_tail(runtime: String, context: Option<String>, id: String, lines: u32) -> Result<String, String> {
    let target = engine::Target { runtime, context };
    let args = vec!["logs".to_string(), "--tail".into(), lines.clamp(1, 2_000).to_string(), id];
    let output = target.run_owned(args, std::time::Duration::from_secs(30)).await?;
    if !output.ok() {
        return Err(output.complaint());
    }
    // A container's stdout and stderr both go to its log; the CLI hands them back apart.
    Ok(crate::secret_scan::redact(&format!("{}{}", output.stdout, output.stderr)).0)
}

#[tauri::command]
pub async fn containers_namespaces(runtime: String, context: Option<String>) -> Result<Vec<String>, String> {
    if runtime == "kubernetes" {
        let target = kube::KubeTarget { context, namespace: None };
        return kube::namespaces(&target).await;
    }
    let target = engine::Target { runtime, context };
    engine::namespaces(&target).await
}

/// Whether a Kubernetes context's cluster answers — its version, or why not.
#[tauri::command]
pub async fn containers_reach(context: Option<String>) -> Result<String, String> {
    kube::reach(&kube::KubeTarget { context, namespace: None }).await
}

#[tauri::command]
pub async fn containers_apply(context: Option<String>, namespace: Option<String>, manifest: String) -> Result<String, String> {
    kube::apply(&kube::KubeTarget { context, namespace }, &manifest).await
}

/// «Analizar con IA» on a log pane: the log as the pane shows it, explained by the engine the `logs`
/// task is routed to — the picker beside the button writes that route. `workspace_id` is the
/// window's, so the account it runs as is the one the picker names; the containers themselves belong
/// to no workspace. Cancellable through `run_id`, like every other run.
#[tauri::command]
pub async fn containers_analyze_logs(
    app: AppHandle,
    db: State<'_, Db>,
    log: String,
    about: String,
    language: Option<String>,
    run_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<String, String> {
    let config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        load_ai_config_in(&conn, AiTask::Logs, workspace_id.as_deref())?
    };
    let language = language.unwrap_or_else(|| "es".to_string());
    ai_runs::scoped(app, run_id, async {
        ai::analyze_logs(&*config.engine, &config.binary, &config.model, &about, &log, &language).await
    })
    .await
}

/// A container's logs or a shell inside it, as a terminal session id for the xterm pane.
///
/// `(async)`, like `write_terminal` and the rest (see `terminal_cmd`): opening one creates a
/// pseudo-console and starts the engine's CLI, which on Windows — a ConPTY, and an antivirus that
/// looks at every process start — can take a second or two. On the main thread that was the whole
/// window frozen each time a container's Terminal or Registro tab was opened.
#[tauri::command(async)]
pub fn containers_open_session(app: AppHandle, registry: State<TerminalRegistry>, request: session::SessionRequest) -> Result<String, String> {
    session::open(app, &registry, &request)
}

#[tauri::command]
pub async fn containers_start_runtime(how: String) -> Result<String, String> {
    containers::start_runtime(&how).await
}

#[tauri::command]
pub async fn containers_forward_open(request: forward::ForwardRequest) -> Result<forward::ForwardView, String> {
    forward::open(request).await
}

#[tauri::command]
pub fn containers_forward_close(id: String) {
    forward::close(&id);
}

#[tauri::command]
pub fn containers_forwards() -> Vec<forward::ForwardView> {
    forward::list()
}

// ---------- the manager: run, stats, files, limits, volumes, networks, images ----------

/// Docker Hub's search — for the image field of «Ejecutar contenedor».
#[tauri::command]
pub async fn containers_hub_search(term: String, limit: Option<usize>) -> Result<Vec<containers::hub::HubRepo>, String> {
    containers::hub::search(&term, limit.unwrap_or(10).clamp(1, 50)).await
}

/// A Docker Hub repository's tags, newest first.
#[tauri::command]
pub async fn containers_hub_tags(repo: String, limit: Option<usize>) -> Result<Vec<containers::hub::HubTag>, String> {
    containers::hub::tags(&repo, limit.unwrap_or(30).clamp(1, 100)).await
}

/// Runs a container from the form; its id.
#[tauri::command]
pub async fn containers_run(runtime: String, context: Option<String>, spec: containers::run::RunSpec) -> Result<String, String> {
    containers::run::run(&engine::Target { runtime, context }, &spec).await
}

/// Live CPU, memory, network and disk of `ids` — every running container when `ids` is empty.
#[tauri::command]
pub async fn containers_stats(runtime: String, context: Option<String>, ids: Option<Vec<String>>) -> Result<Vec<containers::manage::ContainerStats>, String> {
    containers::manage::stats_all(&engine::Target { runtime, context }, &ids.unwrap_or_default()).await
}

#[tauri::command]
pub async fn containers_files(runtime: String, context: Option<String>, id: String, path: String) -> Result<Vec<containers::files::FileEntry>, String> {
    containers::files::browse(&engine::Target { runtime, context }, &id, &path).await
}

#[tauri::command]
pub async fn containers_file_delete(runtime: String, context: Option<String>, id: String, path: String) -> Result<(), String> {
    containers::files::delete(&engine::Target { runtime, context }, &id, &path).await
}

#[tauri::command]
pub async fn containers_file_upload(runtime: String, context: Option<String>, id: String, dir: String, host_paths: Vec<String>) -> Result<(), String> {
    containers::files::upload(&engine::Target { runtime, context }, &id, &dir, &host_paths).await
}

#[tauri::command]
pub async fn containers_file_download(runtime: String, context: Option<String>, id: String, path: String, host_dir: String) -> Result<String, String> {
    containers::files::download(&engine::Target { runtime, context }, &id, &path, &host_dir).await
}

#[tauri::command]
pub async fn containers_update_limits(runtime: String, context: Option<String>, id: String, memory_mb: Option<f64>, cpus: Option<f64>) -> Result<(), String> {
    containers::manage::update_limits(&engine::Target { runtime, context }, &id, memory_mb, cpus).await
}

/// Volume `name` as a `.tar.gz` at `path` (what the save dialog returned). Returns the bytes written.
#[tauri::command]
pub async fn containers_backup_volume(runtime: String, context: Option<String>, name: String, path: String) -> Result<u64, String> {
    containers::manage::backup_volume(&engine::Target { runtime, context }, &name, std::path::Path::new(&path)).await
}

/// A `.tar.gz` at `path` unpacked into volume `name`, made if missing; `replace` empties it first.
#[tauri::command]
pub async fn containers_restore_volume(runtime: String, context: Option<String>, name: String, path: String, replace: bool) -> Result<(), String> {
    containers::manage::restore_volume(&engine::Target { runtime, context }, &name, std::path::Path::new(&path), replace).await
}

#[tauri::command]
pub async fn containers_create_volume(runtime: String, context: Option<String>, name: String, driver: Option<String>) -> Result<(), String> {
    containers::manage::create_volume(&engine::Target { runtime, context }, &name, driver.as_deref().unwrap_or_default()).await
}

#[tauri::command]
pub async fn containers_create_network(runtime: String, context: Option<String>, name: String, driver: Option<String>) -> Result<(), String> {
    containers::manage::create_network(&engine::Target { runtime, context }, &name, driver.as_deref().unwrap_or_default()).await
}

#[tauri::command]
pub async fn containers_image_history(runtime: String, context: Option<String>, image: String) -> Result<Vec<containers::manage::ImageLayer>, String> {
    containers::manage::image_history(&engine::Target { runtime, context }, &image).await
}

/// BuildKit's build history for a Docker engine (`docker buildx history ls`).
#[tauri::command]
pub async fn containers_buildkit_history(runtime: String, context: Option<String>) -> Result<Vec<containers::builds::BuildRecord>, String> {
    containers::builds::list(&engine::Target { runtime, context }).await
}

/// One build of that history: its record and its plain log.
#[tauri::command]
pub async fn containers_buildkit_detail(runtime: String, context: Option<String>, id: String) -> Result<containers::builds::BuildDetail, String> {
    containers::builds::detail(&engine::Target { runtime, context }, &id).await
}

/// Deletes builds from BuildKit's history (`docker buildx history rm`); the images they made stay.
#[tauri::command]
pub async fn containers_buildkit_remove(runtime: String, context: Option<String>, ids: Vec<String>) -> Result<(), String> {
    containers::builds::remove(&engine::Target { runtime, context }, &ids).await
}

/// The vulnerability scanner installed on this computer (Trivy or Grype), if any.
#[tauri::command]
pub async fn containers_scanner_detect() -> Option<containers::scan::Scanner> {
    tokio::task::spawn_blocking(containers::scan::detect).await.ok().flatten()
}

/// An image's known vulnerabilities, from that scanner run locally against the engine's copy — kept
/// in the image's history, whose id the result carries.
#[tauri::command]
pub async fn containers_image_scan(db: State<'_, Db>, runtime: String, context: Option<String>, image: String) -> Result<containers::scan::ScanResult, String> {
    let mut result = containers::scan::scan(&engine::Target { runtime, context }, &image).await?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // A scan that could not be kept is still the answer the page asked for.
    if let Err(e) = containers::scan::record(&conn, image.trim(), &mut result) {
        crate::applog::error(&format!("containers: could not keep the scan of {image}: {e}"));
    }
    Ok(result)
}

/// The kept scans of an image, newest first, counted by severity.
#[tauri::command]
pub fn containers_scan_history(db: State<'_, Db>, image: String) -> Result<Vec<containers::scan::ScanSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    containers::scan::history(&conn, image.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn containers_scan_get(db: State<'_, Db>, id: String) -> Result<Option<containers::scan::ScanResult>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    containers::scan::get(&conn, &id).map_err(|e| e.to_string())
}

/// What scan `later` found that `earlier` did not, and what it no longer finds.
#[tauri::command]
pub fn containers_scan_compare(db: State<'_, Db>, earlier: String, later: String) -> Result<containers::scan::ScanComparison, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let load = |id: &str| containers::scan::get(&conn, id).map_err(|e| e.to_string())?.ok_or_else(|| format!("scan {id} is no longer kept"));
    let (earlier, later) = (load(&earlier)?, load(&later)?);
    Ok(containers::scan::compare(&earlier.findings, &later.findings))
}

#[tauri::command]
pub fn containers_scan_forget(db: State<'_, Db>, image: String) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    containers::scan::delete_history(&conn, image.trim()).map_err(|e| e.to_string())
}

/// What can write an SBOM on this computer (Trivy or Syft), if anything.
#[tauri::command]
pub async fn containers_sbom_tool() -> Option<containers::scan::Scanner> {
    tokio::task::spawn_blocking(containers::scan::sbom_tool).await.ok().flatten()
}

/// An image's SBOM written to `path` as `format` (`cyclonedx` or `spdx`); the tool that wrote it.
#[tauri::command]
pub async fn containers_image_sbom(runtime: String, context: Option<String>, image: String, format: String, path: String) -> Result<String, String> {
    containers::scan::sbom(&engine::Target { runtime, context }, &image, &format, &path).await
}

/// What a container added, changed and deleted in its filesystem against its image.
#[tauri::command]
pub async fn containers_container_diff(runtime: String, context: Option<String>, id: String) -> Result<Vec<containers::manage::DiffEntry>, String> {
    containers::manage::container_diff(&engine::Target { runtime, context }, &id).await
}

/// What in a container's configuration weakens its isolation, most severe first.
#[tauri::command]
pub async fn containers_hardening(runtime: String, context: Option<String>, id: String) -> Result<Vec<containers::hardening::HardeningFinding>, String> {
    let doc_text = engine::inspect(&engine::Target { runtime, context }, "container", &id).await?;
    let doc: Value = serde_json::from_str(&doc_text).map_err(|e| format!("could not read the container's inspect: {e}"))?;
    Ok(containers::hardening::audit(&doc))
}

/// Where `hadolint` is on this computer, if it is.
#[tauri::command]
pub async fn containers_hadolint_detect() -> Option<String> {
    tokio::task::spawn_blocking(containers::hardening::hadolint).await.ok().flatten()
}

#[tauri::command]
pub async fn containers_dockerfile_lint(path: String) -> Result<Vec<containers::hardening::LintFinding>, String> {
    containers::hardening::lint_dockerfile(&path).await
}

#[tauri::command]
pub async fn containers_disk_usage(runtime: String, context: Option<String>) -> Result<Vec<containers::manage::DiskUsageRow>, String> {
    containers::manage::disk_usage(&engine::Target { runtime, context }).await
}

/// A remote Docker engine (`ssh://user@host`, `tcp://host:2376`) added as a Docker context.
#[tauri::command]
pub async fn containers_docker_context_add(name: String, host: String, description: Option<String>) -> Result<(), String> {
    containers::manage::add_docker_context(&name, &host, description.as_deref().unwrap_or_default()).await
}
