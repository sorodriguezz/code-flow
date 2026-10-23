//! Serving a trained adapter: one server at a time, on a loopback port, with the adapter applied to
//! every request — the «CodeFlow» provider talks to it as an OpenAI-compatible server. Which server
//! depends on what trained it ([`Target`]):
//!
//! - **MLX adapters** (Apple Silicon): `mlx_lm server --adapter-path`. It maps a request for the
//!   model it was started with to its "default model", the one loaded with the adapter; so requests
//!   name the base repo and the adapter stays on. Never downloads: `HF_HUB_OFFLINE=1` — the base's
//!   weights arrived with the training run, the only step that fetches anything.
//! - **PEFT adapters** (NVIDIA): converted to a GGUF LoRA ([`super::gguf_lora`]) and applied by the
//!   bundled `llama-server --lora` over the base's GGUF from the Local model catalogue — the same
//!   engine the «CodeFlow» provider runs, on Vulkan, Metal or the CPU.
//!
//! The evaluation measures the base on the same server without the adapter, so base and candidate
//! are compared on the same weights, quantisation and sampler.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::hybrid::config::Settings;
use crate::hybrid::local_llm::BackendKind;

/// `mlx_lm server` with one fix: a tool call written as a Python literal is read rather than
/// dropping the connection (see the script's docstring).
const LAUNCHER: &str = include_str!("serve_mlx.py");

/// The prefix that names an adapter among the «CodeFlow» provider's models.
pub const PREFIX: &str = "adapter:";

/// How long a load may take: a 7B base from disk is seconds; a first compile of the Metal kernels
/// adds a few more.
const READY_WAIT: Duration = Duration::from_secs(180);
/// How long a swap waits for runs still using the slot before it stops them anyway.
const SWAP_WAIT: Duration = Duration::from_secs(300);
/// An idle server is stopped after this long.
const IDLE: Duration = Duration::from_secs(15 * 60);

/// What a slot serves.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// `mlx_lm server` over a Hugging Face repo (in `training/hf`), with an MLX adapter directory.
    Mlx { repo: String, adapter: Option<PathBuf> },
    /// The bundled `llama-server` over a GGUF, with a GGUF LoRA. `alias` is the model name it
    /// answers to; `ctx` its window (llama-server cannot change it after launch).
    Llama { model: PathBuf, lora: Option<PathBuf>, alias: String, ctx: u32 },
}

impl Target {
    fn key(&self) -> String {
        match self {
            Target::Mlx { repo, adapter } => format!("mlx|{repo}|{}", adapter.as_deref().map(|p| p.display().to_string()).unwrap_or_default()),
            Target::Llama { model, lora, ctx, .. } => {
                format!("llama|{}|{}|{ctx}", model.display(), lora.as_deref().map(|p| p.display().to_string()).unwrap_or_default())
            }
        }
    }

    /// The model name requests send.
    fn model_name(&self) -> String {
        match self {
            Target::Mlx { repo, .. } => repo.clone(),
            Target::Llama { alias, .. } => alias.clone(),
        }
    }
}

struct Slot {
    key: String,
    /// The adapter served, `None` for a bare base.
    adapter_id: Option<String>,
    model: String,
    port: u16,
    child: tokio::process::Child,
    leases: Arc<AtomicUsize>,
    last_used: Instant,
    /// The memory it holds, as far as is known: the GGUF and its LoRA plus llama.cpp's working
    /// buffers for a `llama-server`; 0 for `mlx_lm`, whose weights live in the Hugging Face cache.
    bytes: u64,
}

/// The adapter server's port and the memory it holds, when one is up — for the fit estimate of a
/// model beside it (`hybrid::runtime::resident_beside`). `None` while a swap holds the slot.
pub fn resident() -> Option<(u16, u64)> {
    let guard = SLOT.try_lock().ok()?;
    let slot = guard.as_ref()?;
    Some((slot.port, slot.bytes))
}

static SLOT: Mutex<Option<Slot>> = Mutex::const_new(None);

/// Holds the slot as in use: a swap waits for every lease to drop.
pub struct Lease(Arc<AtomicUsize>);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn pidfile() -> PathBuf {
    crate::paths::state_dir().join(".adapter-serve.pid")
}

fn alive(child: &mut tokio::process::Child) -> bool {
    matches!(child.try_wait(), Ok(None))
}

async fn stop_slot(slot: &mut Slot) {
    crate::background::release_id(slot.child.id());
    let _ = slot.child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), slot.child.wait()).await;
    let _ = std::fs::remove_file(pidfile());
}

/// What a caller reaches the server at: the base URL (no `/v1`, as an OpenAI endpoint setting is
/// written) and the model name to send.
#[derive(Clone, Debug)]
pub struct Served {
    pub url: String,
    pub model: String,
}

/// Serves `target` and returns where once it answers; a second call for the same target reuses the
/// running server. `adapter_id` names the adapter, for [`current`].
pub async fn ensure(target: &Target, adapter_id: Option<&str>) -> Result<(Served, Lease), String> {
    match target {
        Target::Mlx { repo, .. } => {
            if !super::env::python().is_file() {
                return Err("the training environment isn't prepared — prepare it under Settings › Local AI › Learning".into());
            }
            if !super::env::downloaded(repo) {
                return Err(format!("{repo} isn't on this machine — a training run downloads it"));
            }
        }
        Target::Llama { model, lora, .. } => {
            if !model.is_file() {
                return Err(format!("the base model isn't downloaded ({})", model.display()));
            }
            if let Some(lora) = lora.as_ref().filter(|l| !l.is_file()) {
                return Err(format!("the converted adapter is missing ({})", lora.display()));
            }
        }
    }
    let key = target.key();
    let asked = Instant::now();
    loop {
        let mut guard = SLOT.lock().await;
        if let Some(slot) = guard.as_mut() {
            let same = slot.key == key;
            if same && alive(&mut slot.child) {
                slot.leases.fetch_add(1, Ordering::SeqCst);
                slot.last_used = Instant::now();
                return Ok((served(slot), Lease(slot.leases.clone())));
            }
            if !same && slot.leases.load(Ordering::SeqCst) > 0 && asked.elapsed() < SWAP_WAIT && alive(&mut slot.child) {
                drop(guard);
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            stop_slot(slot).await;
            *guard = None;
        }
        let slot = start(target, key, adapter_id).await?;
        slot.leases.fetch_add(1, Ordering::SeqCst);
        let answer = (served(&slot), Lease(slot.leases.clone()));
        *guard = Some(slot);
        return Ok(answer);
    }
}

fn served(slot: &Slot) -> Served {
    Served { url: format!("http://127.0.0.1:{}", slot.port), model: slot.model.clone() }
}

fn command(target: &Target, port: u16) -> Result<tokio::process::Command, String> {
    match target {
        Target::Mlx { repo, adapter } => {
            let launcher = super::root().join("serve_mlx.py");
            std::fs::write(&launcher, LAUNCHER).map_err(|e| e.to_string())?;
            let mut cmd = tokio::process::Command::new(super::env::python());
            cmd.arg("-I").arg(&launcher);
            cmd.args(["--model", repo, "--host", "127.0.0.1", "--port", &port.to_string(), "--max-tokens", "4096"]);
            if let Some(adapter) = adapter {
                cmd.arg("--adapter-path").arg(adapter);
            }
            cmd.env("HF_HUB_OFFLINE", "1");
            super::env::prepare_command(&mut cmd);
            Ok(cmd)
        }
        Target::Llama { model, lora, alias, ctx } => {
            let mut cmd = crate::proc::command(crate::localai::engine::locate()?);
            // The executor's flags (`localai::executor`): loopback only, one slot so the whole window
            // is the request's, no `-ngl` so `--fit` places what the GPU holds.
            // `--cache-ram 0` as on the executor: no finished prompts kept in RAM beside the model
            // (llama.cpp keeps up to 8 GB by default; the embedder grew to ~9 GB without it).
            cmd.arg("-m").arg(model).args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", &ctx.to_string(), "-np", "1", "--cache-ram", "0", "--no-webui", "--alias", alias]);
            if let Some(lora) = lora {
                cmd.arg("--lora").arg(lora);
            }
            Ok(cmd)
        }
    }
}

async fn start(target: &Target, key: String, adapter_id: Option<&str>) -> Result<Slot, String> {
    std::fs::create_dir_all(super::root()).map_err(|e| e.to_string())?;
    let port = crate::localai::engine::free_port()?;
    let log_path = super::root().join("serve.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut cmd = command(target, port)?;
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(log).kill_on_drop(true);
    let program = std::path::Path::new(cmd.as_std().get_program()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = cmd.spawn().map_err(|e| format!("could not start the adapter server: {e}"))?;
    if let Some(pid) = child.id() {
        let _ = std::fs::write(pidfile(), format!("{pid}\n{port}\n"));
        crate::background::adopt(pid, &program, "adapter", &key);
    }
    let probe = format!("http://127.0.0.1:{port}/v1/models");
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if !alive(&mut child) {
            let _ = std::fs::remove_file(pidfile());
            return Err(format!("the adapter server stopped while loading: {}", last_lines(&log_path, 6)));
        }
        if client.get(&probe).send().await.is_ok_and(|r| r.status().is_success()) {
            break;
        }
        if started.elapsed() > READY_WAIT {
            crate::background::release_id(child.id());
            let _ = child.start_kill();
            let _ = std::fs::remove_file(pidfile());
            return Err(format!("the adapter server didn't answer in {} s: {}", READY_WAIT.as_secs(), last_lines(&log_path, 6)));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let bytes = match target {
        Target::Llama { model, lora, .. } => {
            let size = |path: &Path| std::fs::metadata(path).map_or(0, |meta| meta.len());
            size(model) + lora.as_deref().map_or(0, size) + crate::hybrid::budget::WORKING_OVERHEAD
        }
        Target::Mlx { .. } => 0,
    };
    Ok(Slot {
        key,
        adapter_id: adapter_id.map(str::to_string),
        model: target.model_name(),
        port,
        child,
        leases: Arc::new(AtomicUsize::new(0)),
        last_used: Instant::now(),
        bytes,
    })
}

/// The last `n` non-empty lines of a log, for an error message.
pub fn last_lines(path: &Path, n: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" · ")
}

/// What is being served now: `(adapter id or none for a bare base, model name)`.
pub async fn current() -> Option<(Option<String>, String)> {
    let mut guard = SLOT.lock().await;
    let slot = guard.as_mut()?;
    alive(&mut slot.child).then(|| (slot.adapter_id.clone(), slot.model.clone()))
}

/// Stops the server (when nothing holds it, unless `force`).
pub async fn stop(force: bool) {
    let mut guard = SLOT.lock().await;
    if let Some(slot) = guard.as_mut() {
        if force || slot.leases.load(Ordering::SeqCst) == 0 {
            stop_slot(slot).await;
            *guard = None;
        }
    }
}

/// Stops a server idle for [`IDLE`]; called by the reaper.
pub async fn reap_idle() {
    let mut guard = SLOT.lock().await;
    if let Some(slot) = guard.as_mut() {
        if slot.leases.load(Ordering::SeqCst) == 0 && slot.last_used.elapsed() > IDLE {
            stop_slot(slot).await;
            *guard = None;
        }
    }
}

/// On quit (`process::exit` runs no destructor): kill it outright.
pub fn shutdown() {
    if let Ok(mut guard) = SLOT.try_lock() {
        if let Some(slot) = guard.as_mut() {
            crate::background::release_id(slot.child.id());
            let _ = slot.child.start_kill();
        }
        *guard = None;
    }
    let _ = std::fs::remove_file(pidfile());
}

/// Kills a server a previous run left behind (Force Quit, a crash), after checking that the pid is
/// still ours — our venv's Python running the launcher, or the bundled `llama-server` — pids are
/// reused.
pub fn sweep_stale() {
    let Ok(text) = std::fs::read_to_string(pidfile()) else { return };
    let _ = std::fs::remove_file(pidfile());
    let Some(pid) = text.lines().next().and_then(|l| l.trim().parse::<u32>().ok()) else { return };
    let mut system = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(pid);
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[pid]), true, sysinfo::ProcessRefreshKind::everything());
    let Some(process) = system.process(pid) else { return };
    let venv = super::env::venv_dir();
    let llama = crate::localai::engine::locate().ok();
    let ours = process.exe().is_some_and(|exe| exe.starts_with(&venv) || llama.as_deref() == Some(exe))
        || process.cmd().iter().any(|arg| arg.to_string_lossy().ends_with("serve_mlx.py"));
    if ours {
        process.kill();
    }
}

/// When `wanted` names an adapter (`adapter:<id>`), the settings that reach it: the adapter served
/// and the «CodeFlow» provider pointed at that server. `None` for any other model.
pub async fn adapter_settings(wanted: &str, base: &Settings) -> Option<Result<(Settings, Lease), String>> {
    let id = wanted.trim().strip_prefix(PREFIX)?;
    Some(adapter_settings_for(id, base).await)
}

async fn adapter_settings_for(id: &str, base: &Settings) -> Result<(Settings, Lease), String> {
    let adapter = crate::ai_usage::with_conn(|conn| super::trainer::adapter(conn, id))
        .ok_or("the database is not available")?
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("the adapter {id} no longer exists"))?;
    if adapter.status == "retired" || adapter.status == "rejected" {
        return Err(format!("the adapter «{}» isn't published", adapter.name));
    }
    let (_, candidate) = targets(&adapter, window(base))?;
    let (served, lease) = ensure(&candidate, Some(id)).await?;
    Ok((served_settings(&served, base), lease))
}

/// The window a served model gets: the pane's, at most 16k — what the bench uses on this Mac.
pub fn window(base: &Settings) -> u32 {
    base.ctx.unwrap_or(16_384).min(16_384)
}

/// The GGUF LoRA a PEFT adapter is served as, converted on first use and again whenever the
/// adapter's weights are newer than the conversion.
pub fn adapter_gguf(adapter_dir: &Path, base_gguf: &Path) -> Result<PathBuf, String> {
    let out = adapter_dir.join("adapter.gguf");
    let weights = ["adapter_model.safetensors", "adapters.safetensors"].iter().map(|f| adapter_dir.join(f)).find(|p| p.is_file());
    let Some(weights) = weights else {
        return Err(format!("no adapter weights at {}", adapter_dir.display()));
    };
    let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    let fresh = matches!((modified(&out), modified(&weights)), (Some(converted), Some(trained)) if converted >= trained);
    if !fresh {
        super::gguf_lora::convert(adapter_dir, base_gguf, &out)?;
    }
    Ok(out)
}

/// What serves `adapter`'s base alone and with the adapter: `(base, candidate)`, on the same engine.
pub fn targets(adapter: &super::trainer::AdapterRow, ctx: u32) -> Result<(Target, Target), String> {
    let base = super::base(&adapter.base_model).ok_or_else(|| format!("unknown base {}", adapter.base_model))?;
    let path = PathBuf::from(&adapter.path);
    match adapter.format.as_str() {
        "mlx-lora" => {
            if !path.join("adapters.safetensors").is_file() {
                return Err(format!("the adapter «{}» is missing its weights at {}", adapter.name, path.display()));
            }
            Ok((
                Target::Mlx { repo: base.mlx_repo.to_string(), adapter: None },
                Target::Mlx { repo: base.mlx_repo.to_string(), adapter: Some(path) },
            ))
        }
        "peft-lora" => {
            let model = base_gguf(base)?;
            let lora = adapter_gguf(&path, &model)?;
            let alias = base.id.to_string();
            Ok((
                Target::Llama { model: model.clone(), lora: None, alias: alias.clone(), ctx },
                Target::Llama { model, lora: Some(lora), alias, ctx },
            ))
        }
        other => Err(format!("unknown adapter format {other}")),
    }
}

/// The base's GGUF from the Local model catalogue, which must be downloaded.
pub fn base_gguf(base: &super::Base) -> Result<PathBuf, String> {
    let id = base.gguf.ok_or_else(|| format!("{} has no GGUF in the Local model catalogue, so its PEFT adapters can't be served", base.label))?;
    let entry = crate::localai::exec_catalogue::find(id).ok_or_else(|| format!("{id} is not in the Local model catalogue"))?;
    let path = crate::localai::models::path_of(&entry.spec);
    if !path.is_file() {
        return Err(format!("download {} under Settings › Local model to serve its adapters", entry.spec.label));
    }
    Ok(path)
}

/// `base` pointed at a server this module runs.
pub fn served_settings(served: &Served, base: &Settings) -> Settings {
    let mut settings = base.clone();
    settings.backend = Some(BackendKind::Openai);
    settings.url_openai = Some(served.url.clone());
    settings.model_openai = Some(served.model.clone());
    settings.ctx = Some(window(base));
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_its_engine_model_adapter_and_window() {
        let mlx = Target::Mlx { repo: "org/base".into(), adapter: None };
        let tuned = Target::Mlx { repo: "org/base".into(), adapter: Some("/a".into()) };
        assert_ne!(mlx.key(), tuned.key());
        assert_eq!(tuned.model_name(), "org/base");
        let llama = |ctx| Target::Llama { model: "/m.gguf".into(), lora: Some("/a.gguf".into()), alias: "base-id".into(), ctx };
        assert_ne!(llama(8_192).key(), llama(16_384).key(), "a new window is a new process");
        assert_eq!(llama(8_192).model_name(), "base-id");
    }

    #[test]
    fn last_lines_keeps_the_tail() {
        let dir = std::env::temp_dir().join(format!("serve-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("x.log");
        std::fs::write(&log, "a\n\nb\nc\nd\n").unwrap();
        assert_eq!(last_lines(&log, 2), "c · d");
        let _ = std::fs::remove_dir_all(dir);
    }
}
