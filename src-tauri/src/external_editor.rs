//! «Abrir en …»: the repository opened in the editor the user works in — VS Code, Cursor,
//! Antigravity, a JetBrains IDE… — chosen once for the app, and again per workspace or per
//! repository where it differs (user, 2026-10-21). It used to be `code <path>` and nothing else.
//!
//! **Found by looking, never by running.** An editor is installed when its application or its
//! command is where installers put it: an `.app` bundle in an Applications folder on macOS, its
//! executable under the usual install roots on Windows, a command on the `PATH` elsewhere. Nothing
//! found is executed to ask what it is (a `--version` probe once got an extension's binary
//! quarantined by XProtect); the one launch is the user's own click.
//!
//! **Chosen nearest first:** the repository's choice, else its workspace's, else the app's, else
//! «automatic» — VS Code when it is installed, or the first editor this machine has.

use std::path::{Path, PathBuf};

/// One editor CodeFlow knows how to find and open a folder in.
pub struct Editor {
    pub id: &'static str,
    pub label: &'static str,
    /// macOS application bundles, any of which is this editor.
    mac_apps: &'static [&'static str],
    /// Windows executables, `%VAR%` expanded.
    win_paths: &'static [&'static str],
    /// A JetBrains IDE on Windows: the folder name it is installed under (`WebStorm 2025.2`, or just
    /// `WebStorm` from the Toolbox) and its launcher in `bin`.
    jetbrains: Option<(&'static str, &'static str)>,
    /// Its command-line launcher, looked for on the `PATH`.
    clis: &'static [&'static str],
}

const fn editor(id: &'static str, label: &'static str, mac_apps: &'static [&'static str], win_paths: &'static [&'static str], clis: &'static [&'static str]) -> Editor {
    Editor { id, label, mac_apps, win_paths, jetbrains: None, clis }
}

const fn jetbrains(id: &'static str, label: &'static str, mac_apps: &'static [&'static str], product: &'static str, exe: &'static str, clis: &'static [&'static str]) -> Editor {
    Editor { id, label, mac_apps, win_paths: &[], jetbrains: Some((product, exe)), clis }
}

/// The editors offered, in the order «automatic» tries them.
pub static EDITORS: &[Editor] = &[
    editor(
        "vscode",
        "VS Code",
        &["Visual Studio Code.app"],
        &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe", r"%ProgramFiles%\Microsoft VS Code\Code.exe"],
        &["code"],
    ),
    editor("cursor", "Cursor", &["Cursor.app"], &[r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe"], &["cursor"]),
    editor("windsurf", "Windsurf", &["Windsurf.app"], &[r"%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe"], &["windsurf"]),
    editor("antigravity", "Antigravity", &["Antigravity.app"], &[r"%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"], &["antigravity"]),
    editor("zed", "Zed", &["Zed.app", "Zed Preview.app"], &[r"%LOCALAPPDATA%\Programs\Zed\Zed.exe"], &["zed", "zeditor"]),
    editor("kiro", "Kiro", &["Kiro.app"], &[r"%LOCALAPPDATA%\Programs\Kiro\Kiro.exe"], &["kiro"]),
    editor("trae", "Trae", &["Trae.app"], &[r"%LOCALAPPDATA%\Programs\Trae\Trae.exe"], &["trae"]),
    editor(
        "vscode-insiders",
        "VS Code Insiders",
        &["Visual Studio Code - Insiders.app"],
        &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe", r"%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe"],
        &["code-insiders"],
    ),
    editor(
        "vscodium",
        "VSCodium",
        &["VSCodium.app"],
        &[r"%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe", r"%ProgramFiles%\VSCodium\VSCodium.exe"],
        &["codium"],
    ),
    editor("sublime", "Sublime Text", &["Sublime Text.app"], &[r"%ProgramFiles%\Sublime Text\sublime_text.exe", r"%ProgramFiles%\Sublime Text 3\sublime_text.exe"], &["subl"]),
    jetbrains("idea", "IntelliJ IDEA", &["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"], "IntelliJ IDEA", "idea64.exe", &["idea"]),
    jetbrains("webstorm", "WebStorm", &["WebStorm.app"], "WebStorm", "webstorm64.exe", &["webstorm"]),
    jetbrains("pycharm", "PyCharm", &["PyCharm.app", "PyCharm Professional Edition.app", "PyCharm CE.app", "PyCharm Community Edition.app"], "PyCharm", "pycharm64.exe", &["pycharm"]),
    jetbrains("goland", "GoLand", &["GoLand.app"], "GoLand", "goland64.exe", &["goland"]),
    jetbrains("rider", "Rider", &["Rider.app"], "JetBrains Rider", "rider64.exe", &["rider"]),
    jetbrains("phpstorm", "PhpStorm", &["PhpStorm.app"], "PhpStorm", "phpstorm64.exe", &["phpstorm"]),
    jetbrains("rubymine", "RubyMine", &["RubyMine.app"], "RubyMine", "rubymine64.exe", &["rubymine"]),
    jetbrains("clion", "CLion", &["CLion.app"], "CLion", "clion64.exe", &["clion"]),
    jetbrains("rustrover", "RustRover", &["RustRover.app"], "RustRover", "rustrover64.exe", &["rustrover"]),
    editor("android-studio", "Android Studio", &["Android Studio.app"], &[r"%ProgramFiles%\Android\Android Studio\bin\studio64.exe"], &["studio"]),
];

/// The app's choice; `""` or `auto` is automatic.
pub const DEFAULT_KEY: &str = "external_editor";
/// A workspace's choice, after the prefix its id; `""` follows the app's.
pub const WORKSPACE_PREFIX: &str = "external_editor_ws:";
/// A repository's choice, after the prefix its id; `""` follows its workspace's.
pub const PROJECT_PREFIX: &str = "external_editor_repo:";

pub fn find(id: &str) -> Option<&'static Editor> {
    EDITORS.iter().find(|editor| editor.id == id)
}

/// Where an editor was found: what [`open`] launches.
#[derive(Debug, Clone, PartialEq)]
pub enum Found {
    /// A macOS application bundle — opened with `open -a`, so the folder lands in its window.
    App(PathBuf),
    /// An executable that takes the folder as its argument.
    Exe(PathBuf),
}

/// Where `editor` is installed on this machine, or `None`.
pub fn locate(editor: &Editor) -> Option<Found> {
    if cfg!(target_os = "macos") {
        let home = dirs::home_dir();
        let roots: Vec<PathBuf> = [Some(PathBuf::from("/Applications")), home.as_ref().map(|h| h.join("Applications")), home.as_ref().map(|h| h.join("Applications/JetBrains Toolbox"))]
            .into_iter()
            .flatten()
            .collect();
        for app in editor.mac_apps {
            if let Some(path) = roots.iter().map(|root| root.join(app)).find(|path| path.is_dir()) {
                return Some(Found::App(path));
            }
        }
    }
    if cfg!(windows) {
        if let Some(path) = editor.win_paths.iter().filter_map(|raw| expand(raw)).find(|path| path.is_file()) {
            return Some(Found::Exe(path));
        }
        if let Some((product, exe)) = editor.jetbrains {
            if let Some(path) = jetbrains_on_windows(product, exe) {
                return Some(Found::Exe(path));
            }
        }
    }
    editor.clis.iter().find_map(|cli| on_path(cli)).map(Found::Exe)
}

/// `%LOCALAPPDATA%\Programs\…` with the variable read; `None` when it is not set.
fn expand(raw: &str) -> Option<PathBuf> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after.find('%')?;
        out.push_str(&std::env::var(&after[..end]).ok()?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(PathBuf::from(out))
}

/// A JetBrains IDE where the Toolbox puts it (`%LOCALAPPDATA%\Programs\WebStorm`) or where its
/// installer does (`%ProgramFiles%\JetBrains\WebStorm 2025.2`) — the newest of those.
fn jetbrains_on_windows(product: &str, exe: &str) -> Option<PathBuf> {
    if let Some(path) = expand(&format!(r"%LOCALAPPDATA%\Programs\{product}\bin\{exe}")).filter(|p| p.is_file()) {
        return Some(path);
    }
    let root = expand(r"%ProgramFiles%\JetBrains")?;
    let mut found: Vec<PathBuf> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(product))
        .map(|entry| entry.path().join("bin").join(exe))
        .filter(|path| path.is_file())
        .collect();
    found.sort();
    found.pop()
}

/// `cli` on the `PATH`, or where package managers and the JetBrains Toolbox put commands that a
/// GUI-launched app's short `PATH` misses.
fn on_path(cli: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
        dirs.push(home.join("Library/Application Support/JetBrains/Toolbox/scripts"));
    }
    dirs.extend(["/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"].map(PathBuf::from));
    let names: Vec<String> = if cfg!(windows) { vec![format!("{cli}.cmd"), format!("{cli}.exe"), format!("{cli}.bat")] } else { vec![cli.to_string()] };
    dirs.iter().flat_map(|dir| names.iter().map(move |name| dir.join(name))).find(|path| path.is_file())
}

/// Which editor opens a repository: the repository's choice, its workspace's, the app's — the
/// first that names an editor this build knows — or, with none, the first `installed` one,
/// VS Code first. A choice that is not installed still wins: it may live where nothing looks, and
/// opening it says so if it is gone.
pub fn resolve(project: Option<&str>, workspace: Option<&str>, default: Option<&str>, installed: &[&'static str]) -> &'static Editor {
    [project, workspace, default]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != "auto")
        .find_map(find)
        .or_else(|| installed.first().and_then(|id| find(id)))
        .unwrap_or(&EDITORS[0])
}

/// Opens `dir` in `editor`. `Err` names the editor and why, for the toast.
pub fn open(editor: &Editor, dir: &Path) -> Result<(), String> {
    let Some(found) = locate(editor) else {
        return Err(format!("{} isn't installed where CodeFlow looks for it (its app, or `{}` on the PATH).", editor.label, editor.clis.first().copied().unwrap_or("")));
    };
    let mut command = match &found {
        Found::App(app) => {
            let mut command = crate::proc::std_command("/usr/bin/open");
            command.arg("-a").arg(app);
            command
        }
        // A `.cmd` shim does not start when spawned directly (the `npx` issue in `skills_cmd`).
        Found::Exe(path) if cfg!(windows) && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")) => {
            let mut command = crate::proc::std_command("cmd");
            command.arg("/C").arg(path);
            command
        }
        Found::Exe(path) => crate::proc::std_command(path),
    };
    command.arg(dir).spawn().map_err(|e| format!("Couldn't start {}: {e}", editor.label))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_found_by_id() {
        let mut ids: Vec<&str> = EDITORS.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), EDITORS.len());
        assert_eq!(find("cursor").map(|e| e.label), Some("Cursor"));
        assert!(find("notepad").is_none());
    }

    #[test]
    fn the_nearest_choice_wins_and_automatic_takes_what_is_installed() {
        assert_eq!(resolve(Some("zed"), Some("cursor"), Some("vscode"), &[]).id, "zed", "the repository's");
        assert_eq!(resolve(Some(""), Some("cursor"), Some("vscode"), &[]).id, "cursor", "its workspace's");
        assert_eq!(resolve(None, None, Some("webstorm"), &[]).id, "webstorm", "the app's");
        assert_eq!(resolve(None, None, Some("auto"), &["cursor", "zed"]).id, "cursor", "automatic: the first installed");
        assert_eq!(resolve(Some("not-an-editor"), None, None, &["zed"]).id, "zed", "an unknown id is no choice");
        assert_eq!(resolve(None, None, None, &[]).id, "vscode", "nothing installed: VS Code, as before");
    }

    #[test]
    fn variables_expand_and_a_missing_one_is_no_path() {
        std::env::set_var("CF_EDITOR_TEST_ROOT", "/tmp/root");
        assert_eq!(expand(r"%CF_EDITOR_TEST_ROOT%/Programs/x.exe"), Some(PathBuf::from("/tmp/root/Programs/x.exe")));
        assert_eq!(expand(r"%CF_EDITOR_TEST_UNSET_VAR%/x.exe"), None);
    }
}
