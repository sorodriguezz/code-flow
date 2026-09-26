//! Which toolchains this machine has, and at what version — the half of the project initializer
//! that answers "can this template run here?" before anything is created.
//!
//! **Run, never looked up.** The same argument `requirements::git` makes: a binary found on `PATH`
//! can still be the wrong architecture, a shim pointing at a version manager that was removed, or
//! macOS's `/usr/bin/java` stub, which exists on every Mac and exits with "Unable to locate a Java
//! Runtime" when no JDK is installed. Asking the program for its version is the only check that
//! proves it runs.
//!
//! **Against a fresh `PATH`.** The process `PATH` is imported from the login shell at startup and
//! is one launch old by design (see `shell_env`). That is fine everywhere else and wrong here: the
//! initializer's whole promise is "install it, and carry on", so a runtime installed thirty seconds
//! ago must be found now. [`current_path`] re-asks the login shell (or, on Windows, the registry)
//! when told to, and every probe runs with that answer in its environment.
//!
//! Two of the managers are not programs at all — nvm and SDKMAN are shell *functions* sourced from
//! a script — so they are found by the script's presence instead, and whatever installs through
//! them sources it explicitly (see `lib/scaffold/tools.ts`).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One tool, as the initializer's environment panel draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub found: bool,
    /// Normalised to `major.minor.patch` — `v22.11.0`, `go1.23.2` and Java's `1.8.0_392` all come
    /// out comparable. `None` when the tool was found but printed nothing that looks like a version
    /// (the file-detected managers), which is still "found".
    pub version: Option<String>,
    /// Where it resolved to, for the row's tooltip — "which `node` is this?" is the first question
    /// anyone asks when a version is not the one they expected.
    pub path: Option<String>,
    /// The program's own first line, or why it could not be run. Shown verbatim.
    pub detail: String,
}

/// How to ask one tool what it is.
struct Probe {
    id: &'static str,
    /// Candidate program names, first match wins. More than one where platforms disagree —
    /// `python3` on Unix is `python` on Windows.
    bins: &'static [&'static str],
    args: &'static [&'static str],
    /// A literal the version follows, for output with more than one number in it: Composer prints
    /// its release date, Gradle a banner of every component's version.
    marker: Option<&'static str>,
}

const PROBES: &[Probe] = &[
    Probe { id: "node", bins: &["node"], args: &["--version"], marker: None },
    Probe { id: "npm", bins: &["npm"], args: &["--version"], marker: None },
    Probe { id: "pnpm", bins: &["pnpm"], args: &["--version"], marker: None },
    Probe { id: "yarn", bins: &["yarn"], args: &["--version"], marker: None },
    Probe { id: "bun", bins: &["bun"], args: &["--version"], marker: None },
    Probe { id: "deno", bins: &["deno"], args: &["--version"], marker: Some("deno ") },
    Probe { id: "java", bins: &["java"], args: &["-version"], marker: Some("version \"") },
    Probe { id: "maven", bins: &["mvn"], args: &["-v"], marker: Some("Apache Maven ") },
    Probe { id: "gradle", bins: &["gradle"], args: &["--version"], marker: Some("Gradle ") },
    Probe { id: "go", bins: &["go"], args: &["version"], marker: Some("go version go") },
    #[cfg(not(windows))]
    Probe { id: "python", bins: &["python3", "python"], args: &["--version"], marker: Some("Python ") },
    #[cfg(windows)]
    Probe { id: "python", bins: &["python", "py"], args: &["--version"], marker: Some("Python ") },
    Probe { id: "uv", bins: &["uv"], args: &["--version"], marker: Some("uv ") },
    Probe { id: "php", bins: &["php"], args: &["--version"], marker: Some("PHP ") },
    Probe { id: "composer", bins: &["composer"], args: &["--version"], marker: Some("Composer version ") },
    Probe { id: "dotnet", bins: &["dotnet"], args: &["--version"], marker: None },
    Probe { id: "cargo", bins: &["cargo"], args: &["--version"], marker: Some("cargo ") },
    Probe { id: "git", bins: &["git"], args: &["--version"], marker: Some("git version ") },
    Probe { id: "docker", bins: &["docker"], args: &["--version"], marker: Some("version ") },
    // The managers the install recipes can go through.
    Probe { id: "brew", bins: &["brew"], args: &["--version"], marker: Some("Homebrew ") },
    Probe { id: "winget", bins: &["winget"], args: &["--version"], marker: None },
    Probe { id: "fnm", bins: &["fnm"], args: &["--version"], marker: Some("fnm ") },
    Probe { id: "volta", bins: &["volta"], args: &["--version"], marker: None },
    Probe { id: "apt", bins: &["apt-get"], args: &["--version"], marker: Some("apt ") },
    Probe { id: "dnf", bins: &["dnf"], args: &["--version"], marker: None },
    Probe { id: "pacman", bins: &["pacman"], args: &["--version"], marker: Some("Pacman v") },
];

/// How long one probe may take. Generous for the JVM tools — `gradle --version` starts a JVM, and a
/// cold one on a laptop is a couple of seconds — and still short enough that a hung shim does not
/// hold the panel for long: every probe runs at once, so the slowest decides.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

/// How long a login-shell `PATH` is reused before the next detection asks again on its own.
/// A refresh the user asks for (or an install finishing) always asks.
const PATH_TTL: Duration = Duration::from_secs(10 * 60);

static PATH_CACHE: Mutex<Option<(Instant, String)>> = Mutex::new(None);

/// The `PATH` children of the initializer run with. `refresh` re-asks the shell even when a recent
/// answer is cached — what an install finishing, or the panel's refresh button, wants.
///
/// Blocking (it can run a login shell), so async callers go through `spawn_blocking`.
pub fn current_path(refresh: bool) -> String {
    if !refresh {
        if let Ok(cache) = PATH_CACHE.lock() {
            if let Some((at, path)) = cache.as_ref() {
                if at.elapsed() < PATH_TTL {
                    return path.clone();
                }
            }
        }
    }
    let shell = crate::shell_env::fresh_path().unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    let path = with_install_dirs(&shell);
    if let Ok(mut cache) = PATH_CACHE.lock() {
        *cache = Some((Instant::now(), path.clone()));
    }
    path
}

/// Where the vendors' own installers put their programs — which is not always somewhere the shell's
/// `PATH` names yet. rustup, Bun, uv, dotnet-install and php.new each write to a folder in the home
/// directory and *then* add a line to a profile, and a profile is only read by the next shell; the
/// dotnet script does not touch one at all. Appended after everything the shell said, only for the
/// folders that exist, so they can find a tool and never outrank the one the user's terminal finds.
fn with_install_dirs(path: &str) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut entries: Vec<String> = path.split(separator).filter(|e| !e.is_empty()).map(str::to_string).collect();
    let mut extra: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".bun/bin",
            ".dotnet",
            ".config/herd-lite/bin",
            ".volta/bin",
            ".deno/bin",
            "go/bin",
            ".local/share/fnm",
        ] {
            extra.push(home.join(relative));
        }
    }
    #[cfg(unix)]
    for fixed in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin", "/home/linuxbrew/.linuxbrew/bin"] {
        extra.push(PathBuf::from(fixed));
    }
    for dir in extra {
        let text = dir.to_string_lossy().into_owned();
        if dir.is_dir() && !entries.iter().any(|entry| entry == &text) {
            entries.push(text);
        }
    }
    entries.join(&separator.to_string())
}

/// `name` resolved against `path`, the way a shell would: the first directory holding an executable
/// by that name. On Windows the `PATHEXT` extensions are tried too, since `npm` is `npm.cmd` there.
pub fn which_in(path: &str, name: &str) -> Option<PathBuf> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| ext.to_ascii_lowercase())
        .collect();
    for dir in path.split(separator).filter(|dir| !dir.trim().is_empty()) {
        let base = Path::new(dir).join(name);
        #[cfg(windows)]
        {
            for ext in &extensions {
                let candidate = base.with_extension(ext.trim_start_matches('.'));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&base) {
                if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
                    return Some(base);
                }
            }
        }
    }
    None
}

/// The first `major.minor[.patch]` in `text` — after `marker` when there is one — normalised to three
/// parts. Java's pre-9 scheme (`1.8.0_392`) is folded to its real major (`8.0.392`), since every
/// requirement anyone writes says "Java 8", never "Java 1.8".
pub fn parse_version(text: &str, marker: Option<&str>) -> Option<String> {
    let haystack = match marker {
        Some(marker) => &text[text.find(marker).map(|at| at + marker.len())?..],
        None => text,
    };
    let bytes = haystack.as_bytes();
    let mut start = None;
    for (at, byte) in bytes.iter().enumerate() {
        if byte.is_ascii_digit() {
            start = Some(at);
            break;
        }
    }
    let rest = &haystack[start?..];
    let mut parts: Vec<u64> = Vec::new();
    for piece in rest.split(|c: char| c == '.' || c == '_') {
        let digits: String = piece.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        parts.push(digits.parse().ok()?);
        // A component followed by anything but a separator ends the version: `22.0.2+9`, `1.23rc1`.
        if digits.len() != piece.len() || parts.len() == 4 {
            break;
        }
    }
    if parts.len() < 2 && marker.is_none() {
        // A lone number with no marker vouching for it is more likely a date or a count than a
        // version — except for the tools whose whole output is one ("21" from nothing we probe).
        return None;
    }
    if parts.first() == Some(&1) && parts.len() >= 3 && marker == Some("version \"") {
        parts.remove(0);
    }
    while parts.len() < 3 {
        parts.push(0);
    }
    Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
}

/// Whether a quiet helper exits cleanly — `xcode-select -p`, `java_home`. Neither prints a dialog.
#[cfg(target_os = "macos")]
fn succeeds(program: &str, args: &[&str]) -> bool {
    crate::proc::std_command(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Why running `path` would put a system dialog on screen instead of answering, if it would.
///
/// macOS ships stubs in `/usr/bin` for things it does not ship: the Command Line Tools' `python3`,
/// `git` and friends, and `java`. Without the real thing behind them they do not fail quietly —
/// they open a modal offering to install it. A detection pass that throws a dialog at the user for
/// asking `python3 --version` is not detection, so the stub's owner is asked first, through a helper
/// that never prompts. Not cached: installing either is exactly what this screen leads people to do.
#[cfg(target_os = "macos")]
fn would_prompt(path: &Path) -> Option<&'static str> {
    if path.parent() != Some(Path::new("/usr/bin")) {
        return None;
    }
    match path.file_name()?.to_str()? {
        "java" | "javac" => {
            (!succeeds("/usr/libexec/java_home", &[])).then_some("No JDK is installed")
        }
        "python3" | "pip3" | "git" | "make" | "clang" | "gcc" | "swift" => (!succeeds("/usr/bin/xcode-select", &["-p"]))
            .then_some("Xcode Command Line Tools are not installed"),
        _ => None,
    }
}

fn missing(id: &str, detail: impl Into<String>) -> ToolStatus {
    ToolStatus { id: id.to_string(), found: false, version: None, path: None, detail: detail.into() }
}

/// nvm and SDKMAN, found by the script a shell sources to get them.
fn detect_sourced(id: &str) -> ToolStatus {
    let home = dirs::home_dir().unwrap_or_default();
    let script = match id {
        "nvm" => std::env::var_os("NVM_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".nvm"))
            .join("nvm.sh"),
        _ => std::env::var_os("SDKMAN_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".sdkman"))
            .join("bin")
            .join("sdkman-init.sh"),
    };
    if script.is_file() {
        ToolStatus {
            id: id.to_string(),
            found: true,
            version: None,
            path: Some(script.to_string_lossy().into_owned()),
            detail: String::new(),
        }
    } else {
        missing(id, String::new())
    }
}

async fn detect_one(id: String, path: String) -> ToolStatus {
    if id == "nvm" || id == "sdkman" {
        return detect_sourced(&id);
    }
    let Some(probe) = PROBES.iter().find(|probe| probe.id == id) else {
        return missing(&id, "unknown tool");
    };
    let Some(program) = probe.bins.iter().find_map(|bin| which_in(&path, bin)) else {
        return missing(&id, String::new());
    };
    #[cfg(target_os = "macos")]
    if let Some(reason) = would_prompt(&program) {
        return missing(&id, reason);
    }

    let mut command = crate::proc::command(&program);
    command
        .args(probe.args)
        .env("PATH", &path)
        // Nothing we probe should stop to ask anything, and two things would: corepack's "about to
        // download pnpm, continue?" and the .NET SDK's first-run banner.
        .env("COREPACK_ENABLE_DOWNLOAD_PROMPT", "0")
        .env("DOTNET_NOLOGO", "1")
        .env("DOTNET_CLI_TELEMETRY_OPTOUT", "1")
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let output = match tokio::time::timeout(PROBE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return missing(&id, e.to_string()),
        Err(_) => return missing(&id, "timed out"),
    };
    // Both streams, in that order: Java prints its version on stderr, and so do some shims that
    // print a deprecation notice on stdout first.
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let first_line = text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("").to_string();
    if !output.status.success() {
        return ToolStatus {
            id,
            found: false,
            version: None,
            path: Some(program.to_string_lossy().into_owned()),
            detail: first_line,
        };
    }
    ToolStatus {
        version: parse_version(&text, probe.marker),
        path: Some(program.to_string_lossy().into_owned()),
        found: true,
        detail: first_line,
        id,
    }
}

/// Every tool in `ids`, probed at once. Unknown ids come back as not found rather than failing the
/// batch: the catalogue lives in TypeScript and may be a release ahead of this table.
pub async fn detect(ids: Vec<String>, refresh: bool) -> Vec<ToolStatus> {
    let path = tokio::task::spawn_blocking(move || current_path(refresh)).await.unwrap_or_default();
    let tasks = ids.into_iter().map(|id| detect_one(id, path.clone()));
    futures_util::future::join_all(tasks).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_what_each_tool_actually_prints() {
        assert_eq!(parse_version("v22.11.0\n", None).as_deref(), Some("22.11.0"));
        assert_eq!(parse_version("10.9.0", None).as_deref(), Some("10.9.0"));
        assert_eq!(parse_version("go version go1.23.2 darwin/arm64", Some("go version go")).as_deref(), Some("1.23.2"));
        assert_eq!(parse_version("Python 3.12.1", Some("Python ")).as_deref(), Some("3.12.1"));
        assert_eq!(
            parse_version("openjdk version \"22.0.2\" 2024-07-16\nOpenJDK Runtime", Some("version \"")).as_deref(),
            Some("22.0.2")
        );
        assert_eq!(
            parse_version("Composer version 2.8.1 2024-10-04 13:31:26", Some("Composer version ")).as_deref(),
            Some("2.8.1")
        );
        assert_eq!(
            parse_version("\n------------------------------------------------------------\nGradle 8.10.2\n", Some("Gradle ")).as_deref(),
            Some("8.10.2")
        );
        assert_eq!(parse_version("uv 0.4.25 (Homebrew 2024-10-21)", Some("uv ")).as_deref(), Some("0.4.25"));
        assert_eq!(parse_version("deno 2.1.1 (stable, release, aarch64-apple-darwin)", Some("deno ")).as_deref(), Some("2.1.1"));
    }

    /// Java 8 says `1.8.0_392`; every requirement written anywhere says "Java 8".
    #[test]
    fn javas_old_scheme_is_folded_to_its_real_major() {
        assert_eq!(parse_version("java version \"1.8.0_392\"", Some("version \"")).as_deref(), Some("8.0.392"));
    }

    /// Two parts are padded; a build suffix ends the version rather than joining it.
    #[test]
    fn short_and_decorated_versions_normalise() {
        assert_eq!(parse_version("Docker version 27.3, build abc", Some("version ")).as_deref(), Some("27.3.0"));
        assert_eq!(parse_version("openjdk version \"21\" 2023-09-19", Some("version \"")).as_deref(), Some("21.0.0"));
    }

    #[test]
    fn output_without_a_version_is_none() {
        assert_eq!(parse_version("command not found", None), None);
        assert_eq!(parse_version("Python", Some("Python ")), None);
    }

    /// The shell's order is kept, nothing is duplicated, and only folders that exist are added.
    #[cfg(not(windows))]
    #[test]
    fn install_dirs_follow_the_shells_path_without_duplicates() {
        let merged = with_install_dirs("/usr/bin:/bin:/opt/homebrew/bin");
        let entries: Vec<&str> = merged.split(':').collect();
        assert_eq!(&entries[..3], ["/usr/bin", "/bin", "/opt/homebrew/bin"]);
        assert_eq!(entries.iter().filter(|e| **e == "/opt/homebrew/bin").count(), 1);
        assert!(entries.iter().skip(3).all(|e| std::path::Path::new(e).is_dir()));
    }

    #[cfg(not(windows))]
    #[test]
    fn which_finds_only_executables_on_the_given_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cf-which-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tool = dir.join("sometool");
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o644)).unwrap();
        let path = format!("/nonexistent:{}", dir.display());
        assert_eq!(which_in(&path, "sometool"), None, "not executable, not a program");
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(which_in(&path, "sometool"), Some(tool.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
