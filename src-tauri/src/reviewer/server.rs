//! The local SonarQube: started on demand, bound to the loopback, stopped when idle and on quit.
//!
//! # How it is run
//!
//! Not through `bin/<os>/sonar.sh` or `StartSonar.bat`: those differ per platform, daemonize on
//! request and look for `java` on `PATH`. The launcher they end in is one `java` command, the same
//! on every platform, and the app runs it directly on the JDK it downloaded — the launcher then starts
//! the web server, the compute engine and Elasticsearch as children on that same JDK (`java.home`).
//! It is put in a process group of its own, so stopping it can reach all four.
//!
//! `conf/sonar.properties` is the app's to write — the install is ours — and is rewritten before
//! every start (see [`properties`]). Two lines in it are there because of what happened the first
//! time it ran here:
//!
//! - `sonar.web.host=127.0.0.1`: nothing but this machine can reach the server. Its admin password
//!   is one the app generated, but a review is somebody's source code, and a laptop on café Wi-Fi is
//!   not where that should be listening.
//! - the disk watermark switched off. Elasticsearch refuses to allocate a shard on a disk more than
//!   90 % full, *whatever* is left in absolute terms — on the machine this was written on, 17 GB free
//!   of 228 GB failed the first boot with "no shard available". SonarQube passes the setting through
//!   when it appears in `sonar.search.javaAdditionalOpts` (its `EsSettings`). The download already
//!   checks for room, which is the check that matters on a desktop.
//!
//! # Stopping
//!
//! SIGTERM to the launcher is its graceful stop — it takes its three children down in order, in a
//! second or two. Windows has no SIGTERM: there the launcher ships `sonar-shutdowner`, which asks for
//! a stop through the shared-memory file in `sonar.path.temp`. Either way, a launcher still there
//! after [`STOP_GRACE`] has its whole tree killed.
//!
//! # Crashes
//!
//! A server left running by an app that crashed is *adopted* on the next start rather than fought
//! over: `server.json` records its pid and port, and a launcher that answers `UP` there is taken as
//! ours. One that doesn't answer is killed before a new one starts on its data.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::api::{Auth, SonarClient};
use super::catalog;
use super::config::Memory;
use super::{install, Settings};

/// The event every change of the server's state is reported on.
pub const EVENT: &str = "reviewer:server";

/// How long the first boot may take. A cold first start creates the database and every index; on
/// the machine this was written on it took about ninety seconds.
const START_TIMEOUT: Duration = Duration::from_secs(300);

/// How long a stop waits for the launcher to take its children down before killing the tree.
const STOP_GRACE: Duration = Duration::from_secs(30);

/// Lines of the launcher's output kept for when it fails to start.
const LOG_LINES: usize = 400;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ServerStatus {
    Stopped,
    /// `detail` says which of the slow steps it is in.
    #[serde(rename_all = "camelCase")]
    Starting { port: u16, detail: Option<String> },
    #[serde(rename_all = "camelCase")]
    Running { port: u16, url: String, version: String },
    Stopping,
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

struct Shared {
    status: ServerStatus,
    /// The launcher's pid while it runs — ours, or adopted.
    pid: Option<u32>,
    port: u16,
    /// Set by [`stop`], so the exit it causes isn't reported as a crash.
    stopping: bool,
    last_used: Instant,
    /// Reviews in flight — the idle stop never fires under one.
    busy: u32,
    idle_minutes: u32,
    /// Bumped on every start, so an idle watcher from a previous run of the server retires.
    generation: u64,
    log: VecDeque<String>,
    /// Resolves when the launcher exits. `None` for an adopted server, which has no child of ours.
    exited: Option<tokio::sync::watch::Receiver<bool>>,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(|| {
    Mutex::new(Shared {
        status: ServerStatus::Stopped,
        pid: None,
        port: 0,
        stopping: false,
        last_used: Instant::now(),
        busy: 0,
        idle_minutes: 0,
        generation: 0,
        log: VecDeque::new(),
        exited: None,
    })
});

/// Start and stop take turns. A status read never waits behind them: it reads [`SHARED`].
static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// For the idle watcher and the crash report, which have no caller to hand them one.
static APP: OnceLock<AppHandle> = OnceLock::new();

fn shared() -> std::sync::MutexGuard<'static, Shared> {
    SHARED.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn set_status(status: ServerStatus) {
    shared().status = status.clone();
    if let Some(app) = APP.get() {
        let _ = app.emit(EVENT, status);
    }
}

pub fn status() -> ServerStatus {
    shared().status.clone()
}

pub fn log_tail(lines: usize) -> Vec<String> {
    let shared = shared();
    shared.log.iter().rev().take(lines).rev().cloned().collect()
}

/// A new idle limit from Settings, for the server already running.
pub fn set_idle_minutes(minutes: u32) {
    let mut shared = shared();
    shared.idle_minutes = minutes;
    shared.last_used = Instant::now();
}

/// Marks the server as used just now, which is what the idle stop measures from.
pub fn touch() {
    shared().last_used = Instant::now();
}

/// Holds the idle stop off for as long as it lives — one per review in flight.
pub struct Busy;

impl Busy {
    pub fn new() -> Self {
        let mut shared = shared();
        shared.busy += 1;
        shared.last_used = Instant::now();
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        let mut shared = shared();
        shared.busy = shared.busy.saturating_sub(1);
        shared.last_used = Instant::now();
    }
}

fn runtime_file() -> PathBuf {
    install::server_dir().join("server.json")
}

fn push_log(line: String) {
    let mut shared = shared();
    if shared.log.len() >= LOG_LINES {
        shared.log.pop_front();
    }
    shared.log.push_back(line);
}

/// The `conf/sonar.properties` the server is started with.
pub fn properties(port: u16, memory: Memory) -> String {
    let dir = install::server_dir();
    let path = |name: &str| dir.join(name).to_string_lossy().replace('\\', "/");
    let (web, ce, search) = match memory {
        Memory::Standard => ("-Xmx512m -Xms128m", "-Xmx512m -Xms128m", "-Xmx512m -Xms512m"),
        Memory::Large => ("-Xmx1g -Xms256m", "-Xmx2g -Xms256m", "-Xmx1g -Xms1g"),
    };
    format!(
        "# Written by CodeFlow before every start — edits here are overwritten.\n\
         sonar.web.host=127.0.0.1\n\
         sonar.web.port={port}\n\
         sonar.search.port=0\n\
         sonar.path.data={data}\n\
         sonar.path.temp={temp}\n\
         sonar.path.logs={logs}\n\
         sonar.telemetry.enable=false\n\
         sonar.web.javaOpts={web} -XX:+HeapDumpOnOutOfMemoryError\n\
         sonar.ce.javaOpts={ce} -XX:+HeapDumpOnOutOfMemoryError\n\
         sonar.search.javaOpts={search} -XX:MaxDirectMemorySize=256m -XX:+HeapDumpOnOutOfMemoryError\n\
         sonar.search.javaAdditionalOpts=-Dcluster.routing.allocation.disk.threshold_enabled=false\n",
        data = path("data"),
        temp = path("temp"),
        logs = path("logs"),
    )
}

/// The launcher's command line, after `java`. The same flags `sonar.sh` and `StartSonar.bat` pass.
fn launcher_args(home: &std::path::Path) -> Vec<String> {
    vec![
        "-Djava.awt.headless=true".into(),
        "--add-exports=java.base/jdk.internal.ref=ALL-UNNAMED".into(),
        "--add-opens=java.base/java.lang=ALL-UNNAMED".into(),
        "--add-opens=java.base/java.nio=ALL-UNNAMED".into(),
        "--add-opens=java.base/sun.nio.ch=ALL-UNNAMED".into(),
        "--add-opens=java.management/sun.management=ALL-UNNAMED".into(),
        "--add-opens=jdk.management/com.sun.management.internal=ALL-UNNAMED".into(),
        "-cp".into(),
        home.join(catalog::sonar_application_jar()).to_string_lossy().into_owned(),
        "org.sonar.application.App".into(),
        "-Dsonar.log.console=true".into(),
    ]
}

/// `preferred` when nothing is listening on it, else the next free port above it.
fn free_port(preferred: u16) -> u16 {
    let free = |port: u16| {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let nothing_answers =
            std::net::TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_err();
        nothing_answers && std::net::TcpListener::bind(address).is_ok()
    };
    let start = if preferred == 0 { 9000 } else { preferred };
    (start..start.saturating_add(200)).find(|port| free(*port)).unwrap_or(start)
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

async fn system_status(port: u16) -> Option<(String, String)> {
    let client = SonarClient::new(&base_url(port), Auth::None, true).ok()?;
    let value = client.get("api/system/status", &[]).await.ok()?;
    Some((
        value.get("status")?.as_str()?.to_string(),
        value.get("version").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
    ))
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists and may be signalled.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    let mut system = sysinfo::System::new();
    let pid = sysinfo::Pid::from_u32(pid);
    system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    system.process(pid).is_some()
}

/// Ends the launcher and everything it started, with no grace.
async fn kill_tree(pid: u32) {
    #[cfg(unix)]
    // SAFETY: a negative pid names the process group, which is the launcher's own — see
    // `proc::own_process_group`. A group already gone answers ESRCH, which is fine.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = crate::proc::command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await;
    }
}

/// Asks the launcher to stop the way it stops itself.
async fn ask_to_stop(pid: u32) {
    #[cfg(unix)]
    {
        // SAFETY: as above; the launcher handles SIGTERM by stopping its children in order.
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        let _ = pid;
        if let Some(java) = install::java() {
            let _ = crate::proc::command(java)
                .arg("-jar")
                .arg(install::sonar_home().join(catalog::sonar_shutdowner_jar()))
                .current_dir(install::sonar_home())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
        }
    }
}

/// Waits for `pid` to be gone, up to `grace`. `exited` is the launcher's own exit signal when this
/// app started it; an adopted one is polled.
async fn wait_gone(pid: u32, exited: Option<tokio::sync::watch::Receiver<bool>>, grace: Duration) -> bool {
    if let Some(mut exited) = exited {
        return tokio::time::timeout(grace, exited.wait_for(|gone| *gone)).await.is_ok();
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    !alive(pid)
}

/// Starts the local server, or answers with the one already running. Returns once it is `UP` and
/// signed in — on a first start that includes setting the rules up, which takes a few seconds more.
pub async fn start(app: Option<&AppHandle>, settings: &Settings) -> Result<ServerStatus, String> {
    let config = &settings.config;
    if let Some(app) = app {
        let _ = APP.set(app.clone());
    }
    let _turn = LIFECYCLE.lock().await;

    if let ServerStatus::Running { port, .. } = status() {
        if matches!(system_status(port).await, Some((state, _)) if state == "UP") {
            touch();
            return Ok(status());
        }
    }
    let Some(java) = install::java() else {
        return Err("The Reviewer isn't installed yet — download it in Settings › Reviewer.".into());
    };
    if !install::sonar_installed() {
        return Err("SonarQube isn't installed yet — download it in Settings › Reviewer.".into());
    }

    // A server a crashed session left behind: adopted when it answers, ended when it doesn't.
    if let Some((pid, port)) = read_runtime_file() {
        if alive(pid) {
            match system_status(port).await {
                Some((state, version)) if state == "UP" => {
                    {
                        let mut shared = shared();
                        shared.pid = Some(pid);
                        shared.port = port;
                        shared.exited = None;
                        shared.stopping = false;
                    }
                    set_status(ServerStatus::Starting { port, detail: Some("signing-in".into()) });
                    return finish_start(port, version, settings).await;
                }
                _ => {
                    kill_tree(pid).await;
                    let _ = wait_gone(pid, None, Duration::from_secs(5)).await;
                }
            }
        }
        let _ = std::fs::remove_file(runtime_file());
    }

    let home = install::sonar_home();
    let port = free_port(config.port);
    let server_dir = install::server_dir();
    for name in ["data", "temp", "logs"] {
        std::fs::create_dir_all(server_dir.join(name)).map_err(|e| format!("Couldn't create the server's folders: {e}"))?;
    }
    std::fs::write(home.join("conf").join("sonar.properties"), properties(port, config.memory))
        .map_err(|e| format!("Couldn't write SonarQube's configuration: {e}"))?;

    let mut command = crate::proc::command(&java);
    command
        .args(launcher_args(&home))
        .current_dir(&home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Its own memory settings come from sonar.properties; a JAVA_TOOL_OPTIONS meant for the
        // user's own tools would apply to all four JVMs.
        .env_remove("JAVA_TOOL_OPTIONS")
        .env_remove("_JAVA_OPTIONS");
    crate::proc::own_process_group(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Couldn't start SonarQube: {e}"))?;
    let pid = child.id().ok_or("SonarQube exited as soon as it started")?;
    let _ = std::fs::write(runtime_file(), serde_json::json!({ "pid": pid, "port": port }).to_string());

    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
                   child.stderr.take().map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>)]
        .into_iter()
        .flatten()
    {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                push_log(line);
            }
        });
    }

    let (exited_tx, exited_rx) = tokio::sync::watch::channel(false);
    {
        let mut shared = shared();
        shared.pid = Some(pid);
        shared.port = port;
        shared.stopping = false;
        shared.log.clear();
        shared.exited = Some(exited_rx.clone());
    }
    tokio::spawn(async move {
        let code = child.wait().await.ok().and_then(|status| status.code());
        let _ = exited_tx.send(true);
        let unexpected = {
            let mut shared = shared();
            let unexpected = !shared.stopping && shared.pid == Some(pid);
            if shared.pid == Some(pid) {
                shared.pid = None;
                shared.exited = None;
            }
            unexpected
        };
        if unexpected {
            let _ = std::fs::remove_file(runtime_file());
            let tail = log_tail(8).join("\n");
            set_status(ServerStatus::Failed {
                message: format!(
                    "SonarQube stopped on its own (exit code {}).{}",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
                    if tail.is_empty() { String::new() } else { format!("\n{tail}") }
                ),
            });
        }
    });

    set_status(ServerStatus::Starting { port, detail: None });
    let started = Instant::now();
    let mut exited = exited_rx;
    let version = loop {
        if *exited.borrow() {
            let tail = log_tail(12).join("\n");
            let message = format!("SonarQube didn't start.{}", if tail.is_empty() { String::new() } else { format!("\n{tail}") });
            set_status(ServerStatus::Failed { message: message.clone() });
            return Err(message);
        }
        if started.elapsed() > START_TIMEOUT {
            kill_tree(pid).await;
            let message = "SonarQube took more than five minutes to start, so it was stopped. Its logs are in the \
                           Reviewer's folder."
                .to_string();
            set_status(ServerStatus::Failed { message: message.clone() });
            return Err(message);
        }
        match system_status(port).await {
            Some((state, version)) if state == "UP" => break version,
            Some((state, _)) if state == "DB_MIGRATION_NEEDED" => {
                // A newer SonarQube on the data of an older one. The endpoint is open to anyone
                // while the database is in that state.
                set_status(ServerStatus::Starting { port, detail: Some("migrating".into()) });
                if let Ok(client) = SonarClient::new(&base_url(port), Auth::None, true) {
                    let _ = client.post("api/system/migrate_db", &[]).await;
                }
            }
            _ => {}
        }
        let _ = tokio::time::timeout(Duration::from_secs(1), exited.changed()).await;
    };

    set_status(ServerStatus::Starting { port, detail: Some("signing-in".into()) });
    finish_start(port, version, settings).await
}

/// The part of a start that happens once the server answers: the token, the rules, the watcher.
async fn finish_start(port: u16, version: String, settings: &Settings) -> Result<ServerStatus, String> {
    let config = &settings.config;
    let token = match credentials::ensure_token(&base_url(port)).await {
        Ok(token) => token,
        Err(message) => {
            set_status(ServerStatus::Failed { message: message.clone() });
            return Err(message);
        }
    };
    let client = SonarClient::new(&base_url(port), Auth::Bearer(token), true)?;
    set_status(ServerStatus::Starting { port, detail: Some("rules".into()) });
    if let Err(message) = super::rules::ensure_applied(&client, config, &settings.servers).await {
        // A rule set that couldn't be put in place is not a server that failed: the reviews still
        // run, on whatever profiles the server has. Said in the log the settings pane shows.
        push_log(format!("[CodeFlow] The rules couldn't be applied: {message}"));
    }
    let running = ServerStatus::Running { port, url: base_url(port), version };
    let generation = {
        let mut shared = shared();
        shared.generation += 1;
        shared.idle_minutes = config.idle_minutes;
        shared.last_used = Instant::now();
        shared.generation
    };
    set_status(running.clone());
    spawn_idle_watcher(generation);
    Ok(running)
}

fn read_runtime_file() -> Option<(u32, u16)> {
    let text = std::fs::read_to_string(runtime_file()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some((value.get("pid")?.as_u64()? as u32, value.get("port")?.as_u64()? as u16))
}

/// Stops the local server if it runs. Idempotent.
pub async fn stop() -> Result<(), String> {
    let _turn = LIFECYCLE.lock().await;
    stop_locked(STOP_GRACE).await;
    Ok(())
}

async fn stop_locked(grace: Duration) {
    let (pid, exited) = {
        let mut shared = shared();
        shared.stopping = true;
        (shared.pid.or_else(|| read_runtime_file().map(|(pid, _)| pid).filter(|pid| alive(*pid))), shared.exited.clone())
    };
    if let Some(pid) = pid {
        set_status(ServerStatus::Stopping);
        ask_to_stop(pid).await;
        if !wait_gone(pid, exited, grace).await {
            kill_tree(pid).await;
        }
        // The launcher is gone; a child that outlived it would be holding the data directory.
        kill_tree(pid).await;
    }
    {
        let mut shared = shared();
        shared.pid = None;
        shared.exited = None;
        shared.generation += 1;
    }
    let _ = std::fs::remove_file(runtime_file());
    set_status(ServerStatus::Stopped);
}

/// For the app's exit: stops the server within `budget`, blocking. See `shutdown::shutdown_cleanup`.
pub fn shutdown_blocking(budget: Duration) {
    let running = shared().pid.is_some();
    if !running {
        return;
    }
    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(budget + Duration::from_secs(2), async {
            let _turn = LIFECYCLE.lock().await;
            stop_locked(budget).await;
        })
        .await;
    });
}

fn spawn_idle_watcher(generation: u64) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let idle = {
                let shared = shared();
                if shared.generation != generation || !matches!(shared.status, ServerStatus::Running { .. }) {
                    return;
                }
                shared.idle_minutes > 0
                    && shared.busy == 0
                    && shared.last_used.elapsed() >= Duration::from_secs(u64::from(shared.idle_minutes) * 60)
            };
            if idle {
                push_log("[CodeFlow] Stopped after being idle.".to_string());
                let _ = stop().await;
                return;
            }
        }
    });
}

/// A client for the local server, signed in. Errors when it isn't running.
pub async fn client() -> Result<SonarClient, String> {
    signed_in().await.map(|(client, _)| client)
}

/// The same client, with the token it signs in with — the scanner needs the token itself.
pub async fn signed_in() -> Result<(SonarClient, String), String> {
    let ServerStatus::Running { port, .. } = status() else {
        return Err("The local SonarQube isn't running.".into());
    };
    let token = credentials::ensure_token(&base_url(port)).await?;
    touch();
    Ok((SonarClient::new(&base_url(port), Auth::Bearer(token.clone()), true)?, token))
}

/// The local server's sign-in: an admin password the app generates on the first start, and a token
/// minted with it that every later call uses.
pub mod credentials {
    use super::*;
    use rand::Rng;

    const ADMIN: &str = "admin";

    fn get(key: &str) -> Option<String> {
        store::get(key)
    }

    fn set(key: &str, value: &str) -> Result<(), String> {
        store::set(key, value)
    }

    /// Forgets both — for when the server's data is deleted, which takes the account with it.
    pub fn forget() {
        store::delete(&crate::secrets::sonar_local_admin_key());
        store::delete(&crate::secrets::sonar_local_token_key());
    }

    /// 32 characters from every class SonarQube's password policy asks for.
    fn generate_password() -> String {
        const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        let mut rng = rand::rng();
        let body: String = (0..28).map(|_| CHARSET[rng.random_range(0..CHARSET.len())] as char).collect();
        format!("Cf{body}-9x")
    }

    async fn valid(base: &str, auth: Auth) -> bool {
        let Ok(client) = SonarClient::new(base, auth, true) else { return false };
        matches!(client.get("api/authentication/validate", &[]).await, Ok(value) if value.get("valid").and_then(|v| v.as_bool()) == Some(true))
    }

    pub async fn ensure_token(base: &str) -> Result<String, String> {
        let token_key = crate::secrets::sonar_local_token_key();
        let admin_key = crate::secrets::sonar_local_admin_key();
        if let Some(token) = get(&token_key) {
            if valid(base, Auth::Bearer(token.clone())).await {
                return Ok(token);
            }
        }
        // The password the app set, or SonarQube's factory one on a server that never met us.
        let mut password = get(&admin_key);
        if let Some(stored) = password.clone() {
            if !valid(base, Auth::Basic { user: ADMIN.into(), password: stored }).await {
                password = None;
            }
        }
        let password = match password {
            Some(password) => password,
            None => {
                let factory = Auth::Basic { user: ADMIN.into(), password: ADMIN.into() };
                if !valid(base, factory.clone()).await {
                    return Err("The local SonarQube no longer accepts CodeFlow's sign-in. Delete its data in \
                                Settings › Reviewer to start it fresh."
                        .into());
                }
                let fresh = generate_password();
                let client = SonarClient::new(base, factory, true)?;
                client
                    .post(
                        "api/users/change_password",
                        &[("login", ADMIN.into()), ("previousPassword", ADMIN.into()), ("password", fresh.clone())],
                    )
                    .await
                    .map_err(|e| format!("Couldn't secure the local SonarQube's admin account: {e}"))?;
                set(&admin_key, &fresh)?;
                fresh
            }
        };
        let client = SonarClient::new(base, Auth::Basic { user: ADMIN.into(), password }, true)?;
        let name = format!("codeflow-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let created = client
            .post("api/user_tokens/generate", &[("name", name), ("type", "USER_TOKEN".into())])
            .await
            .map_err(|e| format!("Couldn't create a token on the local SonarQube: {e}"))?;
        let token = created
            .get("token")
            .and_then(|t| t.as_str())
            .ok_or("The local SonarQube created a token but didn't return it.")?
            .to_string();
        set(&token_key, &token)?;
        Ok(token)
    }

    /// The OS keychain, except in tests: a test binary is a new program to the macOS keychain, and
    /// every read would wait on a prompt nobody is there to answer.
    #[cfg(not(test))]
    mod store {
        pub fn get(key: &str) -> Option<String> {
            crate::secrets::get_secret(key).ok().flatten()
        }
        pub fn set(key: &str, value: &str) -> Result<(), String> {
            crate::secrets::set_secret(key, value)
        }
        pub fn delete(key: &str) {
            let _ = crate::secrets::delete_secret(key);
        }
    }

    #[cfg(test)]
    mod store {
        use std::collections::HashMap;
        use std::sync::{LazyLock, Mutex};

        static MAP: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

        pub fn get(key: &str) -> Option<String> {
            MAP.lock().unwrap().get(key).cloned()
        }
        pub fn set(key: &str, value: &str) -> Result<(), String> {
            MAP.lock().unwrap().insert(key.to_string(), value.to_string());
            Ok(())
        }
        pub fn delete(key: &str) {
            MAP.lock().unwrap().remove(key);
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn generated_passwords_meet_sonarqubes_policy() {
            for _ in 0..20 {
                let password = super::generate_password();
                assert!(password.len() >= 12);
                assert!(password.chars().any(|c| c.is_ascii_uppercase()));
                assert!(password.chars().any(|c| c.is_ascii_lowercase()));
                assert!(password.chars().any(|c| c.is_ascii_digit()));
                assert!(password.chars().any(|c| !c.is_ascii_alphanumeric()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_properties_bind_the_loopback_and_switch_the_watermark_off() {
        let text = properties(9123, Memory::Standard);
        assert!(text.contains("sonar.web.host=127.0.0.1\n"));
        assert!(text.contains("sonar.web.port=9123\n"));
        assert!(text.contains("sonar.search.port=0\n"));
        assert!(text.contains("sonar.telemetry.enable=false\n"));
        assert!(text.contains("-Dcluster.routing.allocation.disk.threshold_enabled=false"));
        // Forward slashes even on Windows: a backslash is an escape in a .properties file.
        assert!(!text.contains('\\'));
        assert!(properties(9000, Memory::Large).contains("sonar.ce.javaOpts=-Xmx2g"));
    }

    #[test]
    fn a_taken_port_is_skipped() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = listener.local_addr().unwrap().port();
        let chosen = free_port(taken);
        assert_ne!(chosen, taken);
    }
}
