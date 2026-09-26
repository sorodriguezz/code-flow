//! Where a new project goes, and the terminal its commands run in.
//!
//! **Commands run in a real pty, on screen.** Generators change their prompts from one release to the
//! next — create-vite grew an "install and start now?" question, Angular an "AI tools?" one, Nest an
//! observability one — and a scaffold driven through a hidden pipe hangs forever on the first
//! question nobody anticipated. The catalogue passes every flag it knows to keep them quiet; the pty
//! is what makes the ones it does not know merely a question the user answers, in the xterm pane the
//! dialog shows, instead of a spinner that never ends. It is the same session type as any other
//! terminal (see [`crate::terminal::open_pty`]), so `terminal:output`/`terminal:exit` drive the pane
//! and the exit code decides success.
//!
//! **The script is a file.** It is assembled by the frontend (`lib/scaffold/script.ts`), which knows
//! the platform's quoting, and written to a temporary file that `/bin/sh` or PowerShell then runs —
//! no second round of quoting through a command line, and on Windows no 8K `cmd` limit. The file is
//! removed when the session ends.
//!
//! **Its `PATH` is the fresh one** from [`super::tools::current_path`], so a runtime installed a
//! minute ago by this same dialog is the one the generator finds.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};

use crate::terminal::{self, Origin, PtyHooks, TerminalRegistry};

/// Checked before a name becomes part of a path, a URL or a command line.
///
/// Portable rather than per-platform: a project created here is pushed somewhere and cloned on the
/// other two systems, so a name Windows would refuse (`con`, `a:b`, a trailing dot) is refused on the
/// Mac as well. Framework-specific rules (npm's lowercase names, Python identifiers) are the
/// catalogue's; this is only what a folder can be called.
pub fn validate_folder_name(name: &str) -> Result<(), String> {
    const RESERVED: &[&str] = &[
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
        "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    if name.is_empty() || name.len() > 214 {
        return Err("The project name must be between 1 and 214 characters".into());
    }
    if name == "." || name == ".." || name.starts_with('.') {
        return Err("The project name cannot start with a dot".into());
    }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return Err("The project name cannot start or end with a space or a dot".into());
    }
    if let Some(bad) = name.chars().find(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')) {
        return Err(format!("The project name cannot contain '{bad}'"));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return Err(format!("'{name}' is a reserved name on Windows"));
    }
    Ok(())
}

/// `root` must not exist, or be an empty directory. Every generator refuses a non-empty target in its
/// own words (or, worse, asks whether to overwrite it) — this says it once, before anything runs.
pub fn ensure_free(root: &Path) -> Result<(), String> {
    match std::fs::read_dir(root) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                Err(format!("{} already exists and is not empty", root.display()))
            } else {
                Ok(())
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) if root.is_file() => Err(format!("{} is a file", root.display())),
        Err(e) => Err(e.to_string()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestCheck {
    /// `parent` joined with `name`, with the platform's separator.
    pub path: String,
    /// `None` when the name is usable; otherwise why not, as a sentence.
    pub problem: Option<String>,
    /// Whether the parent folder exists yet. It does not have to — it is created — but the form says
    /// so rather than letting a typo in the location quietly become a new folder tree.
    pub parent_exists: bool,
}

pub fn check_dest(parent: &str, name: &str) -> DestCheck {
    let parent_path = PathBuf::from(parent);
    let root = parent_path.join(name);
    let problem = if parent.trim().is_empty() || !parent_path.is_absolute() {
        Some("Choose where the project goes".to_string())
    } else {
        validate_folder_name(name).err().or_else(|| ensure_free(&root).err())
    };
    DestCheck {
        path: root.to_string_lossy().into_owned(),
        problem,
        parent_exists: parent_path.is_dir(),
    }
}

/// A file a template writes itself — the boilerplate of the templates that have no generator of their
/// own (plain Node, Express, Go, FastAPI, Flask), and the `.gitignore` a generator left out.
#[derive(Debug, Deserialize)]
pub struct FileSpec {
    /// Relative to the project root, with `/` separators.
    pub path: String,
    pub content: String,
}

/// Writes `files` under `root`, creating it. Every path is held to `root`: relative, no `..`, no
/// drive or root component — the content comes from the bundled catalogue, but the rule is cheaper
/// than the argument about whether it always will.
pub fn write_files(root: &Path, files: &[FileSpec]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for file in files {
        let relative = Path::new(&file.path);
        let safe = !file.path.is_empty()
            && relative
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)));
        if !safe {
            return Err(format!("Refusing to write outside the project: {}", file.path));
        }
        let target = root.join(relative);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &file.content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Runs `script` in a pty from `cwd` and returns the terminal session's id. `cwd` is created first:
/// the default location is the app's clone root, which a fresh install has not made yet.
pub fn run_script<R: Runtime>(app: AppHandle<R>, registry: &TerminalRegistry, cwd: &str, script: &str) -> Result<String, String> {
    let cwd_path = PathBuf::from(cwd);
    if !cwd_path.is_absolute() {
        return Err("The working folder must be an absolute path".into());
    }
    std::fs::create_dir_all(&cwd_path).map_err(|e| e.to_string())?;

    let extension = if cfg!(windows) { "ps1" } else { "sh" };
    let file = std::env::temp_dir().join(format!("codeflow-scaffold-{}.{extension}", uuid::Uuid::new_v4()));
    // PowerShell 5.1 reads a BOM-less script in the ANSI code page, which turns every accented
    // character of a step's title into mojibake. The BOM is how it learns the file is UTF-8.
    let mut bytes: Vec<u8> = Vec::new();
    if cfg!(windows) {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(script.as_bytes());
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;

    let (program, args): (String, Vec<String>) = if cfg!(windows) {
        (
            "powershell.exe".into(),
            vec![
                "-NoLogo".into(),
                "-NoProfile".into(),
                "-ExecutionPolicy".into(),
                "Bypass".into(),
                "-File".into(),
                file.to_string_lossy().into_owned(),
            ],
        )
    } else {
        ("/bin/sh".into(), vec![file.to_string_lossy().into_owned()])
    };

    let path = super::tools::current_path(false);
    let cleanup = file.clone();
    terminal::open_pty(
        app,
        registry,
        &program,
        &args,
        Some(cwd),
        None,
        Origin { cwd: cwd.to_string(), profile: "scaffold".into(), owner: None },
        PtyHooks {
            env: vec![
                ("PATH".into(), path),
                // Two prompts nobody asked for, answered the way the catalogue would: corepack's
                // "download pnpm?" and npm's "Ok to proceed?" before running a generator it fetched.
                ("COREPACK_ENABLE_DOWNLOAD_PROMPT".into(), "0".into()),
                ("npm_config_yes".into(), "true".into()),
                ("DOTNET_NOLOGO".into(), "1".into()),
                ("DOTNET_CLI_TELEMETRY_OPTOUT".into(), "1".into()),
            ],
            on_exit: Some(Box::new(move |_| {
                let _ = std::fs::remove_file(&cleanup);
            })),
            ..PtyHooks::default()
        },
    )
}

/// The command-level wrapper, kept here so `mod.rs` stays a list of doors.
pub fn run(app: AppHandle, registry: State<TerminalRegistry>, cwd: String, script: String) -> Result<String, String> {
    run_script(app, &registry, &cwd, &script)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_follow_the_strictest_platform() {
        assert!(validate_folder_name("my-app").is_ok());
        assert!(validate_folder_name("my_app.v2").is_ok());
        assert!(validate_folder_name("").is_err());
        assert!(validate_folder_name(".hidden").is_err());
        assert!(validate_folder_name("..").is_err());
        assert!(validate_folder_name("a/b").is_err());
        assert!(validate_folder_name("a\\b").is_err());
        assert!(validate_folder_name("what?").is_err());
        assert!(validate_folder_name("trailing.").is_err());
        assert!(validate_folder_name("con").is_err());
        assert!(validate_folder_name("CON.txt").is_err());
        assert!(validate_folder_name("console").is_ok());
    }

    #[test]
    fn the_destination_must_be_free() {
        let base = std::env::temp_dir().join(format!("cf-dest-{}", std::process::id()));
        std::fs::create_dir_all(base.join("taken")).unwrap();
        std::fs::write(base.join("taken/file"), "x").unwrap();
        std::fs::create_dir_all(base.join("empty")).unwrap();
        let parent = base.to_string_lossy().into_owned();
        assert!(check_dest(&parent, "fresh").problem.is_none());
        assert!(check_dest(&parent, "empty").problem.is_none());
        assert!(check_dest(&parent, "taken").problem.is_some());
        assert!(check_dest("relative/dir", "fresh").problem.is_some());
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// A real script in a real pty: it runs from `cwd`, its exit code reaches `terminal:exit`, and
    /// the temporary script file is gone afterwards.
    #[cfg(unix)]
    #[test]
    fn a_script_runs_in_a_pty_and_reports_its_exit_code() {
        use std::sync::mpsc;
        use tauri::{Listener, Manager};

        let app = tauri::test::mock_app();
        // Managed, not local: the pty's own thread looks the registry up to strike the session.
        app.manage(TerminalRegistry::default());
        let registry = app.state::<TerminalRegistry>();
        let (tx, rx) = mpsc::channel::<serde_json::Value>();
        app.listen_any("terminal:exit", move |event| {
            if let Ok(payload) = serde_json::from_str(event.payload()) {
                let _ = tx.send(payload);
            }
        });

        let scripts = || {
            std::fs::read_dir(std::env::temp_dir())
                .unwrap()
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("codeflow-scaffold-"))
                .count()
        };
        let before = scripts();
        let cwd = std::env::temp_dir().join(format!("cf-run-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cwd);
        let script = "set -e\nprintf '%s' \"$PATH\" > path.txt\necho made > marker\nexit 3\n";
        let id = run_script(app.handle().clone(), &registry, &cwd.to_string_lossy(), script).unwrap();

        let exit = rx.recv_timeout(std::time::Duration::from_secs(20)).expect("the pty exits");
        assert_eq!(exit["id"], id.as_str());
        assert_eq!(exit["code"], 3);
        assert_eq!(std::fs::read_to_string(cwd.join("marker")).unwrap().trim(), "made");
        // The child saw the initializer's PATH, not a bare launchd one.
        let path = std::fs::read_to_string(cwd.join("path.txt")).unwrap();
        assert!(path.split(':').count() > 4, "{path}");
        let _ = std::fs::remove_dir_all(&cwd);
        assert_eq!(scripts(), before, "the script file is removed when the session ends");
    }

    #[test]
    fn files_cannot_escape_the_project() {
        let root = std::env::temp_dir().join(format!("cf-write-{}", std::process::id()));
        let ok = [FileSpec { path: "src/main.go".into(), content: "package main".into() }];
        write_files(&root, &ok).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("src/main.go")).unwrap(), "package main");
        for bad in ["../escape", "/etc/passwd", "a/../../b", ""] {
            let spec = [FileSpec { path: bad.into(), content: String::new() }];
            assert!(write_files(&root, &spec).is_err(), "{bad} should be refused");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
