//! Where JDBC drivers and the Java runtime live once downloaded, how they get there, and what the
//! user changed about each driver.
//!
//! # Nothing ships, everything is fetched once
//!
//! The installer used to carry a `jlink`-trimmed Java runtime and two driver jars — some fifty
//! megabytes every install paid for, whether or not it ever opened an Oracle or IRIS connection.
//! Now it carries only the bridge (`resources/jdbc/codeflow-jdbc-bridge.jar`, ours, a few kilobytes)
//! and fetches the rest the first time a connection needs it, the way DataGrip asks to download a
//! driver on Test Connection:
//!
//! - **The runtime** — Eclipse Temurin, the JRE the catalogue names (`runtime.java`), from Adoptium's
//!   own API, checked against the SHA-256 that API publishes. One for every driver.
//! - **The driver's files** — the jars its catalogue entry lists, from Maven Central (or the
//!   vendor's own download), each checked against the hash the catalogue pins.
//!
//! Both land under `<state>/drivers/` — app data, not the user's files: a reset may take them, and a
//! download brings them back exactly.
//!
//! # A file that exists is a file that was verified
//!
//! Bytes go to `<name>.part` and are renamed into place only once size and hash match, so "is this
//! driver downloaded?" is answered by looking at the disk — there is no "finished" flag to disagree
//! with it. The same rule `localai::download` follows for model weights, for the same reason.
//!
//! # What the user changes
//!
//! A driver's class, extra jars, URL templates, default properties and JVM options can be changed
//! in the Drivers panel, and a driver the catalogue doesn't have can be added there with the user's
//! own jars. Those live in `<state>/drivers/settings.json`, beside the files they are about.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use super::catalog::{self, DriverFile, SqlTraits, UrlTemplate};
use super::DbConnectionConfig;

/// The event downloads report progress on — one event, several phases (see [`Phase`]).
pub const EVENT: &str = "db:driver-download";

/// What an error starts with when the cure is downloading: the connection form reads it and offers
/// to, instead of showing the sentence. Followed by the driver id, a newline, and the sentence.
pub const MISSING: &str = "driver-files-missing:";

/// The same, for a driver whose files cannot be downloaded — a vendor that forbids redistribution —
/// and have to be added by hand. The form opens the driver's settings instead.
pub const MANUAL: &str = "driver-files-manual:";

/// How often progress is emitted while bytes move. See `localai::download::PROGRESS_INTERVAL`.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

pub fn root() -> PathBuf {
    crate::paths::state_dir().join("drivers")
}

fn files_dir() -> PathBuf {
    root().join("files")
}

fn runtime_dir() -> PathBuf {
    root().join("runtime")
}

fn settings_path() -> PathBuf {
    root().join("settings.json")
}

/// Where a catalogue file is kept: in a folder named for the start of its hash, so two artefacts
/// that happen to share a file name can never overwrite each other, while the name itself stays the
/// one the vendor gave it.
pub fn file_path(file: &DriverFile) -> PathBuf {
    let hash = file.sha256.as_deref().or(file.sha1.as_deref()).unwrap_or("unpinned");
    files_dir().join(&hash[..hash.len().min(12)]).join(&file.name)
}

// ---------------------------------------------------------------------------
// The user's changes
// ---------------------------------------------------------------------------

/// One driver as the user changed it, or one the user added. Every field empty means "as the
/// catalogue has it".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DriverSettings {
    /// The catalogue id it changes, or `custom-…` for a driver the user added.
    pub id: String,
    pub custom: bool,
    /// The name a custom driver goes by.
    pub name: String,
    /// The catalogue entry a custom driver borrows its SQL traits from — paging, quoting. Empty
    /// is the standard's.
    pub based_on: String,
    /// A driver class other than the catalogue's — or the only one, for a custom driver.
    pub class: String,
    /// Jars of the user's own, by absolute path: a newer build of the driver, an extension it needs,
    /// or the whole of a custom or vendor-only driver.
    pub files: Vec<String>,
    /// URL templates offered before the catalogue's.
    pub urls: Vec<UrlTemplate>,
    /// Properties every connection of this driver starts with, under its own.
    pub properties: Vec<(String, String)>,
    /// Arguments for the JVM that runs this driver (`-Xmx2g`, `-Duser.timezone=UTC`).
    pub vm_options: String,
    pub vm_env: Vec<(String, String)>,
    /// A Java home to run this driver on instead of the downloaded runtime.
    pub java_home: String,
}

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

pub fn all_settings() -> Vec<DriverSettings> {
    let _guard = SETTINGS_LOCK.lock();
    read_settings()
}

fn read_settings() -> Vec<DriverSettings> {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn settings_for(id: &str) -> DriverSettings {
    all_settings().into_iter().find(|entry| entry.id == id).unwrap_or_default()
}

/// Stores one driver's settings, replacing what was there. Settings that change nothing are
/// removed rather than kept as an empty row.
pub fn save_settings(mut settings: DriverSettings) -> Result<(), String> {
    if settings.id.trim().is_empty() {
        return Err("A driver's settings need the driver's id.".to_string());
    }
    if settings.custom && settings.class.trim().is_empty() {
        return Err("A driver needs the class that implements java.sql.Driver.".to_string());
    }
    settings.properties.retain(|(key, _)| !key.trim().is_empty());
    settings.vm_env.retain(|(key, _)| !key.trim().is_empty());
    settings.urls.retain(|url| !url.template.trim().is_empty());
    settings.files.retain(|file| !file.trim().is_empty());
    let _guard = SETTINGS_LOCK.lock();
    let mut all = read_settings();
    all.retain(|entry| entry.id != settings.id);
    let unchanged = DriverSettings { id: settings.id.clone(), ..Default::default() };
    if settings != unchanged {
        all.push(settings);
    }
    write_settings(&all)
}

pub fn delete_settings(id: &str) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock();
    let mut all = read_settings();
    all.retain(|entry| entry.id != id);
    write_settings(&all)
}

fn write_settings(all: &[DriverSettings]) -> Result<(), String> {
    std::fs::create_dir_all(root()).map_err(|e| format!("Couldn't create {}: {e}", root().display()))?;
    let text = serde_json::to_string_pretty(all).map_err(|e| e.to_string())?;
    // Through a temporary file, so a crash mid-write never leaves half a settings file behind.
    let temporary = settings_path().with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(|e| format!("Couldn't save the driver settings: {e}"))?;
    std::fs::rename(&temporary, settings_path()).map_err(|e| format!("Couldn't save the driver settings: {e}"))
}

// ---------------------------------------------------------------------------
// What a session needs
// ---------------------------------------------------------------------------

/// How the JVM that runs a driver is started — the part of a driver's settings the bridge is keyed
/// by, since two drivers with different JVM options cannot share a process.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct JvmOptions {
    /// The `java` binary: the user's Java home when set, the downloaded runtime otherwise.
    pub java: PathBuf,
    pub vm_options: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A driver with the user's changes applied and every file it needs found on disk — what a JDBC
/// session is opened with.
#[derive(Debug, Clone)]
pub struct ResolvedDriver {
    pub name: String,
    pub class: String,
    pub jars: Vec<PathBuf>,
    /// The user's templates first, then the catalogue's.
    pub urls: Vec<UrlTemplate>,
    /// The catalogue's property templates, then the user's defaults over them.
    pub properties: Vec<(String, String)>,
    pub sql: SqlTraits,
    pub default_port: u16,
    pub jvm: JvmOptions,
}

impl ResolvedDriver {
    /// The jars as the bridge's `open` takes them.
    pub fn jar_paths(&self) -> Vec<String> {
        self.jars.iter().map(|jar| jar.to_string_lossy().into_owned()).collect()
    }
}

/// Resolves a JVM driver for a session — or says what is missing, prefixed with [`MISSING`] or
/// [`MANUAL`] so the form can offer the cure rather than repeat the sentence.
pub fn resolve(driver_id: &str) -> Result<ResolvedDriver, String> {
    let settings = settings_for(driver_id);
    let def = catalog::driver(driver_id);
    if def.is_none() && !settings.custom {
        return Err(format!("`{driver_id}` is not a driver this build knows. Pick another one in the connection's settings."));
    }
    let name = def.map(|d| d.name.clone()).unwrap_or_else(|| settings.name.clone());

    let mut jars = Vec::new();
    let mut missing = false;
    for file in def.map(|d| d.files.as_slice()).unwrap_or_default() {
        let path = file_path(file);
        if path.is_file() {
            jars.push(path);
        } else {
            missing = true;
        }
    }
    for file in &settings.files {
        let path = PathBuf::from(file);
        if !path.is_file() {
            return Err(format!("The driver file {file}, added to {name} by hand, no longer exists. Remove it from the driver's files, or put it back."));
        }
        jars.push(path);
    }

    let manual = def.and_then(|d| d.manual.clone());
    if jars.is_empty() && !missing {
        let page = manual.map(|url| format!(" Get them from {url}, then add them")).unwrap_or_else(|| " Add them".to_string());
        return Err(format!("{MANUAL}{driver_id}\n{name}'s driver files can't be downloaded by CodeFlow.{page} in the driver's settings (Data sources › Drivers)."));
    }

    let java = if settings.java_home.trim().is_empty() {
        runtime_java()
    } else {
        let candidate = Path::new(settings.java_home.trim()).join("bin").join(java_exe());
        if !candidate.is_file() {
            return Err(format!("{name} is set to run on the Java in {}, and there is no {} there.", settings.java_home.trim(), java_exe()));
        }
        Some(candidate)
    };
    if missing || java.is_none() {
        let what = match (missing, java.is_none()) {
            (true, true) => "its driver files and the Java runtime they run on",
            (true, false) => "its driver files",
            _ => "the Java runtime its driver runs on",
        };
        return Err(format!("{MISSING}{driver_id}\n{name} needs {what}, which haven't been downloaded yet."));
    }

    let class = if settings.class.trim().is_empty() {
        def.and_then(|d| d.class.clone()).unwrap_or_default()
    } else {
        settings.class.trim().to_string()
    };
    let mut urls = settings.urls.clone();
    urls.extend(def.map(|d| d.urls.clone()).unwrap_or_default());
    let mut properties: Vec<(String, String)> =
        def.map(|d| d.properties.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    for (key, value) in &settings.properties {
        properties.retain(|(known, _)| !known.eq_ignore_ascii_case(key));
        properties.push((key.clone(), value.clone()));
    }
    let sql = def
        .and_then(|d| d.sql.clone())
        .or_else(|| catalog::driver(&settings.based_on).and_then(|d| d.sql.clone()))
        .unwrap_or_default();

    Ok(ResolvedDriver {
        name,
        class,
        jars,
        urls,
        properties,
        sql,
        default_port: def.map(|d| d.default_port).unwrap_or_default(),
        jvm: JvmOptions {
            java: java.unwrap_or_default(),
            vm_options: split_arguments(&settings.vm_options),
            env: settings.vm_env.clone(),
        },
    })
}

/// JVM options as a shell would split them: on whitespace, except inside double quotes — so
/// `-Dpath="C:\Program Files\x"` stays one argument.
fn split_arguments(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in text.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

fn java_exe() -> &'static str {
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatus {
    pub name: String,
    pub version: String,
    pub size: u64,
    pub present: bool,
    /// Added by the user rather than listed by the catalogue.
    pub user: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub id: String,
    pub files: Vec<FileStatus>,
    /// Every file it needs is on disk. Says nothing about the runtime, which is reported once for
    /// all drivers — see [`RuntimeStatus`].
    pub ready: bool,
    /// What a download would still fetch, runtime excluded.
    pub download_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub ready: bool,
    /// Adoptium's release name (`jdk-21.0.12.1+1`), when downloaded.
    pub release: Option<String>,
    /// The Java feature release the catalogue asks for.
    pub java: u32,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriversOverview {
    pub runtime: RuntimeStatus,
    pub drivers: Vec<DriverStatus>,
    /// The folder all of it lives in, for "show in folder".
    pub root: String,
}

pub fn status(driver_id: &str) -> DriverStatus {
    let settings = settings_for(driver_id);
    let mut files: Vec<FileStatus> = catalog::driver(driver_id)
        .map(|d| d.files.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|file| {
            let path = file_path(file);
            FileStatus {
                name: file.name.clone(),
                version: file.version(),
                size: file.size,
                present: path.is_file(),
                user: false,
                path: path.display().to_string(),
            }
        })
        .collect();
    for file in &settings.files {
        let path = PathBuf::from(file);
        files.push(FileStatus {
            name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone()),
            version: String::new(),
            size: std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            present: path.is_file(),
            user: true,
            path: file.clone(),
        });
    }
    let ready = !files.is_empty() && files.iter().all(|file| file.present);
    let download_bytes = files.iter().filter(|file| !file.present && !file.user).map(|file| file.size).sum();
    DriverStatus { id: driver_id.to_string(), files, ready, download_bytes }
}

pub fn overview() -> DriversOverview {
    let mut ids: Vec<String> = catalog::drivers()
        .iter()
        .filter(|driver| matches!(driver.engine.as_str(), "jdbc" | "oracle" | "iris"))
        .map(|driver| driver.id.clone())
        .collect();
    ids.extend(all_settings().into_iter().filter(|entry| entry.custom).map(|entry| entry.id));
    let current = current_runtime();
    DriversOverview {
        runtime: RuntimeStatus {
            ready: current.is_some(),
            release: current.as_ref().map(|(release, _)| release.clone()),
            java: catalog::java_release(),
            path: current.map(|(_, java)| java.display().to_string()),
        },
        drivers: ids.iter().map(|id| status(id)).collect(),
        root: root().display().to_string(),
    }
}

/// The downloaded runtime's `java`, when there is one.
pub fn runtime_java() -> Option<PathBuf> {
    current_runtime().map(|(_, java)| java)
}

/// `runtime/current.json`: which release is in use and where its `java` is. Written last when a
/// runtime is installed, so its presence is the proof the install finished.
fn current_runtime() -> Option<(String, PathBuf)> {
    let text = std::fs::read_to_string(runtime_dir().join("current.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let release = value.get("release")?.as_str()?.to_string();
    let java = runtime_dir().join(value.get("java")?.as_str()?);
    java.is_file().then_some((release, java))
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

/// Where a download is. The connection form drives a progress bar off these, one row per item.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Downloading,
    /// The whole file is here and its hash is being checked.
    Verifying,
    /// The runtime's archive is being unpacked.
    Extracting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub driver_id: String,
    /// The file — or `Java <n> runtime` — this is about.
    pub item: String,
    pub phase: Phase,
    pub done: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// One download at a time. Two connections asking for the same jar at once would otherwise both
/// write its `.part`, and nothing about a driver download is urgent enough to be worth the race.
static DOWNLOADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Downloads whatever a driver still lacks — the runtime first, then its files — and answers with
/// its status afterwards.
pub async fn download(app: &AppHandle, driver_id: &str) -> Result<DriverStatus, String> {
    let _one_at_a_time = DOWNLOADING.lock().await;
    let settings = settings_for(driver_id);
    let def = catalog::driver(driver_id);
    if def.is_none() && !settings.custom {
        return Err(format!("`{driver_id}` is not a driver this build knows."));
    }
    if settings.java_home.trim().is_empty() && current_runtime().is_none() {
        download_runtime(app, driver_id).await?;
    }
    for file in def.map(|d| d.files.as_slice()).unwrap_or_default() {
        let path = file_path(file);
        if !path.is_file() {
            fetch_file(app, driver_id, file, &path).await?;
        }
    }
    Ok(status(driver_id))
}

/// Deletes a driver's downloaded files — except the ones another driver of the catalogue also
/// lists (jTDS serves three entries, Hive's jar two), which would otherwise vanish from under it.
pub fn delete_files(driver_id: &str) -> Result<DriverStatus, String> {
    let Some(def) = catalog::driver(driver_id) else { return Ok(status(driver_id)) };
    for file in &def.files {
        let shared = catalog::drivers()
            .iter()
            .any(|other| other.id != def.id && other.files.iter().any(|f| file_path(f) == file_path(file)));
        if shared {
            continue;
        }
        let path = file_path(file);
        if path.is_file() {
            std::fs::remove_file(&path).map_err(|e| format!("Couldn't delete {}: {e}", path.display()))?;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(status(driver_id))
}

/// Deletes the downloaded runtime. The next JDBC connection asks to download it again.
pub fn delete_runtime() -> Result<(), String> {
    let dir = runtime_dir();
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("Couldn't delete {}: {e}", dir.display()))?;
    }
    Ok(())
}

fn emit(app: &AppHandle, driver_id: &str, item: &str, phase: Phase, done: u64, total: u64, error: Option<String>) {
    let _ = app.emit(
        EVENT,
        Progress { driver_id: driver_id.to_string(), item: item.to_string(), phase, done, total, error },
    );
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // A read timeout, not a total one: a large jar on a slow line is slow, not dead.
        .read_timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(concat!("CodeFlow/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Couldn't create the HTTP client: {e}"))
}

/// The hash a download is checked against.
enum Expected<'a> {
    Sha1(&'a str),
    Sha256(&'a str),
}

async fn fetch_file(app: &AppHandle, driver_id: &str, file: &DriverFile, path: &Path) -> Result<(), String> {
    let url = file.source_url()?;
    let expected = match (&file.sha256, &file.sha1) {
        (Some(sha256), _) => Expected::Sha256(sha256),
        (None, Some(sha1)) => Expected::Sha1(sha1),
        (None, None) => return Err(format!("{} is not pinned by a hash, so CodeFlow won't run it.", file.name)),
    };
    fetch(app, driver_id, &file.name, &url, file.size, expected, path).await
}

/// Streams `url` into `path`, through `<path>.part`, and keeps it only when its size and hash are
/// the expected ones.
async fn fetch(
    app: &AppHandle,
    driver_id: &str,
    item: &str,
    url: &str,
    size: u64,
    expected: Expected<'_>,
    path: &Path,
) -> Result<(), String> {
    let fail = |done: u64, message: String| {
        emit(app, driver_id, item, Phase::Failed, done, size, Some(message.clone()));
        message
    };
    let parent = path.parent().ok_or("a download needs a folder to land in")?;
    std::fs::create_dir_all(parent).map_err(|e| fail(0, format!("Couldn't create {}: {e}", parent.display())))?;
    let part = path.with_extension(format!(
        "{}.part",
        path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()
    ));

    emit(app, driver_id, item, Phase::Downloading, 0, size, None);
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| fail(0, format!("Couldn't download {item}: {e}")))?;
    if !response.status().is_success() {
        return Err(fail(0, format!("Downloading {item} failed: the server answered {} for {url}.", response.status())));
    }
    let total = response.content_length().filter(|&n| n > 0).unwrap_or(size);

    let mut out = tokio::fs::File::create(&part)
        .await
        .map_err(|e| fail(0, format!("Couldn't write {}: {e}", part.display())))?;
    let mut sha1 = Sha1::new();
    let mut sha256 = Sha256::new();
    let mut done: u64 = 0;
    let mut last = Instant::now();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| fail(done, format!("The download of {item} was interrupted: {e}")))?;
        match expected {
            Expected::Sha1(_) => sha1.update(&chunk),
            Expected::Sha256(_) => sha256.update(&chunk),
        }
        out.write_all(&chunk)
            .await
            .map_err(|e| fail(done, format!("Couldn't write {}: {e}", part.display())))?;
        done += chunk.len() as u64;
        if last.elapsed() >= PROGRESS_INTERVAL {
            last = Instant::now();
            emit(app, driver_id, item, Phase::Downloading, done, total, None);
        }
    }
    out.flush().await.map_err(|e| fail(done, e.to_string()))?;
    drop(out);

    emit(app, driver_id, item, Phase::Verifying, done, total, None);
    if size > 0 && done != size {
        let _ = std::fs::remove_file(&part);
        return Err(fail(done, format!("{item} arrived with {done} bytes instead of {size}, so it was discarded. Try again.")));
    }
    let (digest, wanted) = match expected {
        Expected::Sha1(wanted) => (hex::encode(sha1.finalize()), wanted),
        Expected::Sha256(wanted) => (hex::encode(sha256.finalize()), wanted),
    };
    if !digest.eq_ignore_ascii_case(wanted) {
        let _ = std::fs::remove_file(&part);
        return Err(fail(
            done,
            format!(
                "{item} didn't match the checksum CodeFlow expects, so it was discarded rather than run. \
                 This is usually a proxy or a captive portal rewriting the download."
            ),
        ));
    }
    std::fs::rename(&part, path).map_err(|e| fail(done, format!("Couldn't finish writing {item}: {e}")))?;
    emit(app, driver_id, item, Phase::Done, done, total, None);
    Ok(())
}

/// Adoptium's names for this machine, and the archive its JRE comes in.
pub(crate) fn platform() -> Result<(&'static str, &'static str, &'static str), String> {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("There is no Java runtime CodeFlow can download for this operating system.".to_string());
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err("There is no Java runtime CodeFlow can download for this processor.".to_string());
    };
    let archive = if os == "windows" { ".zip" } else { ".tar.gz" };
    Ok((os, arch, archive))
}

/// Downloads Eclipse Temurin's JRE for this machine and installs it under `runtime/`.
///
/// Adoptium's API names the latest build of the release the catalogue asks for, with its archive's
/// SHA-256 — so the version moves with Adoptium's security updates while every byte is still checked
/// against what Adoptium itself published.
async fn download_runtime(app: &AppHandle, driver_id: &str) -> Result<(), String> {
    let java = catalog::java_release();
    let item = format!("Java {java} runtime");
    let (os, arch, extension) = platform()?;
    let api = format!(
        "https://api.adoptium.net/v3/assets/latest/{java}/hotspot?architecture={arch}&image_type=jre&os={os}&vendor=eclipse"
    );
    let assets: Value = client()?
        .get(&api)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Adoptium for the Java runtime: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Adoptium answered something that isn't the list of Java runtimes: {e}"))?;
    let asset = assets
        .as_array()
        .into_iter()
        .flatten()
        .find(|asset| {
            asset["binary"]["package"]["name"].as_str().is_some_and(|name| name.ends_with(extension))
        })
        .ok_or_else(|| format!("Adoptium has no Java {java} runtime for {os}/{arch}."))?;
    let package = &asset["binary"]["package"];
    let link = package["link"].as_str().ok_or("Adoptium's answer has no download link")?;
    let checksum = package["checksum"].as_str().ok_or("Adoptium's answer has no checksum")?;
    let size = package["size"].as_u64().unwrap_or(0);
    let release = asset["release_name"].as_str().unwrap_or("jre").to_string();

    let dir = runtime_dir();
    let archive = dir.join(format!("{release}{extension}"));
    fetch(app, driver_id, &item, link, size, Expected::Sha256(checksum), &archive).await?;

    emit(app, driver_id, &item, Phase::Extracting, size, size, None);
    let target = dir.join(&release);
    let unpacking = dir.join(format!("{release}.unpacking"));
    let archive_path = archive.clone();
    let unpacked = unpacking.clone();
    let java_path = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let _ = std::fs::remove_dir_all(&unpacked);
        std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
        extract(&archive_path, &unpacked)?;
        find_java(&unpacked, 0).ok_or_else(|| "The runtime's archive has no bin/java in it.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        emit(app, driver_id, &item, Phase::Failed, size, size, Some(e.clone()));
        format!("Couldn't unpack the Java runtime: {e}")
    })?;

    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&unpacking, &target).map_err(|e| format!("Couldn't install the Java runtime: {e}"))?;
    let relative = java_path
        .strip_prefix(&unpacking)
        .map_err(|_| "the runtime's java is outside its folder".to_string())?;
    let java_relative = Path::new(&release).join(relative);
    std::fs::write(
        dir.join("current.json"),
        serde_json::json!({ "release": release, "java": java_relative.to_string_lossy().replace('\\', "/") }).to_string(),
    )
    .map_err(|e| format!("Couldn't record the Java runtime: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    // Older runtimes this replaced. Only folders: `current.json` and a download in flight stay.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path != target {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
    emit(app, driver_id, &item, Phase::Done, size, size, None);
    Ok(())
}

pub(crate) fn extract(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if archive.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip")) {
        // `extract` resolves every entry through its enclosed name, so a path that climbs out of
        // the folder is refused rather than written.
        zip::ZipArchive::new(file).map_err(|e| e.to_string())?.extract(into).map_err(|e| e.to_string())
    } else {
        // `unpack` refuses `..` the same way, and keeps the permission bits — which is what leaves
        // `bin/java` executable on macOS.
        tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(into).map_err(|e| e.to_string())
    }
}

/// `bin/java` somewhere under `dir`: the archive's top folder, and on macOS its `Contents/Home`.
pub(crate) fn find_java(dir: &Path, depth: usize) -> Option<PathBuf> {
    let candidate = dir.join("bin").join(java_exe());
    if candidate.is_file() {
        return Some(candidate);
    }
    if depth >= 4 {
        return None;
    }
    let mut children: Vec<PathBuf> =
        std::fs::read_dir(dir).ok()?.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    children.sort();
    children.into_iter().find_map(|child| find_java(&child, depth + 1))
}

/// The driver's own properties — the catalogue's and the defaults set in the Drivers list — rendered
/// with a connection's standard fields, for the sessions that build the rest of their properties
/// themselves (Oracle's, IRIS's). The connection's own options go over these.
pub fn default_properties(driver: &ResolvedDriver, config: &DbConnectionConfig) -> Map<String, Value> {
    let value = |name: &str| match name {
        "host" => config.host.trim().to_string(),
        "port" => config.effective_port().to_string(),
        "database" | "file" => config.database.trim().to_string(),
        "user" => config.user.clone(),
        "password" => config.password.clone(),
        other => config
            .url_values
            .iter()
            .find(|(key, _)| key == other)
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default(),
    };
    connection_properties(driver, &[], &value).into_iter().map(|(key, value)| (key, Value::from(value))).collect()
}

/// The properties a session sends: the driver's, rendered with the connection's values, then the
/// connection's own over them. A rendered value that comes out empty is left out — `AccessKey` with
/// no key typed means "use the default credentials", not "use the empty one".
pub fn connection_properties(
    driver: &ResolvedDriver,
    own: &[(String, String)],
    value: &dyn Fn(&str) -> String,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (key, template) in &driver.properties {
        let rendered = catalog::render_template(template, value);
        if !rendered.is_empty() {
            out.insert(key.clone(), rendered);
        }
    }
    for (key, value) in own {
        if key.trim().is_empty() {
            continue;
        }
        out.retain(|known: &String, _| !known.eq_ignore_ascii_case(key));
        out.insert(key.trim().to_string(), value.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_options_split_like_a_shell_would() {
        assert_eq!(
            split_arguments(r#"-Xmx2g  -Dpath="C:\Program Files\x" -Da=b"#),
            vec!["-Xmx2g", r"-Dpath=C:\Program Files\x", "-Da=b"]
        );
        assert!(split_arguments("   ").is_empty());
    }

    #[test]
    fn a_file_is_kept_under_its_hash_and_its_own_name() {
        let file = DriverFile {
            maven: Some("net.sourceforge.jtds:jtds:1.3.1".into()),
            repo: None,
            url: None,
            name: "jtds-1.3.1.jar".into(),
            size: 1,
            sha1: Some("1527f2fc2f040898625370a1687d902aa0743bcc".into()),
            sha256: None,
        };
        let path = file_path(&file);
        assert!(path.ends_with(Path::new("1527f2fc2f04").join("jtds-1.3.1.jar")), "{}", path.display());
    }

    #[test]
    fn properties_render_and_the_connections_own_win() {
        let driver = ResolvedDriver {
            name: "X".into(),
            class: "X".into(),
            jars: vec![],
            urls: vec![],
            properties: vec![
                ("AccessKey".into(), "{user}".into()),
                ("SecretKey".into(), "{password}".into()),
                ("Region".into(), "{region::us-east-1}".into()),
            ],
            sql: SqlTraits::default(),
            default_port: 0,
            jvm: JvmOptions::default(),
        };
        let values = |name: &str| match name {
            "user" => "AKIA".to_string(),
            _ => String::new(),
        };
        let props = connection_properties(&driver, &[("region".into(), "eu-west-1".into())], &values);
        assert_eq!(props.get("AccessKey").map(String::as_str), Some("AKIA"));
        // Rendered empty: left out, so the driver falls back to its own default credentials.
        assert!(!props.contains_key("SecretKey"));
        // The connection's own property replaced the driver's, whatever its case.
        assert!(!props.contains_key("Region"));
        assert_eq!(props.get("region").map(String::as_str), Some("eu-west-1"));
    }

    #[test]
    fn a_runtime_archive_is_searched_for_its_java() {
        let dir = std::env::temp_dir().join(format!("cf-find-java-{}", std::process::id()));
        let bin = dir.join("jdk-21-jre").join("Contents").join("Home").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join(java_exe()), b"").unwrap();
        assert_eq!(find_java(&dir, 0), Some(bin.join(java_exe())));
        std::fs::remove_dir_all(&dir).ok();
    }
}
