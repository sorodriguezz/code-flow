//! A container's logs and a shell inside it, as terminal sessions — and the commands worth watching
//! while they work (a pull, a build, a Compose project's `up`, `down`, `restart` or `pull`), which run
//! to their end in the pane and exit with it.
//!
//! The same move the Remote workspace makes with `ssh`: the engine's own `logs -f` or `exec -it`
//! runs in a pty registered with the terminal registry, so the xterm pane, resize, copy and close
//! all work unchanged and the panel needs no second kind of console.

use serde::Deserialize;
use tauri::AppHandle;

use super::{engine, kube};
use crate::terminal::{self, TerminalRegistry};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    /// `logs`, `exec`, `projectLogs`, `pull`, `build`, `composeUp`, `composeDown`, `composeRestart`
    /// or `composePull`.
    pub kind: String,
    /// `docker`, `podman`, `nerdctl` or `kubernetes`.
    pub runtime: String,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
    /// A container id or name; a pod name for Kubernetes (or `deployment/name` for its logs). The
    /// image for `pull`; the project's name for the Compose kinds (empty: the project is its files).
    pub target: String,
    /// A pod's container.
    #[serde(default)]
    pub container: Option<String>,
    #[serde(default)]
    pub tail: Option<u32>,
    #[serde(default)]
    pub timestamps: bool,
    #[serde(default)]
    pub previous: bool,
    /// The shell to start inside (`/bin/bash`); empty finds one.
    #[serde(default)]
    pub shell: Option<String>,
    /// A Compose project's folder and files, for `projectLogs` (the target is the project's name).
    #[serde(default)]
    pub project_dir: Option<String>,
    #[serde(default)]
    pub config_files: Option<String>,
    /// `build`: the folder to build, its Dockerfile (relative to it, or absolute) and the tag to give
    /// the image. `pull` reads its image from `target`.
    #[serde(default)]
    pub build_context: Option<String>,
    #[serde(default)]
    pub dockerfile: Option<String>,
    #[serde(default)]
    pub tag: Option<String>,
}

/// bash where the image has it, sh otherwise — the probe a person would type.
const FIND_SHELL: &str = "if command -v bash >/dev/null 2>&1; then exec bash; elif command -v ash >/dev/null 2>&1; then exec ash; else exec sh; fi";

fn check_target(target: &str) -> Result<(), String> {
    if target.trim().is_empty() || target.starts_with('-') || target.contains(char::is_whitespace) {
        Err(format!("\"{target}\" is not a container"))
    } else {
        Ok(())
    }
}

/// The Compose command a `compose*` session runs.
fn compose_action(kind: &str) -> Option<&'static str> {
    match kind {
        "composeUp" => Some("up"),
        "composeDown" => Some("down"),
        "composeRestart" => Some("restart"),
        "composePull" => Some("pull"),
        _ => None,
    }
}

/// An image name to tag a build with — `[registry[:port]/]name[:tag]`, the name lowercase as the
/// engines insist — so a typo is said here and not after the whole build has run.
fn check_tag(tag: &str) -> Result<(), String> {
    engine::check_ref(tag)?;
    let refused = || Err(format!("\"{tag}\" is not an image name: a lowercase name and a tag, as in my-app:dev"));
    let (name, version) = match tag.rsplit_once(':') {
        Some((name, version)) if !version.contains('/') => (name, Some(version)),
        _ => (tag, None),
    };
    let mut parts: Vec<&str> = name.split('/').collect();
    // A registry comes first when it looks like a host: `localhost`, a dot, or a port.
    if parts.len() > 1 && (parts[0] == "localhost" || parts[0].contains(['.', ':'])) {
        let (host, port) = parts[0].split_once(':').unwrap_or((parts[0], ""));
        let host_ok = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'));
        let port_ok = port.is_empty() || (port.len() <= 5 && port.chars().all(|c| c.is_ascii_digit()));
        if !host_ok || !port_ok {
            return refused();
        }
        parts.remove(0);
    }
    let component = |part: &&str| {
        let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
        edge(part.chars().next()) && edge(part.chars().last()) && part.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    };
    let version_ok = version.is_none_or(|v| v.len() <= 128 && v.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')));
    if parts.is_empty() || !parts.iter().all(component) || !version_ok {
        return refused();
    }
    Ok(())
}

/// `build [-t tag] [-f dockerfile] <context>`. The engine reads `-f` from its working directory,
/// not from the context, so a relative Dockerfile is made the context's here; none at all leaves
/// the engine its own default (`Dockerfile`, or Podman's `Containerfile` first).
fn build_args(request: &SessionRequest) -> Result<Vec<String>, String> {
    let context = request.build_context.as_deref().map(str::trim).unwrap_or_default();
    if context.is_empty() {
        return Err("choose the folder to build".into());
    }
    let folder = std::path::Path::new(context);
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(format!("{context} is not a folder of this computer"));
    }
    let mut args: Vec<String> = vec!["build".into()];
    if let Some(tag) = request.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        check_tag(tag)?;
        args.extend(["-t".into(), tag.into()]);
    }
    if let Some(file) = request.dockerfile.as_deref().map(str::trim).filter(|f| !f.is_empty()) {
        let path = folder.join(file);
        if !path.is_file() {
            return Err(format!("{} is not a file of this computer", path.display()));
        }
        args.extend(["-f".into(), path.to_string_lossy().into_owned()]);
    }
    args.push(context.into());
    Ok(args)
}

/// `compose [-p name] [--project-directory dir] [-f file]… <action>`, as `projectLogs` and
/// `engine::action_args` build it: Docker Compose finds a running project by its name alone, `up`
/// and `pull` build it from its files, and a project given without a name is its files.
/// podman-compose and nerdctl compose read the files for everything (`compose_reads_files`).
fn compose_args(kind: engine::EngineKind, action: &str, request: &SessionRequest) -> Result<Vec<String>, String> {
    let project = request.target.trim();
    let files: Vec<&str> = request.config_files.as_deref().unwrap_or_default().split(',').map(str::trim).filter(|f| !f.is_empty()).collect();
    let mut args: Vec<String> = vec!["compose".into()];
    if !project.is_empty() {
        args.extend(["-p".into(), project.into()]);
    }
    if project.is_empty() || engine::compose_reads_files(kind, action) {
        if files.is_empty() && (project.is_empty() || matches!(action, "up" | "pull")) {
            return Err(if project.is_empty() { "choose the project's compose file".into() } else { format!("the compose files of {project} are not on this computer") });
        }
        let dir = request.project_dir.as_deref().map(str::trim).unwrap_or_default();
        if !dir.is_empty() && kind != engine::EngineKind::Podman {
            args.extend(["--project-directory".into(), dir.into()]);
        }
        for file in files {
            args.extend(["-f".into(), file.into()]);
        }
    }
    args.push(action.into());
    if action == "up" {
        args.push("-d".into());
    }
    Ok(args)
}

/// The program and arguments a request runs — its own function so it can be checked without one.
pub fn command_line(request: &SessionRequest) -> Result<(String, Vec<String>), String> {
    // A build names its image by `tag`, and a Compose command may name its project by its files
    // alone: for those the target may be empty — but never a flag.
    let target_optional = request.kind == "build" || compose_action(&request.kind).is_some();
    if !(target_optional && request.target.trim().is_empty()) {
        check_target(&request.target)?;
    }
    let tail = request.tail.unwrap_or(500).min(100_000);
    let shell_args = |args: &mut Vec<String>| match request.shell.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(shell) => args.push(shell.to_string()),
        None => args.extend(["sh".into(), "-c".into(), FIND_SHELL.into()]),
    };
    if request.runtime == "kubernetes" {
        let target = kube::KubeTarget { context: request.context.clone(), namespace: request.namespace.clone() };
        let mut args = target.context_args();
        match request.kind.as_str() {
            "logs" => {
                args.extend(["logs".into(), "-f".into(), format!("--tail={tail}"), request.target.clone()]);
                if request.timestamps {
                    args.push("--timestamps".into());
                }
                if request.previous {
                    args.push("--previous".into());
                }
            }
            "exec" => args.extend(["exec".into(), "-it".into(), request.target.clone()]),
            other => return Err(format!("unknown session {other}")),
        }
        if let Some(c) = request.container.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            args.extend(["-c".into(), c.to_string()]);
        } else if request.kind == "logs" && !request.target.contains('/') {
            args.push("--all-containers=true".into());
            args.push("--prefix=true".into());
        }
        if let Some(ns) = target.namespace() {
            args.extend(["-n".into(), ns.to_string()]);
        }
        if request.kind == "exec" {
            args.push("--".into());
            shell_args(&mut args);
        }
        return Ok((kube::program(), args));
    }
    let engine_target = engine::Target { runtime: request.runtime.clone(), context: request.context.clone() };
    let kind = engine_target.engine()?;
    if kind == engine::EngineKind::Ctr {
        return Err("ctr has no logs, shell, builds or Compose to run here; install nerdctl for that".into());
    }
    let mut args = engine_target.global_args();
    match request.kind.as_str() {
        "logs" => {
            args.extend(["logs".into(), "-f".into(), "--tail".into(), tail.to_string()]);
            if request.timestamps {
                args.push("--timestamps".into());
            }
            args.push(request.target.clone());
        }
        "exec" => {
            args.extend(["exec".into(), "-it".into(), request.target.clone()]);
            shell_args(&mut args);
        }
        // A whole Compose project's output, every service prefixed — `docker compose logs -f`. Docker
        // Compose finds the project by its name; the others read its files (see `compose_reads_files`).
        "projectLogs" => {
            args.extend(["compose".into(), "-p".into(), request.target.clone()]);
            if engine::compose_reads_files(kind, "logs") {
                let dir = request.project_dir.as_deref().map(str::trim).unwrap_or_default();
                if !dir.is_empty() && kind != engine::EngineKind::Podman {
                    args.extend(["--project-directory".into(), dir.to_string()]);
                }
                for file in request.config_files.as_deref().unwrap_or_default().split(',').map(str::trim).filter(|f| !f.is_empty()) {
                    args.extend(["-f".into(), file.to_string()]);
                }
            }
            args.extend(["logs".into(), "-f".into(), "--tail".into(), tail.to_string()]);
            if request.timestamps {
                args.push("--timestamps".into());
            }
        }
        // These run to their end in the pane, and the session exits with them.
        "pull" => {
            engine::check_ref(&request.target)?;
            args.extend(["pull".into(), request.target.clone()]);
        }
        "build" => args.extend(build_args(request)?),
        other => match compose_action(other) {
            Some(action) => args.extend(compose_args(kind, action, request)?),
            None => return Err(format!("unknown session {other}")),
        },
    }
    Ok((kind.program(), args))
}

/// A Compose project's files, kept only where they are still on this computer: a label names the
/// paths of whoever started the project, and a checkout may have moved since.
fn files_still_here(request: &SessionRequest) -> SessionRequest {
    let mut request = request.clone();
    let files = request.config_files.as_deref().unwrap_or_default().split(',').map(str::trim).filter(|f| std::path::Path::new(f).is_file()).collect::<Vec<_>>().join(",");
    request.config_files = Some(files);
    request.project_dir = request.project_dir.filter(|dir| std::path::Path::new(dir.trim()).is_dir());
    request
}

/// What the session is called in the terminal list: the command it runs.
fn label(request: &SessionRequest) -> String {
    let what = match request.kind.as_str() {
        "logs" | "projectLogs" => "logs".to_string(),
        "pull" | "build" => request.kind.clone(),
        kind => match compose_action(kind) {
            Some(action) => format!("compose {action}"),
            None => "exec".to_string(),
        },
    };
    format!("{} {what}", request.runtime)
}

pub fn open(app: AppHandle, registry: &TerminalRegistry, request: &SessionRequest) -> Result<String, String> {
    let request = &files_still_here(request);
    let (program, args) = command_line(request)?;
    let label = label(request);
    terminal::open_pty(
        app,
        registry,
        &program,
        &args,
        None,
        // Not recorded: a container's output is the container's, and the engine keeps it.
        None,
        terminal::Origin { cwd: String::new(), profile: label, owner: None },
        terminal::PtyHooks {
            env: [("PATH".to_string(), super::cli::search_path())].into_iter().chain(super::cli::engine_env_now()).collect(),
            ..Default::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: &str, runtime: &str) -> SessionRequest {
        SessionRequest {
            kind: kind.into(),
            runtime: runtime.into(),
            context: None,
            namespace: None,
            target: "api".into(),
            container: None,
            tail: Some(200),
            timestamps: false,
            previous: false,
            shell: None,
            project_dir: None,
            config_files: None,
            build_context: None,
            dockerfile: None,
            tag: None,
        }
    }

    #[test]
    fn engine_sessions() {
        let (_, args) = command_line(&request("logs", "docker")).unwrap();
        assert_eq!(args, vec!["logs", "-f", "--tail", "200", "api"]);
        let mut exec = request("exec", "podman");
        exec.shell = Some("/bin/zsh".into());
        let (_, args) = command_line(&exec).unwrap();
        assert_eq!(args, vec!["exec", "-it", "api", "/bin/zsh"]);
        let mut ctx = request("exec", "docker");
        ctx.context = Some("orbstack".into());
        let (_, args) = command_line(&ctx).unwrap();
        assert_eq!(&args[..5], &["--context", "orbstack", "exec", "-it", "api"]);
        assert_eq!(args[5], "sh");
        // Docker Compose follows a project by its name: a moved checkout's files are never needed.
        let mut project = request("projectLogs", "docker");
        project.target = "shop".into();
        project.project_dir = Some("/w".into());
        project.config_files = Some("/w/a.yml,/w/b.yml".into());
        let (_, args) = command_line(&project).unwrap();
        assert_eq!(args, vec!["compose", "-p", "shop", "logs", "-f", "--tail", "200"]);
        let mut podman = project.clone();
        podman.runtime = "podman".into();
        let (_, args) = command_line(&podman).unwrap();
        assert_eq!(args, vec!["compose", "-p", "shop", "-f", "/w/a.yml", "-f", "/w/b.yml", "logs", "-f", "--tail", "200"]);
        let gone = files_still_here(&podman);
        assert_eq!((gone.config_files.as_deref(), gone.project_dir.as_deref()), (Some(""), None), "paths not on this computer are dropped");
    }

    #[test]
    fn kubernetes_sessions() {
        let mut logs = request("logs", "kubernetes");
        logs.context = Some("orbstack".into());
        logs.namespace = Some("shop".into());
        let (_, args) = command_line(&logs).unwrap();
        assert_eq!(args, vec!["--context", "orbstack", "logs", "-f", "--tail=200", "api", "--all-containers=true", "--prefix=true", "-n", "shop"]);
        let mut exec = request("exec", "kubernetes");
        exec.container = Some("web".into());
        let (_, args) = command_line(&exec).unwrap();
        assert_eq!(&args[..5], &["exec", "-it", "api", "-c", "web"]);
        assert_eq!(args[5], "--");
        let mut bad = request("logs", "docker");
        bad.target = "--help".into();
        assert!(command_line(&bad).is_err());
    }

    #[test]
    fn pull_sessions() {
        let mut pull = request("pull", "docker");
        pull.target = "nginx:alpine".into();
        assert_eq!(command_line(&pull).unwrap().1, vec!["pull", "nginx:alpine"]);
        pull.context = Some("orbstack".into());
        assert_eq!(command_line(&pull).unwrap().1, vec!["--context", "orbstack", "pull", "nginx:alpine"]);
        pull.runtime = "podman".into();
        pull.context = None;
        assert_eq!(command_line(&pull).unwrap().1, vec!["pull", "nginx:alpine"]);
        for bad in ["", "-q", "a b"] {
            pull.target = bad.into();
            assert!(command_line(&pull).is_err(), "{bad:?} is refused");
        }
        let mut ctr = request("pull", "ctr");
        ctr.target = "docker.io/library/nginx:alpine".into();
        assert!(command_line(&ctr).unwrap_err().contains("nerdctl"));
        let mut kube = request("pull", "kubernetes");
        kube.target = "nginx".into();
        assert!(command_line(&kube).unwrap_err().contains("unknown session"));
    }

    #[test]
    fn build_sessions() {
        let dir = std::env::temp_dir().join(format!("cf-build-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("docker")).unwrap();
        std::fs::write(dir.join("Dockerfile"), "FROM alpine:3\n").unwrap();
        std::fs::write(dir.join("docker/Dev.Dockerfile"), "FROM alpine:3\n").unwrap();
        let context = dir.to_string_lossy().into_owned();
        let mut build = request("build", "docker");
        build.target = String::new();
        build.build_context = Some(context.clone());
        assert_eq!(command_line(&build).unwrap().1, vec!["build".to_string(), context.clone()], "the engine's own Dockerfile, no tag");
        build.tag = Some("cf-test-build:1".into());
        build.dockerfile = Some("docker/Dev.Dockerfile".into());
        let dev = dir.join("docker/Dev.Dockerfile").to_string_lossy().into_owned();
        assert_eq!(command_line(&build).unwrap().1, vec!["build".to_string(), "-t".into(), "cf-test-build:1".into(), "-f".into(), dev.clone(), context.clone()], "a relative Dockerfile is the context's");
        build.dockerfile = Some(dev.clone());
        assert_eq!(command_line(&build).unwrap().1[4], dev, "an absolute one stays");
        build.dockerfile = Some("Missing.Dockerfile".into());
        assert!(command_line(&build).unwrap_err().contains("Missing.Dockerfile"));
        build.dockerfile = None;
        for tag in ["My-App", "app:", "-t", "a b", "app@sha256:abc", "app:bad/tag", "app:-x"] {
            build.tag = Some(tag.into());
            assert!(command_line(&build).is_err(), "tag {tag:?} is refused");
        }
        for tag in ["my-app", "my_app:dev", "localhost:5000/app", "registry.example.com:5000/team/app:1.2-RC", "a"] {
            build.tag = Some(tag.into());
            assert!(command_line(&build).is_ok(), "tag {tag:?} is taken");
        }
        build.tag = None;
        build.target = "--x".into();
        assert!(command_line(&build).is_err(), "an unused target is still never a flag");
        build.target = String::new();
        build.build_context = Some("relative/dir".into());
        assert!(command_line(&build).is_err());
        build.build_context = Some(dir.join("nope").to_string_lossy().into_owned());
        assert!(command_line(&build).is_err());
        build.build_context = None;
        assert!(command_line(&build).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compose_sessions() {
        let mut compose = request("composeUp", "docker");
        compose.target = "shop".into();
        compose.project_dir = Some("/w".into());
        compose.config_files = Some("/w/a.yml, /w/b.yml".into());
        assert_eq!(command_line(&compose).unwrap().1, vec!["compose", "-p", "shop", "--project-directory", "/w", "-f", "/w/a.yml", "-f", "/w/b.yml", "up", "-d"]);
        compose.kind = "composePull".into();
        assert_eq!(command_line(&compose).unwrap().1, vec!["compose", "-p", "shop", "--project-directory", "/w", "-f", "/w/a.yml", "-f", "/w/b.yml", "pull"]);
        // Docker Compose takes a running project down, or restarts it, by its name alone.
        compose.kind = "composeDown".into();
        assert_eq!(command_line(&compose).unwrap().1, vec!["compose", "-p", "shop", "down"]);
        compose.kind = "composeRestart".into();
        assert_eq!(command_line(&compose).unwrap().1, vec!["compose", "-p", "shop", "restart"]);
        // podman-compose reads the files for everything, and has no --project-directory.
        let mut podman = compose.clone();
        podman.runtime = "podman".into();
        assert_eq!(command_line(&podman).unwrap().1, vec!["compose", "-p", "shop", "-f", "/w/a.yml", "-f", "/w/b.yml", "restart"]);
        podman.config_files = None;
        assert_eq!(command_line(&podman).unwrap().1, vec!["compose", "-p", "shop", "restart"], "a running project still restarts without them");
        // A file picked by hand: the project is the file's.
        let mut file = request("composeUp", "nerdctl");
        file.target = String::new();
        file.config_files = Some("/w/compose.yaml".into());
        assert_eq!(command_line(&file).unwrap().1, vec!["compose", "-f", "/w/compose.yaml", "up", "-d"]);
        file.kind = "composeDown".into();
        assert_eq!(command_line(&file).unwrap().1, vec!["compose", "-f", "/w/compose.yaml", "down"]);
        // Nothing to go on: no files left on this computer for what needs them.
        compose.kind = "composeUp".into();
        compose.config_files = Some(String::new());
        assert!(command_line(&compose).unwrap_err().contains("not on this computer"));
        file.config_files = None;
        assert!(command_line(&file).unwrap_err().contains("compose file"));
        compose.target = "-p".into();
        assert!(command_line(&compose).is_err());
    }

    #[test]
    fn sessions_are_named_for_their_command() {
        let named = |kind: &str| label(&request(kind, "docker"));
        assert_eq!(named("logs"), "docker logs");
        assert_eq!(named("projectLogs"), "docker logs");
        assert_eq!(named("exec"), "docker exec");
        assert_eq!(named("pull"), "docker pull");
        assert_eq!(named("build"), "docker build");
        assert_eq!(named("composeUp"), "docker compose up");
        assert_eq!(named("composeRestart"), "docker compose restart");
    }

    /// The pull, build and Compose command lines run as plain commands against the Docker on this
    /// computer: `CODEFLOW_LIVE_CONTAINERS=1 cargo test --lib containers::session::tests::live_docker
    /// -- --ignored --nocapture`. Makes, and removes, only `cf-test-*` objects.
    #[tokio::test]
    #[ignore]
    async fn live_docker() {
        if std::env::var("CODEFLOW_LIVE_CONTAINERS").is_err() {
            return;
        }
        let run = |request: SessionRequest| async move {
            let (program, args) = command_line(&files_still_here(&request)).expect("a command line");
            println!("$ {program} {}", args.join(" "));
            let out = crate::containers::cli::run(&program, &args, None, engine::PULL_TIMEOUT).await.expect("it ran");
            assert!(out.ok(), "{}", out.complaint());
        };
        let mut pull = request("pull", "docker");
        pull.target = "alpine:3".into();
        run(pull).await;

        let dir = std::env::temp_dir().join(format!("cf-test-session-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("docker")).unwrap();
        std::fs::write(dir.join("docker/Dev.Dockerfile"), "FROM alpine:3\nLABEL cf.test=build\n").unwrap();
        std::fs::write(dir.join("compose.yaml"), "services:\n  app:\n    image: alpine:3\n    command: [\"sleep\", \"600\"]\n").unwrap();
        let folder = dir.to_string_lossy().into_owned();
        let mut build = request("build", "docker");
        build.target = String::new();
        build.build_context = Some(folder.clone());
        build.dockerfile = Some("docker/Dev.Dockerfile".into());
        build.tag = Some("cf-test-build:1".into());
        run(build).await;

        let mut compose = request("composeUp", "docker");
        compose.target = "cf-test-proj".into();
        compose.project_dir = Some(folder.clone());
        compose.config_files = Some(dir.join("compose.yaml").to_string_lossy().into_owned());
        run(compose.clone()).await;
        // A running project restarts and comes down by its name alone.
        let mut by_name = compose.clone();
        by_name.project_dir = None;
        by_name.config_files = None;
        by_name.kind = "composeRestart".into();
        run(by_name.clone()).await;
        compose.kind = "composePull".into();
        run(compose).await;
        by_name.kind = "composeDown".into();
        run(by_name).await;

        let _ = crate::containers::cli::run("docker", &["rmi".into(), "cf-test-build:1".into()], None, engine::PULL_TIMEOUT).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
