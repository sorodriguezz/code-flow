//! Getting the Reviewer's three pieces onto the disk, and saying whether they are there.
//!
//! - a **JDK** (Eclipse Temurin, the release in [`catalog::JAVA_RELEASE`]) from Adoptium's API,
//!   checked against the SHA-256 that API publishes;
//! - **SonarQube Community Build** and **SonarScanner CLI** from SonarSource's binaries host, each
//!   checked against the hash pinned in [`catalog`].
//!
//! Layout, under [`root`]:
//!
//! ```text
//! downloads/                 archives in flight (`.part`) and verified, before unpacking
//! jdk/<release>/ + jdk/current.json
//! sonarqube/<top dir>/ + sonarqube/installed.json
//! scanner/<top dir>/ + scanner/installed.json
//! server/{data,temp,logs}/   the local server's own state — kept when the binaries are replaced
//! scanner-home/              the scanner's cache (`sonar.userHome`), so it never writes to `~/.sonar`
//! work/<project key>/        each project's `sonar.working.directory`, so nothing lands in the repo
//! runs/<project key>/        each project's last result and history
//! ```
//!
//! A marker file is written last when a piece is installed, so its presence is the proof the
//! install finished — the same rule `datasource::drivers` follows for its runtime.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use super::catalog::{self, Artifact};
use super::download::{self, FetchError};

/// The event install progress is reported on.
pub const EVENT: &str = "reviewer:install";

pub fn root() -> PathBuf {
    crate::paths::reviewer_dir()
}

fn downloads_dir() -> PathBuf {
    root().join("downloads")
}

fn jdk_dir() -> PathBuf {
    root().join("jdk")
}

fn parent_of(artifact: &Artifact) -> PathBuf {
    root().join(artifact.id)
}

/// SonarQube's home: where `lib/`, `conf/` and `elasticsearch/` are.
pub fn sonar_home() -> PathBuf {
    parent_of(&catalog::SONARQUBE).join(catalog::SONARQUBE.top_dir)
}

pub fn scanner_home() -> PathBuf {
    parent_of(&catalog::SCANNER).join(catalog::SCANNER.top_dir)
}

/// The local server's data, temp and logs live here rather than inside its home, so replacing the
/// binaries with a newer version keeps every analysis.
pub fn server_dir() -> PathBuf {
    root().join("server")
}

pub fn scanner_user_home() -> PathBuf {
    root().join("scanner-home")
}

pub fn work_dir(project_key: &str) -> PathBuf {
    root().join("work").join(safe_segment(project_key))
}

pub fn runs_dir(project_key: &str) -> PathBuf {
    root().join("runs").join(safe_segment(project_key))
}

/// A project key as a single folder name: SonarQube allows `:` in keys, Windows does not in paths.
fn safe_segment(key: &str) -> String {
    key.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect()
}

/// The JDK's `java`, once one is installed.
pub fn java() -> Option<PathBuf> {
    let text = std::fs::read_to_string(jdk_dir().join("current.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let java = jdk_dir().join(value.get("java")?.as_str()?);
    java.is_file().then_some(java)
}

fn jdk_release() -> Option<String> {
    let text = std::fs::read_to_string(jdk_dir().join("current.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(value.get("release")?.as_str()?.to_string())
}

fn installed_version(artifact: &Artifact) -> Option<String> {
    let text = std::fs::read_to_string(parent_of(artifact).join("installed.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    Some(value.get("version")?.as_str()?.to_string())
}

pub fn sonar_installed() -> bool {
    installed_version(&catalog::SONARQUBE).as_deref() == Some(catalog::SONARQUBE.version)
        && sonar_home().join(catalog::sonar_application_jar()).is_file()
}

pub fn scanner_installed() -> bool {
    installed_version(&catalog::SCANNER).as_deref() == Some(catalog::SCANNER.version)
        && scanner_home().join(catalog::scanner_jar()).is_file()
}

/// One piece, as the settings pane lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub id: &'static str,
    pub installed: bool,
    /// What is installed, or what would be.
    pub version: String,
    /// What a download of it weighs — approximate for the JDK until Adoptium is asked.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatus {
    pub components: Vec<Component>,
    /// All three are there — the Reviewer can run.
    pub ready: bool,
    /// What is still to download, in bytes.
    pub pending_bytes: u64,
    pub root: String,
}

pub fn status() -> InstallStatus {
    let jdk = java().is_some();
    let components = vec![
        Component {
            id: "jdk",
            installed: jdk,
            version: jdk_release().unwrap_or_else(|| format!("JDK {}", catalog::JAVA_RELEASE)),
            size: catalog::JDK_APPROX_SIZE,
        },
        Component {
            id: catalog::SONARQUBE.id,
            installed: sonar_installed(),
            version: catalog::SONARQUBE.version.to_string(),
            size: catalog::SONARQUBE.size,
        },
        Component {
            id: catalog::SCANNER.id,
            installed: scanner_installed(),
            version: catalog::SCANNER.version.to_string(),
            size: catalog::SCANNER.size,
        },
    ];
    let pending_bytes = components.iter().filter(|c| !c.installed).map(|c| c.size).sum();
    InstallStatus {
        ready: components.iter().all(|c| c.installed),
        components,
        pending_bytes,
        root: root().display().to_string(),
    }
}

/// Where a piece's install is.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Downloading,
    /// The archive is being unpacked. SonarQube's is close to a gigabyte, so this takes a while and
    /// has to say so rather than sit at 100%.
    Extracting,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub item: String,
    pub phase: Phase,
    pub done: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn emit(app: Option<&AppHandle>, item: &str, phase: Phase, done: u64, total: u64, error: Option<String>) {
    if let Some(app) = app {
        let _ = app.emit(EVENT, Progress { item: item.to_string(), phase, done, total, error });
    }
}

/// One install at a time: two would write the same `.part`.
static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Downloads and unpacks whatever is missing, in order: the JDK, SonarQube, the scanner.
///
/// `app` is optional so a test can drive it without a window to report to.
pub async fn install(app: Option<&AppHandle>, cancel: CancellationToken) -> Result<InstallStatus, String> {
    let _one = INSTALLING.lock().await;
    if java().is_none() {
        install_jdk(app, &cancel).await?;
    }
    if !sonar_installed() {
        install_artifact(app, &catalog::SONARQUBE, &catalog::sonar_application_jar(), &cancel).await?;
    }
    if !scanner_installed() {
        install_artifact(app, &catalog::SCANNER, &catalog::scanner_jar(), &cancel).await?;
    }
    Ok(status())
}

fn interrupted(app: Option<&AppHandle>, item: &str, done: u64, total: u64, error: FetchError) -> String {
    match error {
        FetchError::Cancelled => {
            emit(app, item, Phase::Cancelled, done, total, None);
            "cancelled".to_string()
        }
        FetchError::Failed(message) => {
            emit(app, item, Phase::Failed, done, total, Some(message.clone()));
            message
        }
    }
}

async fn install_artifact(
    app: Option<&AppHandle>,
    artifact: &Artifact,
    marker_file: &str,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let item = artifact.id;
    let archive = downloads_dir().join(artifact.file);
    let mut last = (0u64, artifact.size);
    download::fetch(artifact.url, artifact.size, artifact.sha256, &archive, cancel, |done, total| {
        last = (done, total);
        emit(app, item, Phase::Downloading, done, total, None);
    })
    .await
    .map_err(|e| interrupted(app, item, last.0, last.1, e))?;

    emit(app, item, Phase::Extracting, artifact.size, artifact.size, None);
    let parent = parent_of(artifact);
    let unpacking = parent.join(".unpacking");
    let top_dir = artifact.top_dir.to_string();
    let marker = marker_file.to_string();
    let archive_path = archive.clone();
    let unpacked = unpacking.clone();
    let extracted = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let _ = std::fs::remove_dir_all(&unpacked);
        std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
        crate::datasource::drivers::extract(&archive_path, &unpacked)?;
        let home = unpacked.join(&top_dir);
        if !home.join(&marker).is_file() {
            return Err(format!("The archive doesn't contain {top_dir}/{marker}."));
        }
        Ok(home)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        emit(app, item, Phase::Failed, artifact.size, artifact.size, Some(e.clone()));
        format!("Couldn't unpack {}: {e}", artifact.file)
    })?;

    let target = parent.join(artifact.top_dir);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&extracted, &target).map_err(|e| format!("Couldn't install {}: {e}", artifact.file))?;
    let _ = std::fs::remove_dir_all(&unpacking);
    // Older versions this replaced; only folders, so the marker and an archive in flight stay.
    if let Ok(entries) = std::fs::read_dir(&parent) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path != target {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
    std::fs::write(
        parent.join("installed.json"),
        serde_json::json!({ "version": artifact.version }).to_string(),
    )
    .map_err(|e| format!("Couldn't record the install of {}: {e}", artifact.file))?;
    let _ = std::fs::remove_file(&archive);
    emit(app, item, Phase::Done, artifact.size, artifact.size, None);
    Ok(())
}

/// Temurin's JDK for this machine, the way `datasource::drivers` fetches its JRE — Adoptium's API
/// names the newest build of the release with its archive's SHA-256.
async fn install_jdk(app: Option<&AppHandle>, cancel: &CancellationToken) -> Result<(), String> {
    let item = "jdk";
    let java = catalog::JAVA_RELEASE;
    let (os, arch, extension) = crate::datasource::drivers::platform()?;
    let api = format!(
        "https://api.adoptium.net/v3/assets/latest/{java}/hotspot?architecture={arch}&image_type=jdk&os={os}&vendor=eclipse"
    );
    let assets: Value = download::client()?
        .get(&api)
        .send()
        .await
        .map_err(|e| interrupted(app, item, 0, 0, FetchError::Failed(format!("Couldn't reach Adoptium for the JDK: {e}"))))?
        .json()
        .await
        .map_err(|e| format!("Adoptium answered something that isn't the list of JDKs: {e}"))?;
    let asset = assets
        .as_array()
        .into_iter()
        .flatten()
        .find(|asset| asset["binary"]["package"]["name"].as_str().is_some_and(|name| name.ends_with(extension)))
        .ok_or_else(|| format!("Adoptium has no JDK {java} for {os}/{arch}."))?;
    let package = &asset["binary"]["package"];
    let link = package["link"].as_str().ok_or("Adoptium's answer has no download link")?;
    let name = package["name"].as_str().ok_or("Adoptium's answer has no file name")?;
    let checksum = package["checksum"].as_str().ok_or("Adoptium's answer has no checksum")?;
    let size = package["size"].as_u64().unwrap_or(0);
    let release = asset["release_name"].as_str().unwrap_or("jdk").to_string();

    let archive = downloads_dir().join(name);
    let mut last = (0u64, size);
    download::fetch(link, size, checksum, &archive, cancel, |done, total| {
        last = (done, total);
        emit(app, item, Phase::Downloading, done, total, None);
    })
    .await
    .map_err(|e| interrupted(app, item, last.0, last.1, e))?;

    emit(app, item, Phase::Extracting, size, size, None);
    let dir = jdk_dir();
    let unpacking = dir.join(format!("{release}.unpacking"));
    let target = dir.join(&release);
    let archive_path = archive.clone();
    let unpacked = unpacking.clone();
    let java_path = tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        let _ = std::fs::remove_dir_all(&unpacked);
        std::fs::create_dir_all(&unpacked).map_err(|e| e.to_string())?;
        crate::datasource::drivers::extract(&archive_path, &unpacked)?;
        crate::datasource::drivers::find_java(&unpacked, 0).ok_or_else(|| "The JDK's archive has no bin/java in it.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| {
        emit(app, item, Phase::Failed, size, size, Some(e.clone()));
        format!("Couldn't unpack the JDK: {e}")
    })?;
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&unpacking, &target).map_err(|e| format!("Couldn't install the JDK: {e}"))?;
    let relative = java_path.strip_prefix(&unpacking).map_err(|_| "the JDK's java is outside its folder".to_string())?;
    let java_relative = Path::new(&release).join(relative);
    std::fs::write(
        dir.join("current.json"),
        serde_json::json!({ "release": release, "java": java_relative.to_string_lossy().replace('\\', "/") }).to_string(),
    )
    .map_err(|e| format!("Couldn't record the JDK: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path != target {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
    emit(app, item, Phase::Done, size, size, None);
    Ok(())
}

/// Removes the downloaded pieces — and, with `with_data`, every analysis the local server holds.
/// The server must already be stopped.
pub fn uninstall(with_data: bool) -> Result<(), String> {
    let root = root();
    let targets: Vec<PathBuf> = if with_data {
        vec![root.clone()]
    } else {
        ["downloads", "jdk", catalog::SONARQUBE.id, catalog::SCANNER.id, "scanner-home", "work"]
            .iter()
            .map(|name| root.join(name))
            .collect()
    };
    for target in targets {
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("Couldn't delete {}: {e}", target.display()))?;
        }
    }
    Ok(())
}

/// How much the Reviewer takes on disk, everything included. Walked, because the server's data grows
/// with every analysis and there is no counter that could say it instead.
pub fn disk_used() -> u64 {
    fn walk(dir: &Path, depth: usize) -> u64 {
        if depth > 24 {
            return 0;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
        entries
            .flatten()
            .map(|entry| match entry.metadata() {
                Ok(meta) if meta.is_dir() => walk(&entry.path(), depth + 1),
                Ok(meta) => meta.len(),
                Err(_) => 0,
            })
            .sum()
    }
    walk(&root(), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_keys_become_one_safe_folder() {
        assert_eq!(safe_segment("codeflow:demo-1.2"), "codeflow_demo-1.2");
        assert_eq!(safe_segment("a/b\\c"), "a_b_c");
        assert!(work_dir("x:y").ends_with("work/x_y") || work_dir("x:y").ends_with("work\\x_y"));
    }
}
