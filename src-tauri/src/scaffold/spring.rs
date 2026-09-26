//! Spring Boot projects, through [start.spring.io](https://start.spring.io) — the Spring Initializr.
//!
//! The one template that is not a command. Spring has no official generator CLI worth depending on
//! (the Boot CLI is a separate install that talks to this same service), and the service itself is
//! the source of truth for what a Boot project *is* this month: which Boot versions exist, which Java
//! versions each accepts, and which of ~200 starters work with which Boot line. So the form is built
//! from its metadata and the project is its zip, unpacked here.
//!
//! The generated project carries the Maven or Gradle **wrapper**, which is why the environment check
//! for Spring asks for a JDK and nothing else.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const BASE: &str = "https://start.spring.io";
const META_TTL: Duration = Duration::from_secs(60 * 60);

fn client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent("CodeFlow")
        .build()
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Which Boot versions it works with, in Initializr's range syntax (`[3.4.0,4.0.0-M1)`). Empty
    /// means every one. The form greys out a starter whose range excludes the chosen Boot.
    pub version_range: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyGroup {
    pub name: String,
    pub values: Vec<Dependency>,
}

/// What the form needs, already narrowed: the `*-build` types (a lone POM or build file) are left out,
/// because a project that cannot be opened is not a project.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringMeta {
    pub boot_versions: Vec<Choice>,
    pub boot_default: String,
    pub java_versions: Vec<Choice>,
    pub java_default: String,
    pub languages: Vec<Choice>,
    pub language_default: String,
    pub types: Vec<Choice>,
    pub type_default: String,
    pub packagings: Vec<Choice>,
    pub packaging_default: String,
    pub group_default: String,
    pub dependencies: Vec<DependencyGroup>,
}

static META: Mutex<Option<(Instant, SpringMeta)>> = Mutex::new(None);

fn choices(root: &serde_json::Value, key: &str) -> (Vec<Choice>, String) {
    let field = &root[key];
    let values = field["values"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(|v| {
                    Some(Choice {
                        id: v["id"].as_str()?.to_string(),
                        name: v["name"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (values, field["default"].as_str().unwrap_or_default().to_string())
}

fn parse_meta(root: &serde_json::Value) -> SpringMeta {
    let (boot_versions, boot_default) = choices(root, "bootVersion");
    let (java_versions, java_default) = choices(root, "javaVersion");
    let (languages, language_default) = choices(root, "language");
    let (types, type_default) = choices(root, "type");
    let (packagings, packaging_default) = choices(root, "packaging");
    let types: Vec<Choice> = types.into_iter().filter(|t| t.id.ends_with("-project")).collect();
    let dependencies = root["dependencies"]["values"]
        .as_array()
        .map(|groups| {
            groups
                .iter()
                .map(|group| DependencyGroup {
                    name: group["name"].as_str().unwrap_or_default().to_string(),
                    values: group["values"]
                        .as_array()
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(|v| {
                                    Some(Dependency {
                                        id: v["id"].as_str()?.to_string(),
                                        name: v["name"].as_str().unwrap_or_default().to_string(),
                                        description: v["description"].as_str().unwrap_or_default().to_string(),
                                        version_range: v["versionRange"].as_str().unwrap_or_default().to_string(),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    SpringMeta {
        boot_versions,
        boot_default,
        java_versions,
        java_default,
        languages,
        language_default,
        types,
        type_default,
        packagings,
        packaging_default,
        group_default: root["groupId"]["default"].as_str().unwrap_or("com.example").to_string(),
        dependencies,
    }
}

pub async fn metadata() -> Result<SpringMeta, String> {
    if let Ok(cache) = META.lock() {
        if let Some((at, meta)) = cache.as_ref() {
            if at.elapsed() < META_TTL {
                return Ok(meta.clone());
            }
        }
    }
    let response = client(Duration::from_secs(20))
        .get(BASE)
        .header("Accept", "application/vnd.initializr.v2.2+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("start.spring.io answered {}", response.status()));
    }
    let root: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    let meta = parse_meta(&root);
    if let Ok(mut cache) = META.lock() {
        *cache = Some((Instant::now(), meta.clone()));
    }
    Ok(meta)
}

/// The form, as sent. Every field is a plain value start.spring.io validates itself — it answers a
/// bad Boot version or an unknown starter with a 400 and a sentence, which is passed on as-is.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringRequest {
    #[serde(rename = "type")]
    pub project_type: String,
    pub language: String,
    pub boot_version: String,
    pub java_version: String,
    pub packaging: String,
    pub group_id: String,
    pub artifact_id: String,
    pub name: String,
    pub description: String,
    pub package_name: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

/// Downloads the project and unpacks it as `parent/folder`. Returns the project's root.
pub async fn generate(request: SpringRequest, parent: &Path, folder: &str) -> Result<PathBuf, String> {
    super::run::validate_folder_name(folder)?;
    let root = parent.join(folder);
    super::run::ensure_free(&root)?;

    let mut query: Vec<(&str, String)> = vec![
        ("type", request.project_type),
        ("language", request.language),
        ("bootVersion", request.boot_version),
        ("javaVersion", request.java_version),
        ("packaging", request.packaging),
        ("groupId", request.group_id),
        ("artifactId", request.artifact_id),
        ("name", request.name),
        ("description", request.description),
        ("packageName", request.package_name),
        // The zip's top-level folder, so nothing is unpacked loose into `parent`.
        ("baseDir", folder.to_string()),
    ];
    if !request.dependencies.is_empty() {
        query.push(("dependencies", request.dependencies.join(",")));
    }

    let response = client(Duration::from_secs(90))
        .get(format!("{BASE}/starter.zip"))
        .query(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        // Initializr explains itself in JSON (`{"message": "Invalid Spring Boot version …"}`).
        let message = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|body| body["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| format!("start.spring.io answered {status}"));
        return Err(message);
    }

    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let parent = parent.to_path_buf();
    let folder = folder.to_string();
    tokio::task::spawn_blocking(move || unpack(&bytes, &parent, &folder))
        .await
        .map_err(|e| e.to_string())??;
    Ok(root)
}

/// Unpacks `bytes` into `parent`, refusing anything that would land outside `parent/folder`.
///
/// `enclosed_name` already rejects absolute paths and `..` — the classic zip-slip — and the prefix
/// check on top of it holds the archive to the one folder it was asked for, so a service that
/// changed its layout could not scatter files across the user's projects directory.
fn unpack(bytes: &[u8], parent: &Path, folder: &str) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let expected = Path::new(folder);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!("Refusing an unsafe path in the archive: {}", entry.name()));
        };
        if !relative.starts_with(expected) {
            return Err(format!("Unexpected path in the archive: {}", relative.display()));
        }
        let target = parent.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut contents = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut contents).map_err(|e| e.to_string())?;
        std::fs::write(&target, &contents).map_err(|e| e.to_string())?;
        // `mvnw` and `gradlew` arrive executable in the archive, and a wrapper that is not is a
        // project whose first build fails with "permission denied".
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode & 0o777));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn archive(entries: &[(&str, &str, u32)]) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            for (name, body, mode) in entries {
                let options = zip::write::SimpleFileOptions::default().unix_permissions(*mode);
                writer.start_file(*name, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buffer.into_inner()
    }

    #[test]
    fn unpacks_into_the_named_folder_and_keeps_the_wrapper_executable() {
        let parent = std::env::temp_dir().join(format!("cf-spring-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        std::fs::create_dir_all(&parent).unwrap();
        let bytes = archive(&[("demo/pom.xml", "<project/>", 0o644), ("demo/mvnw", "#!/bin/sh", 0o755)]);
        unpack(&bytes, &parent, "demo").unwrap();
        assert_eq!(std::fs::read_to_string(parent.join("demo/pom.xml")).unwrap(), "<project/>");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(parent.join("demo/mvnw")).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn refuses_entries_outside_the_folder() {
        let parent = std::env::temp_dir().join(format!("cf-spring-out-{}", std::process::id()));
        std::fs::create_dir_all(&parent).unwrap();
        let bytes = archive(&[("other/evil.txt", "x", 0o644)]);
        assert!(unpack(&bytes, &parent, "demo").is_err());
        assert!(!parent.join("other").exists());
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn metadata_keeps_projects_and_drops_lone_build_files() {
        let root = serde_json::json!({
            "type": { "default": "gradle-project", "values": [
                { "id": "gradle-project", "name": "Gradle - Groovy" },
                { "id": "gradle-build", "name": "Gradle Config" },
                { "id": "maven-project", "name": "Maven" }
            ]},
            "bootVersion": { "default": "4.1.1", "values": [{ "id": "4.1.1", "name": "4.1.1" }] },
            "javaVersion": { "default": "17", "values": [{ "id": "21", "name": "21" }] },
            "language": { "default": "java", "values": [{ "id": "java", "name": "Java" }] },
            "packaging": { "default": "jar", "values": [{ "id": "jar", "name": "Jar" }] },
            "groupId": { "default": "com.example" },
            "dependencies": { "values": [{ "name": "Web", "values": [
                { "id": "web", "name": "Spring Web", "description": "Build web apps", "versionRange": "[3.5.0,4.2.0-M1)" }
            ]}]}
        });
        let meta = parse_meta(&root);
        assert_eq!(meta.types.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["gradle-project", "maven-project"]);
        assert_eq!(meta.dependencies[0].values[0].version_range, "[3.5.0,4.2.0-M1)");
        assert_eq!(meta.boot_default, "4.1.1");
    }
}
