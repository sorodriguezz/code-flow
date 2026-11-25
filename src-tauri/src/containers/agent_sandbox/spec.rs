//! The pure half of the broker: the container a sandbox is, as a [`RunSpec`] and its argv; the argv
//! of a command run in it; which commands are tests; the names it gives things; how a path an agent
//! names maps into its checkout. Everything here is decided before an engine is asked anything, so
//! it is all tested without one.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::containers::engine::{self, EngineKind};
use crate::containers::run::{self, RunSpec, RunVolume};

/// The label every sandbox container carries; its value is the sandbox's id. What the cleanup looks
/// for — and the only thing it ever removes.
pub const LABEL: &str = "codeflow.sandbox";
/// Where the task's checkout is inside the container.
pub const WORKSPACE: &str = "/workspace";
/// The network an `internal` sandbox joins: created `--internal`, so it has no route out, shared by
/// every such sandbox of the engine.
pub const INTERNAL_NETWORK: &str = "codeflow-sandbox-internal";
/// The variable an exec's processes carry, so a command cut short is ended with everything it started.
pub const EXEC_MARK: &str = "CODEFLOW_SANDBOX_EXEC";

/// How a sandbox reaches the network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum NetworkPolicy {
    /// No network at all — the default: an agent's tests rarely need one, and nothing leaves.
    #[default]
    None,
    /// A network of sandboxes with no route out: services started beside it, nothing beyond.
    Internal,
    /// The engine's default network: the internet, and published ports on this computer.
    Internet,
}

impl NetworkPolicy {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "" | "none" => Ok(Self::None),
            "internal" => Ok(Self::Internal),
            "internet" => Ok(Self::Internet),
            other => Err(format!("{other} is not a network policy (none, internal or internet)")),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Internal => "internal",
            Self::Internet => "internet",
        }
    }

    /// The `--network` the run is given (empty: the engine's default).
    pub fn network(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Internal => INTERNAL_NETWORK,
            Self::Internet => "",
        }
    }
}

/// What a sandbox may use of the machine.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub memory_mb: f64,
    pub cpus: f64,
    pub pids: f64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { memory_mb: 2048.0, cpus: 2.0, pids: 512.0 }
    }
}

impl Limits {
    /// The limits asked for, each within what a sandbox may have — never none.
    pub fn checked(memory_mb: Option<f64>, cpus: Option<f64>, pids: Option<f64>) -> Result<Self, String> {
        let base = Limits::default();
        let pick = |value: Option<f64>, fallback: f64, range: std::ops::RangeInclusive<f64>, what: &str| -> Result<f64, String> {
            let value = value.unwrap_or(fallback);
            if value.is_finite() && range.contains(&value) {
                Ok(value)
            } else {
                Err(format!("{value} is not a {what} for a sandbox ({} to {})", range.start(), range.end()))
            }
        };
        Ok(Limits {
            memory_mb: pick(memory_mb, base.memory_mb, 64.0..=65_536.0, "memory limit in MB")?,
            cpus: pick(cpus, base.cpus, 0.1..=64.0, "number of CPUs")?,
            pids: pick(pids, base.pids, 16.0..=65_536.0, "process limit")?.round(),
        })
    }
}

/// The user a sandbox runs as: this computer's own on Unix, so what the agent writes in the checkout
/// is the user's and not root's (Docker Desktop and OrbStack map any id; a Linux engine does not);
/// an ordinary non-root id elsewhere.
pub fn sandbox_user() -> String {
    #[cfg(unix)]
    {
        // SAFETY: getuid/getgid only read the calling process's ids and cannot fail.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        if uid != 0 {
            return format!("{uid}:{gid}");
        }
    }
    "1000:1000".to_string()
}

pub fn container_name(id: &str) -> String {
    format!("codeflow-sbx-{}", short(id))
}

/// The id's head, for names a person reads.
pub fn short(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect()
}

/// A title as a branch or folder name: lower case, dashes, at most 40 characters.
pub fn slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        let c = match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    slug.trim_matches('-').to_string()
}

/// The folder (under the user's worktrees) and the branch of a sandbox's own checkout: the title,
/// slugged, with the id's head so two alike never collide. `story` puts a story's under `story/`.
pub fn checkout_names(title: &str, id: &str, story: bool) -> (String, String) {
    let slug = slug(title);
    let head = short(id);
    let name = if slug.is_empty() { head } else { format!("{slug}-{head}") };
    let branch = if story { format!("story/{name}") } else { format!("codeflow/sbx-{name}") };
    (format!("sbx-{name}"), branch)
}

/// The container a sandbox is: its checkout at `/workspace` and nothing else of the host (bar the
/// repository's git folder, read-only, so `git status` and `git diff` work inside), a non-root user,
/// every capability dropped, no new privileges, a read-only root with a `/tmp` to write in, limits,
/// and the network its policy says. `git_dir` is the main repository's `.git` folder, at the same
/// path it has on the host — a worktree's `.git` file names it by that path.
pub fn run_spec(id: &str, image: &str, worktree: &str, git_dir: Option<&str>, network: NetworkPolicy, limits: Limits, ports: &[String], user: &str) -> RunSpec {
    let mut volumes = vec![RunVolume { kind: "bind".into(), source: worktree.into(), target: WORKSPACE.into(), read_only: false }];
    if let Some(dir) = git_dir.filter(|d| d.starts_with('/') && !d.contains(':')) {
        volumes.push(RunVolume { kind: "bind".into(), source: dir.into(), target: dir.into(), read_only: true });
    }
    // Ports only where there is a route to them: an internal network publishes nothing.
    let ports = if network == NetworkPolicy::Internet {
        ports.iter().filter(|p| !p.trim().is_empty()).map(|p| run::RunPort { host: "127.0.0.1:".into(), container: p.trim().into(), protocol: "tcp".into() }).collect()
    } else {
        vec![]
    };
    RunSpec {
        image: image.trim().into(),
        name: container_name(id),
        ports,
        env: vec![
            run::RunEnv { key: "HOME".into(), value: "/tmp".into() },
            run::RunEnv { key: "CODEFLOW_SANDBOX".into(), value: id.into() },
        ],
        volumes,
        pull: "missing".into(),
        // Something that waits forever and is in every image, busybox's included.
        command: "tail -f /dev/null".into(),
        workdir: WORKSPACE.into(),
        network: network.network().into(),
        memory_mb: Some(limits.memory_mb),
        cpus: Some(limits.cpus),
        read_only: true,
        user: user.into(),
        cap_drop: vec!["ALL".into()],
        no_new_privileges: true,
        tmpfs: vec!["/tmp:rw,exec,nosuid,size=1g,mode=1777".into()],
        pids_limit: Some(limits.pids),
        ..Default::default()
    }
}

/// `run -d …` for `spec`, with the sandbox's label — the run's own argv ([`run::run_args`]) and the
/// label right after `-d`, before anything the image could read as its own.
pub fn create_args(engine: EngineKind, spec: &RunSpec, id: &str) -> Result<Vec<String>, String> {
    let mut args = run::run_args(engine, spec)?;
    if args.len() < 2 || args[0] != "run" || args[1] != "-d" {
        return Err("the run's arguments did not start as expected".into());
    }
    args.splice(2..2, ["--label".to_string(), format!("{LABEL}={id}")]);
    Ok(args)
}

/// `exec` of `argv` in the sandbox's checkout, marked with `mark` (`NAME=value`).
pub fn exec_args(container: &str, argv: &[String], mark: &str) -> Result<Vec<String>, String> {
    engine::check_ref(container)?;
    if argv.is_empty() || argv[0].trim().is_empty() {
        return Err("name the command to run".into());
    }
    if argv.iter().any(|a| a.contains('\0')) {
        return Err("the command holds a NUL character".into());
    }
    let mut args: Vec<String> = vec!["exec".into(), "-w".into(), WORKSPACE.into(), "-e".into(), mark.into(), container.into()];
    args.extend(argv.iter().cloned());
    Ok(args)
}

/// A shell line, run inside the container, that ends every process carrying `mark` in its environment.
pub fn reap_script(mark: &str) -> String {
    format!("for p in /proc/[0-9]*; do grep -q '{mark}' \"$p/environ\" 2>/dev/null && kill -TERM \"${{p#/proc/}}\" 2>/dev/null; done; true")
}

/// Whether a command runs tests — its output is kept longer, and the evidence lists it as such. A
/// `sh -c '…'` is judged by its script.
pub fn is_test_command(argv: &[String]) -> bool {
    let words: Vec<String> = match argv {
        [shell, flag, script, ..] if matches!(shell.rsplit('/').next(), Some("sh" | "bash" | "zsh")) && flag.starts_with('-') && flag.contains('c') => {
            script.split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|')).filter(|w| !w.is_empty()).map(str::to_string).collect()
        }
        _ => argv.to_vec(),
    };
    let words: Vec<String> = words.iter().map(|w| w.rsplit('/').next().unwrap_or(w).to_ascii_lowercase()).collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    let after = |first: &str, then: &[&str]| words.windows(2).any(|pair| pair[0] == first && then.iter().any(|t| pair[1] == *t || pair[1].starts_with(&format!("{t}:"))));
    const RUNNERS: [&str; 14] = ["pytest", "vitest", "jest", "mocha", "rspec", "phpunit", "tox", "nextest", "ava", "karma", "playwright", "cypress", "ctest", "nosetests"];
    RUNNERS.iter().any(|r| has(r))
        || after("npm", &["test", "t"])
        || words.windows(3).any(|w| w[0] == "npm" && w[1] == "run" && w[2].starts_with("test"))
        || after("pnpm", &["test", "t"])
        || words.windows(3).any(|w| w[0] == "pnpm" && w[1] == "run" && w[2].starts_with("test"))
        || after("yarn", &["test"])
        || after("bun", &["test"])
        || after("deno", &["test"])
        || after("go", &["test"])
        || after("cargo", &["test", "nextest"])
        || after("mvn", &["test", "verify"])
        || after("./mvnw", &["test", "verify"])
        || after("mvnw", &["test", "verify"])
        || after("gradle", &["test", "check"])
        || after("gradlew", &["test", "check"])
        || after("dotnet", &["test"])
        || after("mix", &["test"])
        || after("make", &["test", "check"])
        || after("swift", &["test"])
        || words.windows(3).any(|w| w[0].starts_with("python") && w[1] == "-m" && (w[2] == "pytest" || w[2] == "unittest"))
}

/// `text` cut to its last `max` bytes (on a character boundary), and whether anything was cut — the
/// end of a command's output is where its verdict is.
pub fn tail(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}

/// `text` cut to its first `max` bytes, for a diff — read from the top.
pub fn head(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// A port a sandbox publishes, as `port` prints it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    pub container_port: String,
    pub host: String,
}

/// `port`'s lines: `3000/tcp -> 127.0.0.1:55001` (Podman and Docker alike); the IPv6 twin of a
/// mapping is dropped.
pub fn parse_ports(out: &str) -> Vec<PublishedPort> {
    let mut ports: Vec<PublishedPort> = Vec::new();
    for line in out.lines() {
        let Some((inside, host)) = line.split_once("->") else { continue };
        let (inside, host) = (inside.trim(), host.trim());
        if inside.is_empty() || host.is_empty() || host.starts_with("[::]") || host.starts_with(":::") {
            continue;
        }
        let port = PublishedPort { container_port: inside.to_string(), host: host.to_string() };
        if !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

/// The file `path` names in the sandbox's checkout — `/workspace/src/a.rs` or `src/a.rs` — as a path
/// on this computer under `root`. Refused: anything that climbs out (`..`), another absolute path,
/// and the checkout's `.git`, which is how a worktree finds its repository.
pub fn workspace_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    let raw = path.trim();
    if raw.is_empty() || raw.contains('\0') {
        return Err("name the file, relative to /workspace".into());
    }
    let relative = match raw.strip_prefix(WORKSPACE) {
        Some("") => return Err("/workspace is the checkout itself, not a file".into()),
        Some(rest) if rest.starts_with('/') => rest.trim_start_matches('/'),
        Some(_) => return Err(format!("{raw} is outside /workspace")),
        None if raw.starts_with('/') => return Err(format!("{raw} is outside /workspace")),
        None => raw,
    };
    let mut out = root.to_path_buf();
    let mut first = true;
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(name) => {
                if first && name == ".git" {
                    return Err("the checkout's .git is not a file the sandbox tools touch".into());
                }
                first = false;
                out.push(name);
            }
            Component::CurDir => {}
            _ => return Err(format!("{raw} climbs out of /workspace")),
        }
    }
    if first {
        return Err("name the file, relative to /workspace".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn network_policies_read_and_name_their_network() {
        assert_eq!(NetworkPolicy::parse("").unwrap(), NetworkPolicy::None);
        assert_eq!(NetworkPolicy::parse(" internal ").unwrap().network(), INTERNAL_NETWORK);
        assert_eq!(NetworkPolicy::parse("internet").unwrap().network(), "");
        assert!(NetworkPolicy::parse("host").is_err(), "the host's network is never a sandbox's");
    }

    #[test]
    fn limits_are_never_none_and_never_absurd() {
        assert_eq!(Limits::checked(None, None, None).unwrap(), Limits::default());
        let set = Limits::checked(Some(4096.0), Some(0.5), Some(100.4)).unwrap();
        assert_eq!((set.memory_mb, set.cpus, set.pids), (4096.0, 0.5, 100.0));
        assert!(Limits::checked(Some(0.0), None, None).is_err());
        assert!(Limits::checked(None, Some(f64::NAN), None).is_err());
        assert!(Limits::checked(None, None, Some(1.0)).is_err());
    }

    #[test]
    fn names_read_as_the_task_and_never_collide() {
        assert_eq!(slug("Añadir búsqueda: por ID!"), "anadir-busqueda-por-id");
        assert_eq!(container_name("3f2a9c1d-77"), "codeflow-sbx-3f2a9c1d");
        assert_eq!(checkout_names("Login con SSO", "abcdef1234", true), ("sbx-login-con-sso-abcdef12".into(), "story/login-con-sso-abcdef12".into()));
        assert_eq!(checkout_names("¿?", "abcdef1234", false), ("sbx-abcdef12".into(), "codeflow/sbx-abcdef12".into()));
    }

    fn sandbox_spec(network: NetworkPolicy) -> RunSpec {
        run_spec("abc123", "node:22", "/Users/me/worktrees/app/sbx-x", Some("/Users/me/code/app/.git"), network, Limits::default(), &["3000".into()], "501:20")
    }

    #[test]
    fn a_sandbox_is_hardened_by_construction() {
        let args = create_args(EngineKind::Docker, &sandbox_spec(NetworkPolicy::None), "abc123").unwrap();
        let joined = args.join(" ");
        assert_eq!(&args[..4], &["run", "-d", "--label", "codeflow.sandbox=abc123"]);
        for expected in [
            "--name codeflow-sbx-abc123",
            "-v /Users/me/worktrees/app/sbx-x:/workspace",
            "-v /Users/me/code/app/.git:/Users/me/code/app/.git:ro",
            "-w /workspace",
            "--network none",
            "--memory 2048m",
            "--cpus 2",
            "--pids-limit 512",
            "--user 501:20",
            "--read-only",
            "--tmpfs /tmp:rw,exec,nosuid,size=1g,mode=1777",
            "--cap-drop ALL",
            "--security-opt no-new-privileges",
            "-e HOME=/tmp",
            "node:22 tail -f /dev/null",
        ] {
            assert!(joined.contains(expected), "{expected} missing from {joined}");
        }
        assert!(!joined.contains("-p "), "no network, no published port");
        assert!(!joined.contains("--privileged") && !joined.contains("--cap-add"));
        assert!(!joined.contains("docker.sock"), "the engine's socket is never handed in");
    }

    #[test]
    fn only_a_sandbox_on_the_internet_publishes_and_only_on_this_computer() {
        let joined = create_args(EngineKind::Docker, &sandbox_spec(NetworkPolicy::Internet), "abc123").unwrap().join(" ");
        assert!(joined.contains("-p 127.0.0.1::3000"), "{joined}");
        assert!(!joined.contains("--network"), "the engine's default network");
        let internal = create_args(EngineKind::Docker, &sandbox_spec(NetworkPolicy::Internal), "abc123").unwrap().join(" ");
        assert!(internal.contains(&format!("--network {INTERNAL_NETWORK}")));
        assert!(!internal.contains("-p "));
    }

    #[test]
    fn the_sandbox_spec_passes_the_strictest_policy() {
        use crate::containers::policy::{self, Facts, SecurityPolicy};
        let strict = SecurityPolicy { require_non_root: true, restrict_network: true, require_limits: true, ..Default::default() };
        let spec = sandbox_spec(NetworkPolicy::None);
        let home = std::path::PathBuf::from("/Users/me");
        assert_eq!(policy::check_spec_at(&strict, &spec, &Facts::default(), Some(&home)), vec![]);
        let internal = sandbox_spec(NetworkPolicy::Internal);
        let facts = Facts { internal_networks: vec![INTERNAL_NETWORK.into()], ..Default::default() };
        assert_eq!(policy::check_spec_at(&strict, &internal, &facts, Some(&home)), vec![]);
        let out = policy::check_spec_at(&strict, &sandbox_spec(NetworkPolicy::Internet), &Facts::default(), Some(&home));
        assert_eq!(out.iter().map(|v| v.rule.as_str()).collect::<Vec<_>>(), vec!["network"], "the internet is what a restricted workspace refuses");
    }

    #[test]
    fn a_checkout_on_a_windows_path_mounts_no_git_folder() {
        let spec = run_spec("a", "x", "/w", Some("C:\\code\\.git"), NetworkPolicy::None, Limits::default(), &[], "1000:1000");
        assert_eq!(spec.volumes.len(), 1);
    }

    #[test]
    fn exec_runs_the_argv_in_the_checkout_marked() {
        let args = exec_args("codeflow-sbx-abc", &argv(&["npm", "test", "--", "--watch=false"]), "CODEFLOW_SANDBOX_EXEC=1").unwrap();
        assert_eq!(args, argv(&["exec", "-w", "/workspace", "-e", "CODEFLOW_SANDBOX_EXEC=1", "codeflow-sbx-abc", "npm", "test", "--", "--watch=false"]));
        assert!(exec_args("--privileged", &argv(&["ls"]), "M=1").is_err());
        assert!(exec_args("c", &[], "M=1").is_err());
        assert!(exec_args("c", &argv(&["a\0b"]), "M=1").is_err());
    }

    #[test]
    fn tests_are_told_by_their_runner() {
        for line in [
            &["npm", "test"][..],
            &["npm", "run", "test:unit"],
            &["pnpm", "t"],
            &["npx", "vitest", "run"],
            &["pytest", "-q"],
            &["python3", "-m", "pytest"],
            &["go", "test", "./..."],
            &["cargo", "test", "--lib"],
            &["./gradlew", "test"],
            &["mvn", "verify"],
            &["dotnet", "test"],
            &["make", "check"],
            &["sh", "-c", "npm ci && npm test"],
            &["/bin/bash", "-lc", "cd api; cargo nextest run"],
        ] {
            assert!(is_test_command(&argv(line)), "{line:?} runs tests");
        }
        for line in [&["npm", "install"][..], &["ls", "-la"], &["cargo", "build"], &["git", "status"], &["sh", "-c", "echo test"], &["cat", "pytest.ini"]] {
            assert!(!is_test_command(&argv(line)), "{line:?} runs no tests");
        }
    }

    #[test]
    fn output_keeps_its_end_and_a_diff_its_start() {
        assert_eq!(tail("abcdef", 10), ("abcdef".into(), false));
        assert_eq!(tail("abcdef", 3), ("def".into(), true));
        assert_eq!(tail("ñandú", 3).0, "dú", "never mid-character");
        assert_eq!(head("abcdef", 2), ("ab".into(), true));
        assert_eq!(head("ñandú", 1).0, "", "never mid-character");
    }

    #[test]
    fn published_ports_are_read_off_port() {
        let ports = parse_ports("3000/tcp -> 127.0.0.1:55001\n3000/tcp -> [::]:55001\n8080/tcp -> 0.0.0.0:8080\n\n");
        assert_eq!(ports, vec![
            PublishedPort { container_port: "3000/tcp".into(), host: "127.0.0.1:55001".into() },
            PublishedPort { container_port: "8080/tcp".into(), host: "0.0.0.0:8080".into() },
        ]);
    }

    #[test]
    fn file_paths_stay_in_the_checkout() {
        let root = Path::new("/w/sbx");
        assert_eq!(workspace_file(root, "/workspace/src/a.rs").unwrap(), PathBuf::from("/w/sbx/src/a.rs"));
        assert_eq!(workspace_file(root, "src/./a.rs").unwrap(), PathBuf::from("/w/sbx/src/a.rs"));
        for bad in ["", "/etc/passwd", "/workspace", "/workspacefoo/a", "../x", "src/../../x", ".git/config", "/workspace/.git", "."] {
            assert!(workspace_file(root, bad).is_err(), "{bad} is refused");
        }
        assert!(workspace_file(root, "src/.git").is_ok(), "only the checkout's own .git is off limits");
    }
}
