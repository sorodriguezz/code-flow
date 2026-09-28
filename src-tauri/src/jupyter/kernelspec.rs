//! Which kernels this machine can start for a notebook.
//!
//! Three places to look, merged:
//!
//! 1. **Jupyter's own list** — `jupyter kernelspec list --json`, when a `jupyter` is on `PATH`. It
//!    knows the kernels of the environment Jupyter lives in, which no directory scan can.
//! 2. **The kernelspec directories** — the same ones `jupyter_core.paths.jupyter_path("kernels")`
//!    walks (`JUPYTER_PATH`, the user data dir, the system dirs), read directly. This is what
//!    finds kernels on a machine with ipykernel installed but no `jupyter` command.
//! 3. **Pythons nobody registered** — the project's virtualenv (`.venv`, `venv`, `env`, in the
//!    notebook's folder or any folder above it up to the repository) and `python3` on `PATH`. A
//!    Python that can `import ipykernel` is a kernel whether or not anyone ran `ipykernel install`;
//!    one that cannot is offered for installing it (the notebook asks first — nothing here installs).
//!
//! Probing runs the interpreter (`-c "import ipykernel"`), so every probe has a timeout, and none of
//! them is ever a shell command.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long one probe of an interpreter or of `jupyter` may take. Generous: the first import of
/// ipykernel on a cold disk (or a conda env on a network home) is seconds, not milliseconds.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// The folders a project's virtualenv conventionally lives in.
const VENV_DIRS: [&str; 3] = [".venv", "venv", "env"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InterruptMode {
    /// SIGINT to the kernel's process group — what ipykernel expects, and the default.
    Signal,
    /// An `interrupt_request` on the control channel.
    Message,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum KernelSource {
    Jupyter,
    Directory,
    Venv,
    Path,
}

/// A kernel the notebook can start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KernelChoice {
    /// Stable within a discovery: `spec:<name>` for a kernelspec, `python:<path>` for an interpreter.
    pub id: String,
    /// The kernelspec name a notebook's `metadata.kernelspec.name` is matched against.
    pub name: String,
    pub display_name: String,
    pub language: String,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub interrupt_mode: InterruptMode,
    pub source: KernelSource,
    pub resource_dir: Option<String>,
    /// The interpreter behind it, when it is a Python one.
    pub python: Option<String>,
}

/// An interpreter that cannot run a kernel yet — ipykernel is missing.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PythonCandidate {
    pub path: String,
    /// Where it was found: `.venv`, `PATH`…
    pub label: String,
    pub version: Option<String>,
    pub source: KernelSource,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KernelDiscovery {
    pub kernels: Vec<KernelChoice>,
    pub without_ipykernel: Vec<PythonCandidate>,
}

/// Reads one `kernel.json`. `None` for a spec no kernel could be started from (no `argv`).
pub fn parse_kernel_json(name: &str, resource_dir: Option<&Path>, spec: &Value) -> Option<KernelChoice> {
    let argv: Vec<String> = spec
        .get("argv")?
        .as_array()?
        .iter()
        .map(|arg| arg.as_str().map(str::to_string))
        .collect::<Option<_>>()?;
    if argv.is_empty() {
        return None;
    }
    let text = |key: &str| spec.get(key).and_then(Value::as_str).map(str::to_string);
    let env = spec
        .get("env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let interrupt_mode = match spec.get("interrupt_mode").and_then(Value::as_str) {
        Some("message") => InterruptMode::Message,
        _ => InterruptMode::Signal,
    };
    let mut choice = KernelChoice {
        id: format!("spec:{name}"),
        name: name.to_string(),
        display_name: text("display_name").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| name.to_string()),
        language: text("language").unwrap_or_default().to_lowercase(),
        argv,
        env,
        interrupt_mode,
        source: KernelSource::Directory,
        resource_dir: resource_dir.map(|dir| dir.to_string_lossy().into_owned()),
        python: None,
    };
    choice.python = python_of(&choice);
    Some(choice)
}

/// Reads `jupyter kernelspec list --json`.
pub fn parse_kernelspec_list(json: &str) -> Vec<KernelChoice> {
    let Ok(value) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let Some(specs) = value.get("kernelspecs").and_then(Value::as_object) else { return Vec::new() };
    let mut out: Vec<KernelChoice> = specs
        .iter()
        .filter_map(|(name, entry)| {
            let dir = entry.get("resource_dir").and_then(Value::as_str).map(PathBuf::from);
            let mut choice = parse_kernel_json(name, dir.as_deref(), entry.get("spec")?)?;
            choice.source = KernelSource::Jupyter;
            Some(choice)
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The interpreter a Python kernelspec runs, when its `argv` names one by path.
fn python_of(choice: &KernelChoice) -> Option<String> {
    let first = choice.argv.first()?;
    let is_python = Path::new(first)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("python"));
    (is_python && Path::new(first).is_absolute()).then(|| first.clone())
}

/// Whether `program` is a bare `python`, `python3`, `python3.12` — a name `jupyter_client` would
/// replace with the Python running Jupyter.
fn is_bare_python(program: &str) -> bool {
    let rest = match program.strip_prefix("python") {
        Some(rest) => rest,
        None => return false,
    };
    !program.contains(['/', '\\']) && rest.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// The Python next to a kernelspec installed into an environment: `<prefix>/share/jupyter/kernels/
/// <name>` belongs to the interpreter at `<prefix>/bin/python3`.
fn prefix_python(resource_dir: &Path) -> Option<PathBuf> {
    let kernels = resource_dir.parent()?;
    let share = kernels.parent()?.parent()?;
    let prefix = share.parent()?;
    python_in(prefix)
}

/// The interpreter inside an environment prefix or a virtualenv, if there is one.
fn python_in(prefix: &Path) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["Scripts/python.exe", "python.exe"]
    } else {
        &["bin/python3", "bin/python"]
    };
    candidates.iter().map(|rel| prefix.join(rel)).find(|path| path.is_file())
}

/// Gives a kernelspec whose `argv` starts with a bare `python` the interpreter it belongs to, the
/// way `jupyter_client` does: the environment the spec was installed into, else the Python behind
/// the `jupyter` that listed it. Left alone when neither is known — `PATH` decides then.
pub fn resolve_bare_python(choice: &mut KernelChoice, jupyter_python: Option<&Path>) {
    let Some(first) = choice.argv.first() else { return };
    if !is_bare_python(first) {
        return;
    }
    let resolved = choice
        .resource_dir
        .as_deref()
        .and_then(|dir| prefix_python(Path::new(dir)))
        .or_else(|| jupyter_python.map(Path::to_path_buf));
    if let Some(python) = resolved {
        choice.argv[0] = python.to_string_lossy().into_owned();
        choice.python = Some(choice.argv[0].clone());
    }
}

/// `jupyter_core`'s kernel directories, in its order of precedence: `JUPYTER_PATH`, the user's
/// data dir (or `JUPYTER_DATA_DIR`), then the system dirs.
pub fn kernel_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(extra) = std::env::var_os("JUPYTER_PATH") {
        dirs.extend(std::env::split_paths(&extra).filter(|p| !p.as_os_str().is_empty()));
    }
    if let Some(data) = std::env::var_os("JUPYTER_DATA_DIR").filter(|v| !v.is_empty()) {
        dirs.push(PathBuf::from(data));
    } else if let Some(data) = user_data_dir() {
        dirs.push(data);
    }
    dirs.extend(system_dirs());
    dirs.into_iter().map(|dir| dir.join("kernels")).collect()
}

fn user_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|home| home.join("Library").join("Jupyter"))
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join("jupyter"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_DATA_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("share")))
            .map(|base| base.join("jupyter"))
    }
}

fn system_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("PROGRAMDATA")
            .map(|data| vec![PathBuf::from(data).join("jupyter")])
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut dirs = vec![PathBuf::from("/usr/local/share/jupyter"), PathBuf::from("/usr/share/jupyter")];
        // Homebrew's prefix on Apple silicon, where `brew install jupyterlab` registers its kernel.
        if cfg!(target_os = "macos") {
            dirs.push(PathBuf::from("/opt/homebrew/share/jupyter"));
        }
        dirs
    }
}

/// Every kernelspec in `dirs`, the first of each name winning — `jupyter_core`'s precedence.
pub fn scan_kernel_dirs(dirs: &[PathBuf]) -> Vec<KernelChoice> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut names: Vec<(String, PathBuf)> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
            .collect();
        names.sort();
        for (name, path) in names {
            if seen.contains(&name) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path.join("kernel.json")) else { continue };
            let Ok(spec) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(choice) = parse_kernel_json(&name, Some(&path), &spec) {
                seen.insert(name);
                out.push(choice);
            }
        }
    }
    out
}

/// The virtualenvs a notebook in `notebook_dir` would conventionally use: `.venv`, `venv` or `env`
/// in its own folder or any folder above it, stopping at `root` (the repository) — the nearest one
/// first.
pub fn venv_pythons(notebook_dir: &Path, root: &Path) -> Vec<(PathBuf, String)> {
    let mut out = Vec::new();
    let mut dir = Some(notebook_dir);
    while let Some(current) = dir {
        for name in VENV_DIRS {
            let venv = current.join(name);
            if let Some(python) = python_in(&venv) {
                let label = match venv.strip_prefix(root) {
                    Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                    Err(_) => name.to_string(),
                };
                out.push((python, label));
            }
        }
        if current == root {
            break;
        }
        dir = current.parent().filter(|parent| parent.starts_with(root));
    }
    out
}

/// A program on `PATH`, as the first existing file of that name.
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(program)).find(|candidate| candidate.is_file())
}

/// The Pythons on `PATH` worth probing.
fn path_pythons() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["python.exe", "python3.exe"] } else { &["python3"] };
    let mut out = Vec::new();
    for name in names {
        let Some(found) = which(name) else { continue };
        // Windows ships a `python.exe` in WindowsApps that opens the Microsoft Store instead of
        // running anything.
        if found.to_string_lossy().contains("WindowsApps") {
            continue;
        }
        // macOS's `/usr/bin/python3` is a stub until the Command Line Tools are installed, and
        // running it then puts up the "install the developer tools?" dialog — not something a kernel
        // list may do. It is a real Python only when the tools are there.
        if cfg!(target_os = "macos") && found == Path::new("/usr/bin/python3") && !developer_tools_installed() {
            continue;
        }
        out.push(found);
    }
    out
}

fn developer_tools_installed() -> bool {
    Path::new("/Library/Developer/CommandLineTools/usr/bin/python3").is_file()
        || crate::proc::std_command("xcode-select")
            .arg("-p")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
}

/// The Python a `jupyter` script runs under, read off its shebang.
fn shebang_python(script: &Path) -> Option<PathBuf> {
    let text = std::fs::read(script).ok()?;
    let first = text.split(|b| *b == b'\n').next()?;
    let line = std::str::from_utf8(first).ok()?.strip_prefix("#!")?.trim();
    let program = line.split_whitespace().next()?;
    let path = PathBuf::from(program);
    (path.is_absolute() && path.is_file()).then_some(path)
}

/// What an interpreter answered when asked for its version and for ipykernel.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    pub version: String,
    pub has_ipykernel: bool,
}

/// Reads a probe's output: the version on the first line; ipykernel importable when it exited 0.
pub fn read_probe(success: bool, stdout: &str) -> Option<Probe> {
    let version = stdout.lines().next()?.trim();
    if version.is_empty() || !version.chars().next()?.is_ascii_digit() {
        return None;
    }
    Some(Probe { version: version.to_string(), has_ipykernel: success })
}

/// Asks an interpreter for its version and whether it can import ipykernel. `None` when it could
/// not be run at all.
pub async fn probe_python(python: &Path) -> Option<Probe> {
    let mut cmd = crate::proc::command(python);
    cmd.args(["-c", "import sys; print('%d.%d.%d' % sys.version_info[:3]); sys.stdout.flush(); import ipykernel"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await.ok()?.ok()?;
    read_probe(output.status.success(), &String::from_utf8_lossy(&output.stdout))
}

/// A kernel for an interpreter that has ipykernel — what `python -m ipykernel install` would have
/// registered, without anyone having to run it.
pub fn python_kernel(python: &Path, label: &str, version: &str, source: KernelSource) -> KernelChoice {
    let path = python.to_string_lossy().into_owned();
    KernelChoice {
        id: format!("python:{path}"),
        name: "python3".to_string(),
        display_name: format!("Python {version} ({label})"),
        language: "python".to_string(),
        argv: vec![path.clone(), "-m".into(), "ipykernel_launcher".into(), "-f".into(), "{connection_file}".into()],
        env: BTreeMap::new(),
        interrupt_mode: InterruptMode::Signal,
        source,
        resource_dir: None,
        python: Some(path),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Everything a notebook in `notebook_dir` (inside the repository at `root`) could run on.
pub async fn discover(notebook_dir: &Path, root: &Path) -> KernelDiscovery {
    let jupyter = which(if cfg!(windows) { "jupyter.exe" } else { "jupyter" });
    let jupyter_python = jupyter.as_deref().and_then(shebang_python);

    // 1. Jupyter's own list, then 2. the directories behind it — first of each name wins.
    let mut kernels: Vec<KernelChoice> = Vec::new();
    if let Some(jupyter) = &jupyter {
        let mut cmd = crate::proc::command(jupyter);
        cmd.args(["kernelspec", "list", "--json"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        if let Ok(Ok(output)) = tokio::time::timeout(PROBE_TIMEOUT, cmd.output()).await {
            if output.status.success() {
                kernels.extend(parse_kernelspec_list(&String::from_utf8_lossy(&output.stdout)));
            }
        }
    }
    let dirs = kernel_dirs();
    for choice in tokio::task::spawn_blocking(move || scan_kernel_dirs(&dirs)).await.unwrap_or_default() {
        if !kernels.iter().any(|known| known.name == choice.name) {
            kernels.push(choice);
        }
    }
    for choice in &mut kernels {
        resolve_bare_python(choice, jupyter_python.as_deref());
    }

    // 3. Interpreters nobody registered: the project's virtualenvs first, then `PATH`.
    let mut pythons: Vec<(PathBuf, String, KernelSource)> = venv_pythons(notebook_dir, root)
        .into_iter()
        .map(|(python, label)| (python, label, KernelSource::Venv))
        .collect();
    for python in path_pythons() {
        pythons.push((python, "PATH".to_string(), KernelSource::Path));
    }
    let mut unique: Vec<(PathBuf, String, KernelSource)> = Vec::new();
    for entry in pythons {
        if !unique.iter().any(|(known, _, _)| same_file(known, &entry.0)) {
            unique.push(entry);
        }
    }
    let probes = futures_util::future::join_all(unique.iter().map(|(python, _, _)| probe_python(python))).await;

    let mut discovery = KernelDiscovery { kernels, without_ipykernel: Vec::new() };
    for ((python, label, source), probe) in unique.into_iter().zip(probes) {
        let Some(probe) = probe else { continue };
        // A kernelspec that already runs this interpreter is the same kernel under the name
        // somebody gave it.
        let registered = discovery
            .kernels
            .iter()
            .any(|known| known.python.as_deref().is_some_and(|p| same_file(Path::new(p), &python)));
        if probe.has_ipykernel {
            if !registered {
                discovery.kernels.push(python_kernel(&python, &label, &probe.version, source));
            }
        } else {
            discovery.without_ipykernel.push(PythonCandidate {
                path: python.to_string_lossy().into_owned(),
                label,
                version: Some(probe.version),
                source,
            });
        }
    }
    discovery
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-kernelspec-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_kernel_json() {
        let spec = json!({
            "argv": ["/opt/venv/bin/python", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            "display_name": "Python 3 (ipykernel)",
            "language": "python",
            "interrupt_mode": "signal",
            "env": {"PYTHONUNBUFFERED": "1", "N": 2},
            "metadata": {"debugger": true}
        });
        let choice = parse_kernel_json("python3", Some(Path::new("/k/python3")), &spec).unwrap();
        assert_eq!(choice.id, "spec:python3");
        assert_eq!(choice.display_name, "Python 3 (ipykernel)");
        assert_eq!(choice.language, "python");
        assert_eq!(choice.interrupt_mode, InterruptMode::Signal);
        assert_eq!(choice.env.get("PYTHONUNBUFFERED").map(String::as_str), Some("1"));
        assert_eq!(choice.env.get("N").map(String::as_str), Some("2"));
        assert_eq!(choice.python.as_deref(), Some("/opt/venv/bin/python"));
        assert_eq!(choice.resource_dir.as_deref(), Some("/k/python3"));
    }

    #[test]
    fn message_mode_and_defaults() {
        let spec = json!({"argv": ["ir", "--connection", "{connection_file}"], "interrupt_mode": "message"});
        let choice = parse_kernel_json("ir", None, &spec).unwrap();
        assert_eq!(choice.interrupt_mode, InterruptMode::Message);
        assert_eq!(choice.display_name, "ir", "a spec without a display name shows its name");
        assert_eq!(choice.language, "");
        assert_eq!(choice.python, None);
    }

    #[test]
    fn a_spec_without_argv_is_not_a_kernel() {
        assert!(parse_kernel_json("x", None, &json!({"display_name": "X"})).is_none());
        assert!(parse_kernel_json("x", None, &json!({"argv": []})).is_none());
        assert!(parse_kernel_json("x", None, &json!({"argv": ["a", 3]})).is_none());
    }

    #[test]
    fn reads_jupyters_own_list() {
        let listing = json!({
            "kernelspecs": {
                "python3": {
                    "resource_dir": "/usr/local/share/jupyter/kernels/python3",
                    "spec": {"argv": ["python", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                             "display_name": "Python 3", "language": "python"}
                },
                "julia-1.10": {
                    "resource_dir": "/home/u/.local/share/jupyter/kernels/julia-1.10",
                    "spec": {"argv": ["julia", "-i", "{connection_file}"], "display_name": "Julia 1.10",
                             "language": "julia", "interrupt_mode": "message"}
                },
                "broken": {"resource_dir": "/x", "spec": {"display_name": "no argv"}}
            }
        })
        .to_string();
        let kernels = parse_kernelspec_list(&listing);
        assert_eq!(kernels.iter().map(|k| k.name.as_str()).collect::<Vec<_>>(), ["julia-1.10", "python3"]);
        assert!(kernels.iter().all(|k| k.source == KernelSource::Jupyter));
        assert_eq!(kernels[0].interrupt_mode, InterruptMode::Message);
        assert!(parse_kernelspec_list("not json").is_empty());
    }

    #[test]
    fn scans_kernel_directories_first_name_wins() {
        let user = temp_dir("user");
        let system = temp_dir("system");
        for (root, display) in [(&user, "User Python"), (&system, "System Python")] {
            let dir = root.join("python3");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("kernel.json"),
                json!({"argv": ["python3", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
                       "display_name": display, "language": "python"})
                .to_string(),
            )
            .unwrap();
        }
        let other = system.join("deno");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("kernel.json"), json!({"argv": ["deno", "jupyter"], "language": "typescript"}).to_string())
            .unwrap();
        // A folder without a kernel.json is not a kernel.
        std::fs::create_dir_all(system.join("empty")).unwrap();

        let found = scan_kernel_dirs(&[user.clone(), system.clone(), user.join("missing")]);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].display_name, "User Python");
        assert_eq!(found[1].name, "deno");
        std::fs::remove_dir_all(&user).unwrap();
        std::fs::remove_dir_all(&system).unwrap();
    }

    #[test]
    fn a_bare_python_resolves_to_its_environment() {
        let prefix = temp_dir("prefix");
        let bin = prefix.join(if cfg!(windows) { "Scripts" } else { "bin" });
        std::fs::create_dir_all(&bin).unwrap();
        let python = bin.join(if cfg!(windows) { "python.exe" } else { "python3" });
        std::fs::write(&python, "").unwrap();
        let resource = prefix.join("share").join("jupyter").join("kernels").join("python3");
        std::fs::create_dir_all(&resource).unwrap();

        let spec = json!({"argv": ["python", "-m", "ipykernel_launcher", "-f", "{connection_file}"]});
        let mut choice = parse_kernel_json("python3", Some(&resource), &spec).unwrap();
        resolve_bare_python(&mut choice, None);
        assert_eq!(PathBuf::from(&choice.argv[0]), python);
        assert_eq!(choice.python.as_deref(), Some(choice.argv[0].as_str()));

        // No environment beside it: Jupyter's own Python.
        let mut elsewhere = parse_kernel_json("python3", Some(Path::new("/nowhere/k/python3")), &spec).unwrap();
        resolve_bare_python(&mut elsewhere, Some(Path::new("/opt/jupyter/bin/python3")));
        assert_eq!(elsewhere.argv[0], "/opt/jupyter/bin/python3");

        // A path is not a bare name, and neither is another program.
        for argv0 in ["/usr/bin/python3", "julia", "pythonista"] {
            let mut other = parse_kernel_json("k", None, &json!({"argv": [argv0]})).unwrap();
            resolve_bare_python(&mut other, Some(Path::new("/opt/jupyter/bin/python3")));
            assert_eq!(other.argv[0], argv0);
        }
        std::fs::remove_dir_all(&prefix).unwrap();
    }

    #[test]
    fn finds_the_nearest_virtualenv_up_to_the_repository() {
        let root = temp_dir("repo");
        let nested = root.join("analysis").join("2026");
        std::fs::create_dir_all(&nested).unwrap();
        let make = |venv: PathBuf| {
            let bin = venv.join(if cfg!(windows) { "Scripts" } else { "bin" });
            std::fs::create_dir_all(&bin).unwrap();
            let python = bin.join(if cfg!(windows) { "python.exe" } else { "python3" });
            std::fs::write(&python, "").unwrap();
            python
        };
        let near = make(root.join("analysis").join("venv"));
        let top = make(root.join(".venv"));
        // Above the repository: not this project's.
        let _outside = root.parent().map(|parent| parent.join(".venv"));

        let found = venv_pythons(&nested, &root);
        assert_eq!(found, vec![(near, "analysis/venv".to_string()), (top, ".venv".to_string())]);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_what_a_probe_printed() {
        assert_eq!(
            read_probe(true, "3.12.4\n"),
            Some(Probe { version: "3.12.4".into(), has_ipykernel: true })
        );
        assert_eq!(
            read_probe(false, "3.9.6\n"),
            Some(Probe { version: "3.9.6".into(), has_ipykernel: false })
        );
        // Nothing printed: the program is not a Python that ran.
        assert_eq!(read_probe(false, ""), None);
        assert_eq!(read_probe(true, "Python was not found; run without arguments"), None);
    }

    #[test]
    fn an_interpreter_becomes_an_ipykernel_command() {
        let choice = python_kernel(Path::new("/p/.venv/bin/python3"), ".venv", "3.12.4", KernelSource::Venv);
        assert_eq!(choice.id, "python:/p/.venv/bin/python3");
        assert_eq!(choice.name, "python3");
        assert_eq!(choice.display_name, "Python 3.12.4 (.venv)");
        assert_eq!(choice.argv, ["/p/.venv/bin/python3", "-m", "ipykernel_launcher", "-f", "{connection_file}"]);
    }

    #[test]
    fn bare_python_names() {
        assert!(is_bare_python("python"));
        assert!(is_bare_python("python3"));
        assert!(is_bare_python("python3.12"));
        assert!(!is_bare_python("python3-config"));
        assert!(!is_bare_python("/usr/bin/python3"));
        assert!(!is_bare_python("ipython"));
    }
}
