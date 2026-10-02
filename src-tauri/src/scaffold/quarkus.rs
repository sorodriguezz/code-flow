//! Quarkus projects, through [code.quarkus.io](https://code.quarkus.io) — Spring's shape (see
//! [`super::spring`]): the service is the source of truth for which platform streams exist and which
//! Java each takes, and the project is its zip, unpacked here. The zip carries the Maven or Gradle
//! wrapper, so the only thing the environment check asks for is a JDK.
//!
//! What the service does that Spring's does not, found by using it (2026-10-01):
//!
//! * **It refuses a Java its stream does not list** — "This Java version is not compatible with this
//!   stream ([17, 21, 25]): 22" — and a project built for a newer release than the installed JDK does
//!   not compile ("release version 25 not supported"). So the Java sent is the newest the stream
//!   takes that the JDK on this machine can build, which is why it is decided here, next to the
//!   detection, rather than asked in the form.
//! * **It names the zip's folder after the artifact id**, which must match `^[a-z][a-z0-9-._]*$`, and
//!   takes no base directory: the artifact id is derived from the folder name and the archive is
//!   unpacked under the folder the user named.
//! * **It explains a refusal in plain text**, with a 400 — sometimes with a zip content type.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::versions::VersionLine;

const BASE: &str = "https://code.quarkus.io";
const STREAMS_TTL: Duration = Duration::from_secs(60 * 60);

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("CodeFlow")
        .build()
        .unwrap_or_default()
}

/// One platform stream, as `/api/streams` lists it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    /// `io.quarkus.platform:3.40` — what the download is asked for.
    pub key: String,
    pub platform_version: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub lts: bool,
    pub java_compatibility: JavaCompatibility,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JavaCompatibility {
    pub versions: Vec<u32>,
    pub recommended: u32,
}

impl Stream {
    /// `3.40`, from `io.quarkus.platform:3.40`.
    fn line(&self) -> &str {
        self.key.rsplit(':').next().unwrap_or(&self.key)
    }
}

static STREAMS: Mutex<Option<(Instant, Vec<Stream>)>> = Mutex::new(None);

async fn streams() -> Result<Vec<Stream>, String> {
    if let Ok(cache) = STREAMS.lock() {
        if let Some((at, streams)) = cache.as_ref() {
            if at.elapsed() < STREAMS_TTL {
                return Ok(streams.clone());
            }
        }
    }
    let response = client(Duration::from_secs(20))
        .get(format!("{BASE}/api/streams"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("code.quarkus.io answered {}", response.status()));
    }
    let streams: Vec<Stream> = response.json().await.map_err(|e| e.to_string())?;
    if let Ok(mut cache) = STREAMS.lock() {
        *cache = Some((Instant::now(), streams.clone()));
    }
    Ok(streams)
}

/// The streams as version lines: the recommended one is `latest`, the long-term ones `lts`, one
/// that is not final yet (`CR`, `Beta`) `next`. What each needs underneath is the oldest Java it takes.
fn stream_lines(streams: &[Stream]) -> Vec<VersionLine> {
    streams
        .iter()
        .map(|stream| VersionLine {
            version: stream.platform_version.clone(),
            line: stream.line().to_string(),
            channel: if stream.status != "FINAL" && !stream.status.is_empty() {
                "next".into()
            } else if stream.recommended {
                "latest".into()
            } else if stream.lts {
                "lts".into()
            } else {
                String::new()
            },
            requires: stream.java_compatibility.versions.iter().min().map(|min| format!(">={min}")),
            eol: false,
        })
        .collect()
}

pub async fn lines() -> Result<Vec<VersionLine>, String> {
    Ok(stream_lines(&streams().await?))
}

/// The newest Java `compatibility` takes that a JDK of major `installed` can compile for — or, with
/// no JDK found, the stream's own recommendation. A JDK older than every one it takes gets the
/// oldest: the environment panel has already said that this JDK is not enough.
fn java_for(compatibility: &JavaCompatibility, installed: Option<u32>) -> u32 {
    let Some(installed) = installed else { return compatibility.recommended };
    compatibility
        .versions
        .iter()
        .copied()
        .filter(|version| *version <= installed)
        .max()
        .or_else(|| compatibility.versions.iter().copied().min())
        .unwrap_or(compatibility.recommended)
}

/// A Maven artifact id code.quarkus.io takes (`^[a-z][a-z0-9-._]*$`) for a folder name: lowercased,
/// anything else turned into `-`, and given a leading letter when it starts with something else.
fn artifact_id(folder: &str) -> String {
    let mut id: String = folder
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_') { c } else { '-' })
        .collect();
    if !id.starts_with(|c: char| c.is_ascii_lowercase()) {
        id.insert_str(0, "app-");
    }
    id
}

/// The JDK's major version on this machine, as the environment panel found it.
async fn installed_java() -> Option<u32> {
    let found = super::tools::detect(vec!["java".into()], false).await;
    let version = found.into_iter().find(|tool| tool.found)?.version?;
    version.split('.').next()?.parse().ok()
}

/// The form, as sent: the stream's line (`3.40`), the group, the build tool code.quarkus.io names
/// (`MAVEN`, `GRADLE`, `GRADLE_KOTLIN_DSL`) and extension ids (`io.quarkus:quarkus-rest`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarkusRequest {
    pub stream: String,
    pub group_id: String,
    pub build_tool: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

/// Downloads the project and unpacks it as `parent/folder`. Returns the project's root.
pub async fn generate(request: QuarkusRequest, parent: &Path, folder: &str) -> Result<PathBuf, String> {
    super::run::validate_folder_name(folder)?;
    let root = parent.join(folder);
    super::run::ensure_free(&root)?;

    let streams = streams().await?;
    let stream = streams
        .iter()
        .find(|stream| stream.line() == request.stream || stream.key == request.stream)
        .or_else(|| streams.iter().find(|stream| stream.recommended))
        .ok_or_else(|| "code.quarkus.io listed no stream".to_string())?;
    let java = java_for(&stream.java_compatibility, installed_java().await);
    let artifact = artifact_id(folder);

    let mut query: Vec<(&str, String)> = vec![
        ("S", stream.key.clone()),
        ("g", request.group_id),
        ("a", artifact.clone()),
        ("b", request.build_tool),
        ("j", java.to_string()),
    ];
    // One `e` per extension: a comma-joined list is refused.
    query.extend(request.extensions.into_iter().map(|extension| ("e", extension)));

    let response = client(Duration::from_secs(90))
        .get(format!("{BASE}/api/download"))
        .query(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // "Bad request > This Java version is not compatible with this stream …", as plain text.
        let message = String::from_utf8_lossy(&bytes).trim().chars().take(400).collect::<String>();
        return Err(if message.is_empty() { format!("code.quarkus.io answered {status}") } else { message });
    }

    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent = parent.to_path_buf();
    let folder = folder.to_string();
    tokio::task::spawn_blocking(move || super::spring::unpack(&bytes, &parent, &artifact, &folder))
        .await
        .map_err(|e| e.to_string())??;
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Vec<Stream> {
        serde_json::from_value(json!([
            { "key": "io.quarkus.platform:3.40", "quarkusCoreVersion": "3.40.1", "platformVersion": "3.40.1", "recommended": true, "status": "FINAL", "lts": false, "javaCompatibility": { "versions": [17, 21, 25], "recommended": 25 } },
            { "key": "io.quarkus.platform:3.33", "quarkusCoreVersion": "3.33.4", "platformVersion": "3.33.4", "recommended": false, "status": "FINAL", "lts": true, "javaCompatibility": { "versions": [17, 21, 25], "recommended": 25 } },
            { "key": "io.quarkus.platform:3.41", "quarkusCoreVersion": "3.41.0.CR1", "platformVersion": "3.41.0.CR1", "recommended": false, "status": "CR", "lts": false, "javaCompatibility": { "versions": [21, 25], "recommended": 25 } }
        ]))
        .unwrap()
    }

    #[test]
    fn streams_become_lines_with_the_oldest_java_each_takes() {
        let lines = stream_lines(&sample());
        let summary: Vec<(&str, &str, &str, Option<&str>)> =
            lines.iter().map(|l| (l.line.as_str(), l.version.as_str(), l.channel.as_str(), l.requires.as_deref())).collect();
        assert_eq!(
            summary,
            [
                ("3.40", "3.40.1", "latest", Some(">=17")),
                ("3.33", "3.33.4", "lts", Some(">=17")),
                ("3.41", "3.41.0.CR1", "next", Some(">=21")),
            ]
        );
    }

    /// The case that made this a function: JDK 22 is in no stream's list, and 25 does not compile on it.
    #[test]
    fn sends_the_newest_java_the_installed_jdk_can_build() {
        let compatibility = JavaCompatibility { versions: vec![17, 21, 25], recommended: 25 };
        assert_eq!(java_for(&compatibility, Some(22)), 21);
        assert_eq!(java_for(&compatibility, Some(25)), 25);
        assert_eq!(java_for(&compatibility, Some(26)), 25);
        assert_eq!(java_for(&compatibility, None), 25);
        // Older than all of them: the oldest, and the environment panel has said so already.
        assert_eq!(java_for(&compatibility, Some(11)), 17);
    }

    #[test]
    fn artifact_ids_follow_what_the_service_accepts() {
        assert_eq!(artifact_id("quarkus-app"), "quarkus-app");
        assert_eq!(artifact_id("Orders API"), "orders-api");
        assert_eq!(artifact_id("2fa_service"), "app-2fa_service");
    }
}
