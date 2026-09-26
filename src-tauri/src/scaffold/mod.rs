//! The project initializer's backend: what this machine can build, which versions exist, and the
//! terminal a new project is generated in.
//!
//! The catalogue itself — which templates exist, their options, the commands each one runs and how
//! to install what it needs — is TypeScript (`src/lib/scaffold/`). Everything here is a primitive it
//! composes, which keeps adding a template a frontend change:
//!
//! * [`tools`] — probes installed toolchains against a fresh login-shell `PATH`.
//! * [`versions`] — version lines from npm, PyPI, Packagist and endoflife.date.
//! * [`spring`] — start.spring.io's metadata and zip, the one template that is not a command.
//! * [`run`] — destination checks, boilerplate files, and the pty the commands run in.

pub mod run;
pub mod spring;
pub mod tools;
pub mod versions;

use std::path::PathBuf;
use tauri::{AppHandle, State};

use crate::terminal::TerminalRegistry;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub tools: Vec<tools::ToolStatus>,
    /// `macos`, `windows` or `linux` — which install recipes apply.
    pub platform: &'static str,
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// Probes `ids`. `refresh` re-reads the login shell's `PATH` first — after an install, or when the
/// user asks — instead of reusing the one from the last few minutes.
#[tauri::command]
pub async fn scaffold_detect_tools(ids: Vec<String>, refresh: bool) -> Result<Detection, String> {
    Ok(Detection { tools: tools::detect(ids, refresh).await, platform: platform() })
}

#[tauri::command]
pub async fn scaffold_versions(source: versions::VersionSource) -> Result<Vec<versions::VersionLine>, String> {
    versions::lines(source).await
}

#[tauri::command]
pub async fn scaffold_spring_metadata() -> Result<spring::SpringMeta, String> {
    spring::metadata().await
}

#[tauri::command]
pub async fn scaffold_spring_generate(
    request: spring::SpringRequest,
    parent: String,
    folder: String,
) -> Result<String, String> {
    let root = spring::generate(request, &PathBuf::from(parent), &folder).await?;
    Ok(root.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn scaffold_check_dest(parent: String, name: String) -> run::DestCheck {
    run::check_dest(&parent, &name)
}

#[tauri::command(async)]
pub fn scaffold_write_files(root: String, files: Vec<run::FileSpec>) -> Result<(), String> {
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err("The project root must be an absolute path".into());
    }
    run::write_files(&root, &files)
}

/// Starts `script` in a pty from `cwd`; answers with the terminal session id. `(async)` because it
/// may have to ask the login shell for a `PATH` first, which takes a second.
#[tauri::command(async)]
pub fn scaffold_run(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    cwd: String,
    script: String,
) -> Result<String, String> {
    run::run(app, registry, cwd, script)
}

/// Against this machine and the real registries — `cargo test --lib scaffold::live -- --ignored
/// --nocapture`. Ignored by default: they need the network and whatever happens to be installed.
#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore]
    async fn detects_this_machine() {
        let ids = ["node", "npm", "pnpm", "bun", "java", "go", "python", "uv", "php", "cargo", "git", "brew", "fnm", "nvm"];
        for tool in super::tools::detect(ids.iter().map(|s| s.to_string()).collect(), true).await {
            println!("{:8} found={} version={:?} path={:?} detail={:?}", tool.id, tool.found, tool.version, tool.path, tool.detail);
        }
    }

    #[tokio::test]
    #[ignore]
    async fn reads_every_kind_of_registry() {
        use super::versions::VersionSource::*;
        for source in [
            Npm { package: "@angular/cli".into() },
            Npm { package: "create-vite".into() },
            Pypi { package: "django".into() },
            Packagist { package: "laravel/laravel".into() },
            Runtime { product: "nodejs".into() },
            Runtime { product: "eclipse-temurin".into() },
        ] {
            let label = format!("{source:?}");
            match super::versions::lines(source).await {
                Ok(lines) => {
                    println!("{label}");
                    for line in lines {
                        println!("   {:6} {:14} {:7} eol={} requires={:?}", line.line, line.version, line.channel, line.eol, line.requires);
                    }
                }
                Err(e) => println!("{label}: ERROR {e}"),
            }
        }
        let meta = super::spring::metadata().await.expect("spring metadata");
        let parent = std::env::temp_dir().join(format!("cf-spring-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let request = super::spring::SpringRequest {
            project_type: "maven-project".into(),
            language: "java".into(),
            boot_version: meta.boot_default.clone(),
            java_version: "21".into(),
            packaging: "jar".into(),
            group_id: "com.example".into(),
            artifact_id: "demo-live".into(),
            name: "demo-live".into(),
            description: "demo-live".into(),
            package_name: "com.example.demolive".into(),
            dependencies: vec!["web".into(), "devtools".into()],
        };
        let root = super::spring::generate(request, &parent, "demo-live").await.expect("spring zip");
        let mvnw = std::fs::metadata(root.join("mvnw")).expect("wrapper");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(mvnw.permissions().mode() & 0o100, 0o100, "mvnw is executable");
        }
        assert!(root.join("pom.xml").is_file());
        println!("spring project at {}", root.display());
        let _ = std::fs::remove_dir_all(&parent);
        println!("spring boot={:?} java={:?} types={:?} groups={}", meta.boot_default, meta.java_versions.iter().map(|j| &j.id).collect::<Vec<_>>(), meta.types.iter().map(|t| &t.id).collect::<Vec<_>>(), meta.dependencies.len());
    }
}
