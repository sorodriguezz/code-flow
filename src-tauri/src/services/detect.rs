//! What a folder can run, read from the files that say so.
//!
//! The editor used to open on an empty command box, which put the whole job on the person: know
//! the package manager, remember the script's name, work out the subfolder. Every one of those is
//! written down in the repository already — a lockfile names the package manager, `package.json`
//! lists the scripts, a compose file lists the containers — so this reads them and proposes the
//! command a person would have typed. It proposes; the form still takes anything.
//!
//! Deliberately shallow: the repository itself, every folder directly inside it — a `backend/`
//! beside a `frontend/` is the commonest layout there is — the folders inside the conventional
//! monorepo containers (`apps/`, `packages/`, `services/`, `src/`, `modules/`), and whatever
//! workspaces a monorepo or a JVM build declares. Walking a whole checkout would find the
//! `package.json` of every dependency ever vendored, and a suggestion list nobody can scan is worse
//! than none.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

/// One thing the folder can run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// A service name to start from: the package or folder, and the script when it is not the
    /// obvious one.
    pub name: String,
    pub command: String,
    /// Where to run it, relative to the folder that was scanned. Empty is the folder itself.
    pub cwd: String,
    /// `script` | `compose` | `shell` — what the service's `kind` becomes.
    pub kind: String,
    /// The file it was read from, for the row's second line.
    pub source: String,
    /// What the file says the command does: a script's body, a compose file's services.
    pub detail: String,
    /// The gate this kind of command wants. `exit` for one-shots (migrations, seeds), `auto` for
    /// everything else — which finds the port by itself.
    pub ready_kind: String,
    /// Ports the files mention (`--port 3000`, a compose `ports:` entry, `server.port`). A hint for
    /// the form, not what the gate waits on.
    pub ports: Vec<u16>,
    /// Ports the service has to be *told* about, because nothing in its process tree will ever
    /// listen on them: what a `docker run -p` publishes is held by Docker. They become the
    /// service's pinned ports, which its gate probes and its row shows. Empty for everything else.
    pub pinned_ports: Vec<u16>,
    /// How likely this is to be *the* thing to run here. Higher first.
    pub score: u32,
}

/// Folders that never hold a project of their own: build output, installed dependencies, caches,
/// and the files a web app serves.
const SKIP_DIRS: [&str; 21] = [
    "node_modules", "target", "build", "dist", "out", "vendor", "venv", "env", "__pycache__", "bin", "obj",
    "tmp", "temp", "coverage", "logs", "log", "Pods", "DerivedData", "public", "static", "assets",
];

/// Folders whose children are the projects — the monorepo conventions, and `src/` for .NET
/// solutions (`src/Api/Api.csproj`).
const CONTAINERS: [&str; 5] = ["apps", "packages", "services", "src", "modules"];

/// The most folders one repository is read in. A checkout with more top-level folders than this is
/// not a set of services.
const MAX_DIRS: usize = 60;

/// Every candidate in `root`, best first. Never fails: a folder that cannot be read has nothing to
/// suggest.
pub fn detect(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    let folder_name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app".to_string());
    let dirs = project_dirs(root);

    // Node. A workspace package runs with the root's package manager; a folder with a lockfile of
    // its own is a separate project, and says for itself.
    let root_manager = declared_manager(root).unwrap_or_else(|| "npm".to_string());
    let mut node_dirs = node_package_dirs(root);
    node_dirs.extend(dirs.iter().filter(|d| d.join("package.json").is_file()).cloned());
    let mut seen_dirs = HashSet::new();
    node_dirs.retain(|d| seen_dirs.insert(d.clone()));
    for dir in &node_dirs {
        let manager = if dir == root { root_manager.clone() } else { declared_manager(dir).unwrap_or_else(|| root_manager.clone()) };
        out.extend(node_candidates(root, dir, &manager, &folder_name));
    }

    // Everything else, folder by folder. A JVM build speaks for its modules, so a folder it covers
    // is not read a second time on its own — that would offer `mvn spring-boot:run` inside a module
    // beside the `-pl` form that actually resolves its sibling modules.
    let mut covered: HashSet<PathBuf> = HashSet::new();
    for dir in &dirs {
        let rel = relative(root, dir);
        let name = if rel.is_empty() { folder_name.clone() } else { last_segment(&rel) };
        let mut found = Vec::new();
        found.extend(compose_candidates(dir, &name, rel.is_empty()));
        found.extend(dockerfile_candidates(dir, &name));
        found.extend(procfile_candidates(dir));
        found.extend(make_candidates(dir, &name));
        found.extend(other_candidates(dir, &name));
        found.extend(dotnet_candidates(dir));
        if !covered.contains(dir) {
            let (jvm, modules) = jvm_candidates(dir, &name);
            found.extend(jvm);
            covered.extend(modules);
        }
        for mut candidate in found {
            candidate.cwd = join_rel(&rel, &candidate.cwd);
            // Named from the repository's root, the way a nested `package.json` already is:
            // `pom.xml` alone does not say which of two it was read from.
            candidate.source = join_rel(&rel, &candidate.source);
            if !rel.is_empty() {
                // Just under the same thing at the root, so a repository's own entry point leads.
                candidate.score = candidate.score.saturating_sub(5);
            }
            out.push(candidate);
        }
    }

    // One entry per command and folder: a `dev` script reachable both as a workspace package and
    // through the conventional `apps/` scan must not be offered twice.
    let mut seen = HashSet::new();
    out.retain(|c| seen.insert((c.cwd.clone(), c.command.clone())));
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.cwd.cmp(&b.cwd)).then(a.name.cmp(&b.name)));
    out
}

/// The folders read for a project: the root, each folder directly in it, and each folder inside
/// the conventional containers. Root first, then by depth, then by name — the order the JVM
/// coverage above relies on.
fn project_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    let children = subfolders(root);
    dirs.extend(children.iter().cloned());
    for child in &children {
        let is_container = child
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| CONTAINERS.contains(&n));
        if is_container {
            dirs.extend(subfolders(child));
        }
    }
    dirs.truncate(MAX_DIRS);
    dirs
}

/// The folders directly inside `dir` that could be a project: not hidden, not build output or
/// dependencies, and not a symlink — `file_type` does not follow one, so a link back up the tree
/// cannot turn this into a walk.
fn subfolders(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
        })
        .collect();
    out.sort();
    out
}

/// The command that runs `script` with this package manager.
fn run_script(manager: &str, script: &str) -> String {
    match manager {
        "npm" => format!("npm run {script}"),
        "bun" => format!("bun run {script}"),
        other => format!("{other} {script}"),
    }
}

/// Which package manager a folder says it uses: the `packageManager` field when it has one, else
/// its lockfile. `None` when it says nothing — a workspace package, which runs with the root's.
fn declared_manager(dir: &Path) -> Option<String> {
    if let Some(declared) = read_json(&dir.join("package.json"))
        .and_then(|pkg| pkg.get("packageManager").and_then(Value::as_str).map(str::to_string))
    {
        for known in ["pnpm", "yarn", "bun", "npm"] {
            if declared.starts_with(known) {
                return Some(known.to_string());
            }
        }
    }
    for (file, manager) in [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("bun.lock", "bun"),
        ("package-lock.json", "npm"),
    ] {
        if dir.join(file).is_file() {
            return Some(manager.to_string());
        }
    }
    None
}

/// The folders holding a `package.json` a monorepo declares: the root, its workspaces, and the
/// conventional monorepo folders one level down. Capped, and never inside `node_modules`.
fn node_package_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if root.join("package.json").is_file() {
        dirs.push(root.to_path_buf());
    }
    let mut patterns: Vec<String> = Vec::new();
    if let Some(pkg) = read_json(&root.join("package.json")) {
        let declared = pkg.get("workspaces").and_then(|w| w.as_array().or_else(|| w.get("packages")?.as_array()));
        for entry in declared.into_iter().flatten() {
            if let Some(pattern) = entry.as_str() {
                patterns.push(pattern.to_string());
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(root.join("pnpm-workspace.yaml")) {
        patterns.extend(pnpm_workspace_patterns(&text));
    }
    patterns.extend(["apps/*", "packages/*", "services/*"].map(String::from));

    for pattern in patterns {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.starts_with('!') || pattern.contains("node_modules") {
            continue;
        }
        // `apps/*` and `apps/**` both mean "each folder in apps" at the depth this looks.
        let base = pattern.trim_end_matches("/**").trim_end_matches("/*");
        if base.contains('*') {
            continue;
        }
        let base_dir = root.join(base);
        if pattern.ends_with('*') {
            let Ok(entries) = std::fs::read_dir(&base_dir) else { continue };
            let mut found: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.join("package.json").is_file())
                .collect();
            found.sort();
            dirs.extend(found);
        } else if base_dir.join("package.json").is_file() {
            dirs.push(base_dir);
        }
        if dirs.len() > 40 {
            break;
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs.truncate(40);
    dirs
}

/// The `packages:` list of a `pnpm-workspace.yaml`. Read by line: the file is a list of quoted
/// globs, and pulling in a YAML parser for it would be a dependency for four lines of format.
fn pnpm_workspace_patterns(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('-') {
            inside = trimmed.starts_with("packages:");
            continue;
        }
        if inside {
            if let Some(item) = trimmed.strip_prefix('-') {
                out.push(item.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
            }
        }
    }
    out
}

/// How much a script name sounds like "the thing you run to work on this". `None` for scripts that
/// are not a service at all — builds, tests, linters — which are the majority of any `scripts`.
fn script_score(name: &str) -> Option<u32> {
    let score = match name {
        "dev" => 100,
        "start:dev" | "dev:start" => 95,
        "develop" | "serve:dev" => 90,
        "serve" => 85,
        "start" => 80,
        "watch" | "dev:watch" => 60,
        "storybook" => 55,
        "preview" => 40,
        _ if name.starts_with("dev:") && !name.contains("build") => 70,
        _ if name.starts_with("start:") && !name.contains("prod") => 65,
        "migrate" | "db:migrate" | "prisma:migrate" | "seed" | "db:seed" => 30,
        _ => return None,
    };
    Some(score)
}

/// Whether a script is a one-shot (a migration, a seed) that a service should wait to *finish*.
fn is_one_shot(name: &str) -> bool {
    name.contains("migrate") || name.contains("seed")
}

fn node_candidates(root: &Path, dir: &Path, manager: &str, folder_name: &str) -> Vec<Candidate> {
    let Some(pkg) = read_json(&dir.join("package.json")) else { return Vec::new() };
    let Some(scripts) = pkg.get("scripts").and_then(Value::as_object) else { return Vec::new() };
    let rel = relative(root, dir);
    let base_name = pkg
        .get("name")
        .and_then(Value::as_str)
        .map(|n| n.rsplit('/').next().unwrap_or(n).to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| if rel.is_empty() { folder_name.to_string() } else { last_segment(&rel) });

    let mut picked: Vec<(u32, String, String)> = scripts
        .iter()
        .filter_map(|(name, body)| Some((script_score(name)?, name.clone(), body.as_str().unwrap_or("").to_string())))
        .collect();
    picked.sort_by(|a, b| b.0.cmp(&a.0));
    let primary = picked.first().map(|p| p.1.clone());

    picked
        .into_iter()
        .map(|(score, script, body)| {
            let name = if Some(&script) == primary.as_ref() {
                base_name.clone()
            } else {
                format!("{base_name}-{}", script.replace(':', "-"))
            };
            Candidate {
                name,
                command: run_script(manager, &script),
                cwd: rel.clone(),
                kind: "script".into(),
                source: if rel.is_empty() { "package.json".into() } else { format!("{rel}/package.json") },
                ports: ports_in(&body),
                ready_kind: if is_one_shot(&script) { "exit".into() } else { "auto".into() },
                detail: body,
                // A nested package ranks just under the same script at the root, so a monorepo's
                // own `dev` (usually a turbo fan-out) still leads.
                score: if rel.is_empty() { score } else { score.saturating_sub(5) },
                ..Default::default()
            }
        })
        .collect()
}

/// Ports a command line names: `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000`.
fn ports_in(command: &str) -> Vec<u16> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let mut out = Vec::new();
    for (i, word) in words.iter().enumerate() {
        let value = if let Some(v) = word.strip_prefix("--port=").or_else(|| word.strip_prefix("PORT=")) {
            Some(v)
        } else if matches!(*word, "--port" | "-p") {
            words.get(i + 1).copied()
        } else {
            None
        };
        if let Some(port) = value.and_then(|v| v.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u16>().ok()) {
            if port > 0 && !out.contains(&port) {
                out.push(port);
            }
        }
    }
    out
}

const COMPOSE_FILES: [&str; 4] = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

/// Compose stacks: the file in `dir`, and — at a repository's root — in the folders stacks are
/// usually kept in. Each stack is offered whole, each of its containers alone, and each everyday
/// variant file (`docker-compose.dev.yml`) layered over it.
fn compose_candidates(dir: &Path, folder_name: &str, deep: bool) -> Vec<Candidate> {
    let mut out = Vec::new();
    let places: &[&str] = if deep { &["", "docker", "infra", "deploy", ".devcontainer"] } else { &[""] };
    for dir_rel in places {
        let here = if dir_rel.is_empty() { dir.to_path_buf() } else { dir.join(dir_rel) };
        let label = if dir_rel.is_empty() { format!("{folder_name}-docker") } else { format!("{folder_name}-{dir_rel}") }
            .replace("-.", "-");
        let source_of = |file: &str| if dir_rel.is_empty() { file.to_string() } else { format!("{dir_rel}/{file}") };

        let base = COMPOSE_FILES.iter().copied().find(|f| here.join(f).is_file());
        let base_services = base
            .and_then(|file| std::fs::read_to_string(here.join(file)).ok())
            .map(|text| compose_services(&text))
            .unwrap_or_default();
        if let Some(file) = base.filter(|_| !base_services.is_empty()) {
            let names: Vec<&str> = base_services.iter().map(|s| s.0.as_str()).collect();
            out.push(Candidate {
                name: label.clone(),
                command: "docker compose up".into(),
                cwd: dir_rel.to_string(),
                kind: "compose".into(),
                source: source_of(file),
                detail: names.join(", "),
                ready_kind: "auto".into(),
                ports: base_services.iter().flat_map(|s| s.1.iter().copied()).collect(),
                score: 75,
                ..Default::default()
            });
            // Each container on its own too, for the common case of wanting only the database out
            // of a file that also defines the app.
            if base_services.len() > 1 {
                for (service, ports) in &base_services {
                    out.push(Candidate {
                        name: service.clone(),
                        command: format!("docker compose up {service}"),
                        cwd: dir_rel.to_string(),
                        kind: "compose".into(),
                        source: source_of(file),
                        detail: service.clone(),
                        ready_kind: "auto".into(),
                        ports: ports.clone(),
                        score: 45,
                        ..Default::default()
                    });
                }
            }
        }

        for (file, variant) in compose_variants(&here) {
            let Ok(text) = std::fs::read_to_string(here.join(&file)) else { continue };
            let mut services = base_services.clone();
            for (service, ports) in compose_services(&text) {
                match services.iter_mut().find(|s| s.0 == service) {
                    Some(existing) => existing.1.extend(ports.into_iter().filter(|p| !existing.1.contains(p)).collect::<Vec<_>>()),
                    None => services.push((service, ports)),
                }
            }
            if services.is_empty() {
                continue;
            }
            // Layered over the base file when there is one, which is what a variant file is for in
            // Compose's own model; standalone when it is the only file.
            let command = match base {
                Some(base_file) => format!("docker compose -f {base_file} -f {file} up"),
                None => format!("docker compose -f {file} up"),
            };
            let everyday = matches!(variant.as_str(), "dev" | "development" | "local");
            out.push(Candidate {
                name: format!("{label}-{variant}"),
                command,
                cwd: dir_rel.to_string(),
                kind: "compose".into(),
                source: source_of(&file),
                detail: services.iter().map(|s| s.0.as_str()).collect::<Vec<_>>().join(", "),
                ready_kind: "auto".into(),
                ports: services.iter().flat_map(|s| s.1.iter().copied()).collect(),
                score: if everyday { 70 } else { 50 },
                ..Default::default()
            });
        }
    }
    out
}

/// The variant compose files in `dir` worth running on a workstation — `docker-compose.dev.yml`,
/// `compose.local.yaml` — as `(file, variant)`. Not the override file, which `up` already merges
/// by itself, and not the ones named for somewhere else: production, CI, staging.
fn compose_variants(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name().to_string_lossy().into_owned();
        let lower = file.to_ascii_lowercase();
        let Some(stem) = lower.strip_suffix(".yml").or_else(|| lower.strip_suffix(".yaml")) else { continue };
        let Some(rest) = stem.strip_prefix("docker-compose").or_else(|| stem.strip_prefix("compose")) else { continue };
        let Some(variant) = rest.strip_prefix('.').or_else(|| rest.strip_prefix('-')) else { continue };
        let elsewhere = ["prod", "ci", "release", "deploy", "test", "staging", "override"];
        if variant.is_empty() || elsewhere.iter().any(|word| variant.contains(word)) {
            continue;
        }
        out.push((file, variant.to_string()));
    }
    out.sort();
    out
}

/// A compose file's services and the host ports each publishes, read by indentation.
///
/// Not a YAML parser, and it does not need to be one: `services:` is a top-level map whose keys are
/// the one level of indentation below it, and a published port is a `ports:` list item shaped
/// `"HOST:CONTAINER"` or a long-form `published:` key. Anchors, merges and extension fields are
/// skipped rather than understood, which costs at most a missing hint.
fn compose_services(text: &str) -> Vec<(String, Vec<u16>)> {
    let mut out: Vec<(String, Vec<u16>)> = Vec::new();
    let mut in_services = false;
    let mut service_indent: Option<usize> = None;
    let mut in_ports = false;
    let mut ports_indent = 0;
    for raw in text.lines() {
        let line = raw.split(" #").next().unwrap_or(raw).trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            in_services = trimmed.starts_with("services:");
            service_indent = None;
            in_ports = false;
            continue;
        }
        if !in_services {
            continue;
        }
        let service_level = *service_indent.get_or_insert(indent);
        if indent == service_level {
            in_ports = false;
            if let Some(name) = trimmed.strip_suffix(':') {
                if !name.starts_with("x-") && !name.contains(' ') {
                    out.push((name.trim_matches(|c| c == '"' || c == '\'').to_string(), Vec::new()));
                }
            }
            continue;
        }
        if indent < service_level {
            continue;
        }
        if trimmed.starts_with("ports:") {
            in_ports = true;
            ports_indent = indent;
            continue;
        }
        if in_ports && indent <= ports_indent && !trimmed.starts_with('-') {
            in_ports = false;
        }
        if !in_ports {
            continue;
        }
        let Some(current) = out.last_mut() else { continue };
        let value = trimmed.trim_start_matches('-').trim().trim_matches(|c| c == '"' || c == '\'');
        let host = if let Some(published) = value.strip_prefix("published:") {
            published.trim().trim_matches(|c| c == '"' || c == '\'').parse::<u16>().ok()
        } else {
            // `HOST:CONTAINER`, `IP:HOST:CONTAINER`, `HOST:CONTAINER/udp` — the host port is the
            // second-to-last field. A bare `CONTAINER` publishes a random host port: no hint.
            let without_proto = value.split('/').next().unwrap_or(value);
            let parts: Vec<&str> = without_proto.split(':').collect();
            if parts.len() >= 2 {
                parts[parts.len() - 2].split('-').next().and_then(|p| p.parse::<u16>().ok())
            } else {
                None
            }
        };
        if let Some(port) = host {
            if !current.1.contains(&port) {
                current.1.push(port);
            }
        }
    }
    out
}

/// A folder with a Dockerfile and nothing that says how to run it: build the image, run it, publish
/// what it `EXPOSE`s.
///
/// Only when no compose file sits beside it — a compose file already says how that image is run,
/// with which volumes and which environment, and guessing past it would be worse than asking.
/// `--init` is not decoration: the Ctrl-C that stops a service reaches the container's first
/// process, and a server running as PID 1 ignores SIGINT unless it installs a handler — the
/// container would keep running after its service was stopped. With `--init` a real init is
/// PID 1 and passes the signal on. `--rm` takes the stopped container with it.
fn dockerfile_candidates(dir: &Path, name: &str) -> Vec<Candidate> {
    if COMPOSE_FILES.iter().any(|f| dir.join(f).is_file()) || !compose_variants(dir).is_empty() {
        return Vec::new();
    }
    let Some(file) = ["Dockerfile.dev", "Dockerfile"].into_iter().find(|f| dir.join(f).is_file()) else {
        return Vec::new();
    };
    let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
    let exposed = exposed_ports(&text);
    let image = format!("{}:local", image_name(name));
    let dockerfile = if file == "Dockerfile" { String::new() } else { format!(" -f {file}") };
    let publish: String = exposed.iter().map(|port| format!(" -p {port}:{port}")).collect();
    vec![Candidate {
        name: format!("{name}-docker"),
        command: format!("docker build{dockerfile} -t {image} . && docker run --rm --init{publish} {image}"),
        cwd: String::new(),
        kind: "shell".into(),
        source: file.into(),
        detail: if exposed.is_empty() {
            "Dockerfile".into()
        } else {
            format!("EXPOSE {}", exposed.iter().map(u16::to_string).collect::<Vec<_>>().join(" "))
        },
        ready_kind: "auto".into(),
        ports: exposed.clone(),
        pinned_ports: exposed,
        // Below any way of running the code directly: a Dockerfile is as often the production
        // recipe as it is the way anyone works on the thing.
        score: 35,
    }]
}

/// The TCP ports a Dockerfile's `EXPOSE` lines name. An instruction is case-insensitive; a port
/// given as a build variable (`EXPOSE ${PORT}`) says nothing this can use.
fn exposed_ports(text: &str) -> Vec<u16> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some((instruction, rest)) = line.trim().split_once(char::is_whitespace) else { continue };
        if !instruction.eq_ignore_ascii_case("expose") {
            continue;
        }
        for word in rest.split_whitespace() {
            let (port, protocol) = word.split_once('/').unwrap_or((word, "tcp"));
            if !protocol.eq_ignore_ascii_case("tcp") {
                continue;
            }
            if let Ok(port) = port.parse::<u16>() {
                if port > 0 && !out.contains(&port) {
                    out.push(port);
                }
            }
        }
    }
    out
}

/// A folder name as a Docker image name: lowercase, and nothing Docker would refuse.
fn image_name(name: &str) -> String {
    let cleaned: String = name
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    if trimmed.is_empty() { "app".into() } else { trimmed.to_string() }
}

/// `Procfile` / `Procfile.dev` lines — each is a named command, by definition a service.
fn procfile_candidates(root: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    for file in ["Procfile.dev", "Procfile"] {
        let Ok(text) = std::fs::read_to_string(root.join(file)) else { continue };
        for line in text.lines() {
            let Some((name, command)) = line.split_once(':') else { continue };
            let (name, command) = (name.trim(), command.trim());
            if name.is_empty() || command.is_empty() || name.starts_with('#') || name.contains(' ') {
                continue;
            }
            out.push(Candidate {
                name: name.to_string(),
                command: command.to_string(),
                kind: "shell".into(),
                source: file.into(),
                detail: command.to_string(),
                ready_kind: if name == "release" { "exit".into() } else { "auto".into() },
                ports: ports_in(command),
                score: 70,
                ..Default::default()
            });
        }
        // `Procfile.dev` is the development one when both exist.
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// `make dev`, `just dev`, `task dev` — when those files define a target with a service's name.
fn make_candidates(root: &Path, folder_name: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    let runners: [(&str, &str, fn(&str) -> Vec<String>); 3] = [
        ("Makefile", "make", make_targets),
        ("justfile", "just", just_recipes),
        ("Taskfile.yml", "task", taskfile_tasks),
    ];
    for (file, runner, read) in runners {
        let Ok(text) = std::fs::read_to_string(root.join(file)) else { continue };
        for target in read(&text) {
            let Some(score) = script_score(&target).filter(|s| *s >= 60) else { continue };
            out.push(Candidate {
                name: if score >= 100 { folder_name.to_string() } else { format!("{folder_name}-{target}") },
                command: format!("{runner} {target}"),
                kind: "shell".into(),
                source: file.into(),
                detail: format!("{runner} {target}"),
                ready_kind: "auto".into(),
                score: score.saturating_sub(20),
                ..Default::default()
            });
        }
    }
    out
}

fn make_targets(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with('\t') && !l.starts_with(' ') && !l.starts_with('.'))
        .filter_map(|l| l.split_once(':').map(|(t, rest)| (t.trim(), rest)))
        .filter(|(t, rest)| !t.is_empty() && !t.contains(' ') && !t.contains('=') && !rest.starts_with('='))
        .map(|(t, _)| t.to_string())
        .collect()
}

fn just_recipes(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with(' ') && !l.starts_with('\t') && !l.starts_with('#'))
        .filter_map(|l| l.split_once(':').map(|(t, rest)| (t, rest)))
        .filter(|(_, rest)| !rest.starts_with('='))
        .filter_map(|(t, _)| t.split_whitespace().next().map(|n| n.trim_start_matches('@').to_string()))
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == ':'))
        .collect()
}

fn taskfile_tasks(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    let mut level: Option<usize> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent == 0 {
            inside = trimmed.starts_with("tasks:");
            level = None;
            continue;
        }
        if inside && indent == *level.get_or_insert(indent) {
            if let Some(name) = trimmed.strip_suffix(':') {
                out.push(name.trim_matches(|c| c == '"' || c == '\'').to_string());
            }
        }
    }
    out
}

/// What a JVM build module runs as, once it is known to be an app.
struct JvmApp {
    /// The Maven goal or Gradle task that runs it in development mode.
    goal: &'static str,
    label: &'static str,
    /// Where its framework reads the port from, and what it uses when nothing says.
    port_keys: &'static [&'static str],
    default_port: Option<u16>,
    score: u32,
}

const SPRING: JvmApp = JvmApp {
    goal: "spring-boot:run",
    label: "Spring Boot",
    port_keys: &["server.port"],
    default_port: Some(8080),
    score: 85,
};
const QUARKUS_MAVEN: JvmApp = JvmApp {
    goal: "quarkus:dev",
    label: "Quarkus",
    port_keys: &["quarkus.http.port"],
    default_port: Some(8080),
    score: 85,
};
const MICRONAUT_MAVEN: JvmApp = JvmApp {
    goal: "mn:run",
    label: "Micronaut",
    port_keys: &["micronaut.server.port"],
    default_port: Some(8080),
    score: 85,
};

/// A Maven module's app, if it is one. `strict` asks for the plugin that runs it, which is what
/// tells an app apart from the libraries beside it in a multi-module build — they use the same
/// starters, only the app declares the plugin.
fn maven_app(pom: &str, strict: bool) -> Option<JvmApp> {
    if pom.contains("<packaging>pom</packaging>") {
        return None;
    }
    if pom.contains("quarkus-maven-plugin") {
        return Some(QUARKUS_MAVEN);
    }
    if pom.contains("micronaut-maven-plugin") {
        return Some(MICRONAUT_MAVEN);
    }
    let spring = if strict { pom.contains("spring-boot-maven-plugin") } else { pom.contains("spring-boot") };
    spring.then_some(SPRING)
}

/// The `<module>` entries of an aggregator POM.
fn maven_modules(pom: &str) -> Vec<String> {
    pom.split("<module>")
        .skip(1)
        .filter_map(|rest| rest.split_once("</module>").map(|(module, _)| module.trim().to_string()))
        .filter(|module| !module.is_empty() && !module.contains(".."))
        .collect()
}

/// A Gradle build file's app, if it applies a plugin that runs one.
fn gradle_app(build: &str) -> Option<JvmApp> {
    if build.contains("io.quarkus") {
        return Some(JvmApp { goal: "quarkusDev", ..QUARKUS_MAVEN });
    }
    // Declared at the root of a multi-project build with `apply false` is a version, not an app.
    let spring = build.lines().any(|line| {
        (line.contains("org.springframework.boot") || line.contains("plugins.spring.boot")) && !line.contains("apply false")
    });
    if spring {
        return Some(JvmApp { goal: "bootRun", ..SPRING });
    }
    if build.contains("io.micronaut.application") {
        return Some(JvmApp { goal: "run", ..MICRONAUT_MAVEN });
    }
    let application = build.lines().any(|line| {
        let line = line.trim();
        line == "application"
            || line.starts_with("application {")
            || line.starts_with("application{")
            || ["id(\"application\")", "id 'application'", "id \"application\"", "plugin: 'application'", "plugin: \"application\""]
                .iter()
                .any(|form| line.contains(form))
    });
    application.then_some(JvmApp { goal: "run", label: "Gradle application", port_keys: &[], default_port: None, score: 60 })
}

/// The project paths a `settings.gradle(.kts)` includes — `include("api", ":services:worker")`,
/// `include 'api', 'worker'` — as folders relative to it.
fn gradle_includes(settings: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in settings.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("include") else { continue };
        if !rest.starts_with(['(', ' ', '\t']) {
            continue;
        }
        for piece in rest.split(',') {
            let name: String = piece
                .trim()
                .trim_start_matches('(')
                .trim_end_matches(')')
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .to_string();
            let path = name.trim_start_matches(':').replace(':', "/");
            if !path.is_empty() && path.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')) {
                out.push(path);
            }
        }
    }
    out
}

/// A Maven or Gradle build's runnable apps, and the module folders it speaks for.
///
/// A single-module build runs from its own folder. A multi-module one runs each app *from the root*
/// by module — `./mvnw -pl api spring-boot:run`, `./gradlew :api:bootRun` — because that is the
/// form that resolves the sibling modules an app depends on; running inside the module folder
/// would look for them in a local repository they were never installed to.
fn jvm_candidates(dir: &Path, name: &str) -> (Vec<Candidate>, Vec<PathBuf>) {
    let mut out = Vec::new();
    let mut covered = Vec::new();
    let candidate = |name: String, command: String, source: String, app: &JvmApp, app_dir: &Path| Candidate {
        name,
        command,
        cwd: String::new(),
        kind: "shell".into(),
        source,
        detail: app.label.into(),
        ready_kind: "auto".into(),
        ports: configured_port(app_dir, app.port_keys).or(app.default_port).into_iter().collect(),
        score: app.score,
        ..Default::default()
    };

    if let Ok(pom) = std::fs::read_to_string(dir.join("pom.xml")) {
        let mvn = if dir.join("mvnw").is_file() { "./mvnw" } else { "mvn" };
        let modules = maven_modules(&pom);
        if modules.is_empty() {
            if let Some(app) = maven_app(&pom, false) {
                out.push(candidate(name.to_string(), format!("{mvn} {}", app.goal), "pom.xml".into(), &app, dir));
            }
        } else {
            let read: Vec<(String, PathBuf, String)> = modules
                .iter()
                .filter_map(|module| {
                    let module_dir = dir.join(module);
                    covered.push(module_dir.clone());
                    let text = std::fs::read_to_string(module_dir.join("pom.xml")).ok()?;
                    Some((module.clone(), module_dir, text))
                })
                .collect();
            // An app declares the plugin that runs it. When none does — the parent applies it to
            // every module — a web starter is the next best tell.
            let mut apps: Vec<(&String, &PathBuf, JvmApp)> =
                read.iter().filter_map(|(m, d, pom)| maven_app(pom, true).map(|app| (m, d, app))).collect();
            if apps.is_empty() {
                apps = read
                    .iter()
                    .filter(|(_, _, pom)| pom.contains("spring-boot-starter-web"))
                    .map(|(m, d, _)| (m, d, SPRING))
                    .collect();
            }
            for (module, module_dir, app) in apps {
                out.push(candidate(
                    last_segment(module),
                    format!("{mvn} -pl {module} {}", app.goal),
                    format!("{module}/pom.xml"),
                    &app,
                    module_dir,
                ));
            }
        }
    }

    let build_file = |at: &Path| ["build.gradle.kts", "build.gradle"].into_iter().find(|f| at.join(f).is_file());
    let settings = ["settings.gradle.kts", "settings.gradle"]
        .into_iter()
        .find_map(|f| std::fs::read_to_string(dir.join(f)).ok());
    if build_file(dir).is_some() || settings.is_some() {
        let gradle = if dir.join("gradlew").is_file() { "./gradlew" } else { "gradle" };
        if let Some(file) = build_file(dir) {
            let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
            if let Some(app) = gradle_app(&text) {
                out.push(candidate(name.to_string(), format!("{gradle} {}", app.goal), file.into(), &app, dir));
            }
        }
        for project in settings.as_deref().map(gradle_includes).unwrap_or_default() {
            let project_dir = dir.join(&project);
            covered.push(project_dir.clone());
            let Some(file) = build_file(&project_dir) else { continue };
            let text = std::fs::read_to_string(project_dir.join(file)).unwrap_or_default();
            if let Some(app) = gradle_app(&text) {
                out.push(candidate(
                    last_segment(&project),
                    format!("{gradle} :{}:{}", project.replace('/', ":"), app.goal),
                    format!("{project}/{file}"),
                    &app,
                    &project_dir,
                ));
            }
        }
    }
    (out, covered)
}

/// The port an app's own configuration names, under any of `keys`: `server.port=8081` in
/// `application.properties`, or `server: port: 8081` in `application.yml`. A placeholder with a
/// default (`${PORT:8081}`) answers the default.
fn configured_port(dir: &Path, keys: &[&str]) -> Option<u16> {
    if keys.is_empty() {
        return None;
    }
    let resources = dir.join("src/main/resources");
    if let Ok(text) = std::fs::read_to_string(resources.join("application.properties")) {
        for line in text.lines() {
            let line = line.trim();
            let Some((key, value)) = line.split_once(['=', ':']) else { continue };
            if keys.contains(&key.trim()) {
                if let Some(port) = port_value(value) {
                    return Some(port);
                }
            }
        }
    }
    for file in ["application.yml", "application.yaml"] {
        let Ok(text) = std::fs::read_to_string(resources.join(file)) else { continue };
        for key in keys {
            if let Some(port) = yaml_value(&text, key).as_deref().and_then(port_value) {
                return Some(port);
            }
        }
    }
    None
}

/// A port written as a number, or as a `${VAR:default}` placeholder.
fn port_value(value: &str) -> Option<u16> {
    let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
    let value = match value.strip_prefix("${") {
        Some(placeholder) => placeholder.trim_end_matches('}').rsplit_once(':')?.1,
        None => value,
    };
    value.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

/// The value at a dotted path in a YAML file, read by indentation — `server:` / `  port: 8081` and
/// `server.port: 8081` both answer `server.port`. The first document that sets it wins, which is the
/// default profile in a Spring file.
fn yaml_value(text: &str, wanted: &str) -> Option<String> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    for raw in text.lines() {
        let line = raw.split(" #").next().unwrap_or(raw).trim_end();
        let trimmed = line.trim_start();
        if trimmed == "---" {
            stack.clear();
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        let Some((key, value)) = trimmed.split_once(':') else { continue };
        while stack.last().is_some_and(|(at, _)| *at >= indent) {
            stack.pop();
        }
        let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
        let value = value.trim();
        if value.is_empty() {
            stack.push((indent, key.to_string()));
            continue;
        }
        let path: Vec<&str> = stack.iter().map(|(_, k)| k.as_str()).chain(std::iter::once(key)).collect();
        if path.join(".") == wanted {
            return Some(value.to_string());
        }
    }
    None
}

/// .NET projects that run: web apps, workers and executables — not the class libraries and test
/// projects that sit beside them in any solution.
fn dotnet_candidates(dir: &Path) -> Vec<Candidate> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut projects: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".csproj") || n.ends_with(".fsproj"))
        .collect();
    projects.sort();
    let several = projects.len() > 1;
    let mut out = Vec::new();
    for file in projects {
        let text = std::fs::read_to_string(dir.join(&file)).unwrap_or_default().to_ascii_lowercase();
        if text.contains("microsoft.net.test.sdk") || text.contains("<istestproject>true") {
            continue;
        }
        let runs = ["microsoft.net.sdk.web", "microsoft.net.sdk.worker", "microsoft.net.sdk.blazorwebassembly", "<outputtype>exe</outputtype>"]
            .iter()
            .any(|marker| text.contains(marker));
        if !runs {
            continue;
        }
        let stem = file.rsplit_once('.').map(|(stem, _)| stem.to_string()).unwrap_or_else(|| file.clone());
        out.push(Candidate {
            name: stem,
            // `watch` restarts on save, which is what a service being worked on wants.
            command: if several { format!("dotnet watch run --project {file}") } else { "dotnet watch run".into() },
            kind: "shell".into(),
            source: file,
            detail: ".NET".into(),
            ready_kind: "auto".into(),
            ports: launch_ports(dir),
            score: 80,
            ..Default::default()
        });
    }
    out
}

/// The ports an ASP.NET project's `launchSettings.json` profiles listen on.
fn launch_ports(dir: &Path) -> Vec<u16> {
    let Some(settings) = read_json(&dir.join("Properties").join("launchSettings.json")) else { return Vec::new() };
    let mut out = Vec::new();
    let profiles = settings.get("profiles").and_then(Value::as_object);
    for profile in profiles.into_iter().flat_map(|p| p.values()) {
        let Some(urls) = profile.get("applicationUrl").and_then(Value::as_str) else { continue };
        for url in urls.split(';') {
            let port = url.trim().trim_end_matches('/').rsplit(':').next().and_then(|p| p.parse::<u16>().ok());
            if let Some(port) = port.filter(|p| !out.contains(p)) {
                out.push(port);
            }
        }
    }
    out
}

/// Everything that is not Node, Compose, Docker, a task runner, .NET or the JVM: one well-known
/// command per ecosystem.
fn other_candidates(root: &Path, folder_name: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    let has = |file: &str| root.join(file).exists();
    let contains = |file: &str, needle: &str| {
        std::fs::read_to_string(root.join(file)).map(|t| t.contains(needle)).unwrap_or(false)
    };
    let mut push = |command: String, source: &str, detail: &str, ports: Vec<u16>, score: u32| {
        out.push(Candidate {
            name: folder_name.to_string(),
            command,
            kind: "shell".into(),
            source: source.into(),
            detail: detail.into(),
            ready_kind: "auto".into(),
            ports,
            score,
            ..Default::default()
        });
    };

    // Python. `uv` and Poetry run the project's own interpreter; bare `python` would not.
    let python = if has("uv.lock") {
        "uv run python"
    } else if has("poetry.lock") {
        "poetry run python"
    } else {
        "python"
    };
    if has("manage.py") {
        push(format!("{python} manage.py runserver"), "manage.py", "Django", vec![8000], 85);
    }
    for (file, module) in [("main.py", "main"), ("app/main.py", "app.main"), ("src/main.py", "src.main")] {
        if contains(file, "FastAPI(") {
            // `uv run uvicorn`, `poetry run uvicorn` or plain `uvicorn`, matching the interpreter.
            let runner = python.replace("python", "uvicorn");
            push(format!("{runner} {module}:app --reload"), file, "FastAPI", vec![8000], 85);
            break;
        }
    }
    if contains("app.py", "Flask(") {
        push(format!("{python} -m flask run"), "app.py", "Flask", vec![5000], 80);
    }

    // Ruby. Rails 7's `bin/dev` runs the server *and* the asset watchers from `Procfile.dev`, which
    // is how the framework now says to work on an app — so it leads when it is there.
    if has("bin/rails") {
        if has("bin/dev") {
            push("bin/dev".into(), "bin/dev", "Rails", vec![3000], 88);
        }
        push("bin/rails server".into(), "bin/rails", "Rails", vec![3000], 85);
    } else if has("config.ru") {
        push("bundle exec rackup".into(), "config.ru", "Rack", vec![9292], 75);
    }

    // PHP / Elixir. PHP's built-in server for anything with a front controller Laravel does not own.
    if has("artisan") {
        push("php artisan serve".into(), "artisan", "Laravel", vec![8000], 85);
    } else if has("composer.json") && has("public/index.php") {
        push("php -S localhost:8000 -t public".into(), "public/index.php", "PHP", vec![8000], 65);
    }
    if has("mix.exs") && contains("mix.exs", ":phoenix") {
        push("mix phx.server".into(), "mix.exs", "Phoenix", vec![4000], 85);
    }

    // Rust / Go / Deno.
    if has("Cargo.toml") && (has("src/main.rs") || contains("Cargo.toml", "[[bin]]")) {
        push("cargo run".into(), "Cargo.toml", "Rust", Vec::new(), 70);
    }
    if has("go.mod") {
        if has("main.go") {
            push("go run .".into(), "go.mod", "Go", Vec::new(), 70);
        } else if let Ok(entries) = std::fs::read_dir(root.join("cmd")) {
            let mut commands: Vec<String> = entries
                .flatten()
                .filter(|e| e.path().join("main.go").is_file())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            commands.sort();
            for command in commands.into_iter().take(6) {
                out.push(Candidate {
                    name: command.clone(),
                    command: format!("go run ./cmd/{command}"),
                    kind: "shell".into(),
                    source: format!("cmd/{command}/main.go"),
                    detail: "Go".into(),
                    ready_kind: "auto".into(),
                    score: 68,
                    ..Default::default()
                });
            }
        }
    }
    for file in ["deno.json", "deno.jsonc"] {
        let Some(deno) = read_json(&root.join(file)) else { continue };
        if let Some(tasks) = deno.get("tasks").and_then(Value::as_object) {
            for (task, body) in tasks {
                let Some(score) = script_score(task) else { continue };
                out.push(Candidate {
                    name: if score >= 100 { folder_name.to_string() } else { format!("{folder_name}-{task}") },
                    command: format!("deno task {task}"),
                    kind: "script".into(),
                    source: file.into(),
                    detail: body.as_str().unwrap_or("").to_string(),
                    ready_kind: if is_one_shot(task) { "exit".into() } else { "auto".into() },
                    ports: ports_in(body.as_str().unwrap_or("")),
                    score,
                    ..Default::default()
                });
            }
        }
        break;
    }
    out
}

fn read_json(path: &Path) -> Option<Value> {
    // Comments and trailing commas are not JSON, so a `deno.jsonc` that uses them simply offers
    // nothing rather than something half-read.
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn relative(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn last_segment(rel: &str) -> String {
    rel.rsplit('/').next().unwrap_or(rel).to_string()
}

/// `rel/inner`, where either may be empty.
fn join_rel(rel: &str, inner: &str) -> String {
    match (rel.is_empty(), inner.is_empty()) {
        (true, _) => inner.to_string(),
        (false, true) => rel.to_string(),
        (false, false) => format!("{rel}/{inner}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(files: &[(&str, &str)]) -> tempfile_dir::Dir {
        let dir = tempfile_dir::Dir::new();
        for (path, body) in files {
            let full = dir.path().join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, body).unwrap();
        }
        dir
    }

    /// A throwaway folder that removes itself, without a dev-dependency for it.
    mod tempfile_dir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("cf-detect-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Dir(path)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn find<'a>(found: &'a [Candidate], cwd: &str, command: &str) -> &'a Candidate {
        found
            .iter()
            .find(|c| c.cwd == cwd && c.command == command)
            .unwrap_or_else(|| panic!("no `{command}` in `{cwd}`: {found:#?}"))
    }

    #[test]
    fn a_dev_script_is_proposed_with_the_lockfiles_package_manager() {
        let dir = scratch(&[
            ("package.json", r#"{"name":"@acme/web","scripts":{"dev":"vite --port 5174","build":"vite build","test":"vitest"}}"#),
            ("pnpm-lock.yaml", ""),
        ]);
        let found = detect(dir.path());
        assert_eq!(found.len(), 1, "build and test are not services: {found:?}");
        assert_eq!(found[0].command, "pnpm dev");
        assert_eq!(found[0].name, "web", "the scope is dropped");
        assert_eq!(found[0].ports, vec![5174]);
        assert_eq!(found[0].ready_kind, "auto");
        assert_eq!(found[0].cwd, "");
        assert!(found[0].pinned_ports.is_empty(), "a dev server's port is found in its tree");
    }

    #[test]
    fn npm_needs_run_and_the_declared_manager_wins_over_a_lockfile() {
        let npm = scratch(&[("package.json", r#"{"scripts":{"start":"node server.js"}}"#)]);
        assert_eq!(detect(npm.path())[0].command, "npm run start");

        let declared = scratch(&[
            ("package.json", r#"{"packageManager":"yarn@4.1.0","scripts":{"dev":"next dev"}}"#),
            ("package-lock.json", "{}"),
        ]);
        assert_eq!(detect(declared.path())[0].command, "yarn dev");
    }

    #[test]
    fn a_monorepos_packages_are_found_with_their_folder() {
        let dir = scratch(&[
            ("package.json", r#"{"name":"shop","private":true,"scripts":{"dev":"turbo dev"}}"#),
            ("pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"packages/*\"\n"),
            ("pnpm-lock.yaml", ""),
            ("apps/web/package.json", r#"{"name":"@shop/web","scripts":{"dev":"next dev -p 3001","lint":"eslint ."}}"#),
            ("apps/api/package.json", r#"{"name":"api","scripts":{"start:dev":"nest start --watch","db:migrate":"prisma migrate deploy"}}"#),
            ("packages/ui/package.json", r#"{"name":"@shop/ui","scripts":{"build":"tsc"}}"#),
        ]);
        let found = detect(dir.path());
        let by_cwd = |cwd: &str| found.iter().filter(|c| c.cwd == cwd).cloned().collect::<Vec<_>>();
        assert_eq!(found[0].cwd, "", "the root's own dev leads");
        assert_eq!(by_cwd("apps/web")[0].command, "pnpm dev");
        assert_eq!(by_cwd("apps/web")[0].ports, vec![3001]);
        let api = by_cwd("apps/api");
        assert_eq!(api[0].name, "api");
        assert_eq!(api[0].command, "pnpm start:dev");
        let migrate = api.iter().find(|c| c.command == "pnpm db:migrate").expect("a migration is offered");
        assert_eq!(migrate.ready_kind, "exit", "a migration is waited on until it finishes");
        assert_eq!(migrate.name, "api-db-migrate");
        assert!(by_cwd("packages/ui").is_empty(), "a library with only a build has nothing to run");
    }

    /// The layout that used to find nothing at all: two projects side by side, neither at the root.
    #[test]
    fn a_backend_and_a_frontend_side_by_side_are_both_found() {
        let dir = scratch(&[
            ("README.md", "# shop"),
            ("frontend/package.json", r#"{"name":"shop-web","scripts":{"dev":"vite"}}"#),
            ("frontend/yarn.lock", ""),
            ("backend/pom.xml", "<project><artifactId>api</artifactId><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>"),
            ("backend/mvnw", ""),
            ("backend/src/main/resources/application.properties", "spring.application.name=api\nserver.port=${PORT:8081}\n"),
        ]);
        let found = detect(dir.path());
        let web = find(&found, "frontend", "yarn dev");
        assert_eq!(web.name, "shop-web", "its own lockfile, not npm");
        let api = find(&found, "backend", "./mvnw spring-boot:run");
        assert_eq!(api.name, "backend");
        assert_eq!(api.source, "backend/pom.xml");
        assert_eq!(api.ports, vec![8081], "the port the app's own configuration names");
        assert_eq!(api.detail, "Spring Boot");
    }

    #[test]
    fn a_compose_file_offers_the_stack_and_each_container() {
        let dir = scratch(&[(
            "docker-compose.yml",
            "version: '3.9'\nservices:\n  db:\n    image: postgres:16\n    ports:\n      - \"5432:5432\"\n  cache:\n    image: redis\n    ports:\n      - 127.0.0.1:6380:6379\n      - target: 80\n        published: 8081\n  worker:\n    build: .\nvolumes:\n  data:\n",
        )]);
        let found = detect(dir.path());
        let stack = found.iter().find(|c| c.command == "docker compose up").unwrap();
        assert_eq!(stack.detail, "db, cache, worker");
        assert_eq!(stack.ports, vec![5432, 6380, 8081]);
        assert_eq!(stack.kind, "compose");
        let db = found.iter().find(|c| c.command == "docker compose up db").unwrap();
        assert_eq!(db.ports, vec![5432]);
        assert!(found.iter().any(|c| c.command == "docker compose up worker"));
    }

    #[test]
    fn an_everyday_compose_variant_is_layered_over_the_base_file() {
        let dir = scratch(&[
            ("docker-compose.yml", "services:\n  db:\n    image: postgres\n"),
            ("docker-compose.dev.yml", "services:\n  db:\n    ports:\n      - \"5433:5432\"\n  mail:\n    image: mailhog/mailhog\n"),
            ("docker-compose.prod.yml", "services:\n  db:\n    image: postgres\n"),
            ("docker-compose.override.yml", "services:\n  db:\n    image: postgres\n"),
            ("Dockerfile", "FROM node:20\nEXPOSE 3000\n"),
        ]);
        let found = detect(dir.path());
        let dev = find(&found, "", "docker compose -f docker-compose.yml -f docker-compose.dev.yml up");
        assert_eq!(dev.detail, "db, mail");
        assert_eq!(dev.ports, vec![5433]);
        assert!(!found.iter().any(|c| c.command.contains("prod") || c.command.contains("override")), "{found:#?}");
        assert!(!found.iter().any(|c| c.command.starts_with("docker build")), "compose says how the image runs");

        let alone = scratch(&[("compose.local.yaml", "services:\n  api:\n    image: api\n")]);
        find(&detect(alone.path()), "", "docker compose -f compose.local.yaml up");
    }

    #[test]
    fn a_dockerfile_alone_is_built_and_run_with_what_it_exposes() {
        let dir = scratch(&[(
            "api/Dockerfile",
            "FROM golang:1.22 AS build\nRUN go build\nFROM gcr.io/distroless/base\nexpose 8080 9090/tcp 5353/udp\nEXPOSE ${OTHER}\n",
        )]);
        let found = detect(dir.path());
        let run = find(
            &found,
            "api",
            "docker build -t api:local . && docker run --rm --init -p 8080:8080 -p 9090:9090 api:local",
        );
        assert_eq!(run.pinned_ports, vec![8080, 9090], "Docker holds them, so the service is told");
        assert_eq!(run.source, "api/Dockerfile");
        assert_eq!(run.name, "api-docker");
        assert!(run.score < 50, "below any way of running the code directly");

        let dev = scratch(&[("Dockerfile.dev", "FROM node\n"), ("Dockerfile", "FROM node\n")]);
        let name = image_name(&dev.path().file_name().unwrap().to_string_lossy());
        find(&detect(dev.path()), "", &format!("docker build -f Dockerfile.dev -t {name}:local . && docker run --rm --init {name}:local"));
    }

    #[test]
    fn a_maven_multi_module_build_runs_each_app_by_module_from_the_root() {
        let dir = scratch(&[
            ("pom.xml", "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent><packaging>pom</packaging><modules>\n<module>api</module>\n<module>common</module>\n</modules></project>"),
            ("mvnw", ""),
            ("api/pom.xml", "<project><artifactId>api</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>"),
            ("api/src/main/resources/application.yml", "spring:\n  application:\n    name: api\nserver:\n  port: 9000\n"),
            ("common/pom.xml", "<project><artifactId>common</artifactId><dependency><artifactId>spring-boot-starter-data-jpa</artifactId></dependency></project>"),
        ]);
        let found = detect(dir.path());
        let api = find(&found, "", "./mvnw -pl api spring-boot:run");
        assert_eq!(api.name, "api");
        assert_eq!(api.ports, vec![9000]);
        assert_eq!(found.len(), 1, "no root run, no library, no second copy from inside the module: {found:#?}");
    }

    #[test]
    fn a_gradle_multi_project_runs_each_app_by_path() {
        let dir = scratch(&[
            ("settings.gradle.kts", "rootProject.name = \"shop\"\ninclude(\"api\", \"worker\")\ninclude(\":libs:core\")\n"),
            ("build.gradle.kts", "plugins {\n  id(\"org.springframework.boot\") version \"3.3.0\" apply false\n}\n"),
            ("gradlew", ""),
            ("api/build.gradle.kts", "plugins {\n  id(\"org.springframework.boot\")\n}\n"),
            ("worker/build.gradle.kts", "plugins {\n  id(\"io.quarkus\")\n}\n"),
            ("libs/core/build.gradle.kts", "plugins {\n  `java-library`\n}\n"),
        ]);
        let found = detect(dir.path());
        find(&found, "", "./gradlew :api:bootRun");
        find(&found, "", "./gradlew :worker:quarkusDev");
        assert!(!found.iter().any(|c| c.command == "./gradlew bootRun"), "`apply false` is a version, not an app");
        assert_eq!(found.len(), 2, "{found:#?}");
    }

    #[test]
    fn quarkus_and_micronaut_run_in_their_own_dev_mode() {
        let quarkus = scratch(&[("pom.xml", "<plugin><artifactId>quarkus-maven-plugin</artifactId></plugin>"), ("mvnw", "")]);
        assert_eq!(detect(quarkus.path())[0].command, "./mvnw quarkus:dev");
        let micronaut = scratch(&[("build.gradle", "plugins {\n  id 'io.micronaut.application' version '4.4.0'\n}\n")]);
        assert_eq!(detect(micronaut.path())[0].command, "gradle run");
    }

    #[test]
    fn dotnet_apps_in_a_solution_are_found_and_libraries_and_tests_are_not() {
        let dir = scratch(&[
            ("Shop.sln", ""),
            ("src/Api/Api.csproj", "<Project Sdk=\"Microsoft.NET.Sdk.Web\"></Project>"),
            ("src/Api/Properties/launchSettings.json", r#"{"profiles":{"http":{"applicationUrl":"http://localhost:5080"},"https":{"applicationUrl":"https://localhost:7080;http://localhost:5080"}}}"#),
            ("src/Core/Core.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>"),
            ("tests/Api.Tests.csproj", "<Project Sdk=\"Microsoft.NET.Sdk.Web\"><PackageReference Include=\"Microsoft.NET.Test.Sdk\" /></Project>"),
        ]);
        let found = detect(dir.path());
        let api = find(&found, "src/Api", "dotnet watch run");
        assert_eq!(api.name, "Api");
        assert_eq!(api.ports, vec![5080, 7080]);
        assert_eq!(found.len(), 1, "{found:#?}");
    }

    #[test]
    fn a_procfile_is_a_list_of_services() {
        let dir = scratch(&[("Procfile.dev", "web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\n")]);
        let found = detect(dir.path());
        assert!(found.iter().any(|c| c.name == "web" && c.ports == vec![3000]));
        assert!(found.iter().any(|c| c.name == "css"));
    }

    #[test]
    fn other_ecosystems_get_their_usual_command() {
        let spring = scratch(&[("pom.xml", "<artifactId>spring-boot-starter-web</artifactId>"), ("mvnw", "")]);
        assert_eq!(detect(spring.path())[0].command, "./mvnw spring-boot:run");
        assert_eq!(detect(spring.path())[0].ports, vec![8080], "Spring's default when nothing says");

        let django = scratch(&[("manage.py", ""), ("uv.lock", "")]);
        assert_eq!(detect(django.path())[0].command, "uv run python manage.py runserver");

        let go = scratch(&[("go.mod", "module x"), ("cmd/api/main.go", "package main"), ("cmd/worker/main.go", "")]);
        let commands: Vec<String> = detect(go.path()).into_iter().map(|c| c.command).collect();
        assert_eq!(commands, vec!["go run ./cmd/api", "go run ./cmd/worker"]);

        let make = scratch(&[("Makefile", "VAR := 1\n.PHONY: dev\ndev:\n\tgo run .\nbuild: dev\n\tgo build\n")]);
        assert_eq!(detect(make.path())[0].command, "make dev");

        let rails = scratch(&[("bin/rails", ""), ("bin/dev", ""), ("config.ru", "")]);
        let commands: Vec<String> = detect(rails.path()).into_iter().map(|c| c.command).collect();
        assert_eq!(commands, vec!["bin/dev", "bin/rails server"], "not rackup: Rails owns config.ru");
    }

    #[test]
    fn build_output_and_dependencies_are_never_read() {
        let dir = scratch(&[
            ("node_modules/left-pad/package.json", r#"{"scripts":{"dev":"node x"}}"#),
            ("target/classes/pom.xml", "<artifactId>spring-boot-starter-web</artifactId>"),
            (".cache/app/manage.py", ""),
            ("dist/Dockerfile", "EXPOSE 80\n"),
        ]);
        assert!(detect(dir.path()).is_empty());
    }

    #[test]
    fn a_port_can_be_read_through_a_placeholder_or_a_nested_yaml_key() {
        assert_eq!(port_value("${SERVER_PORT:8085}"), Some(8085));
        assert_eq!(port_value(" 9001 "), Some(9001));
        assert_eq!(port_value("${PORT}"), None);
        assert_eq!(yaml_value("server:\n  port: 7000\n", "server.port").as_deref(), Some("7000"));
        assert_eq!(yaml_value("server.port: 7001\n", "server.port").as_deref(), Some("7001"));
        assert_eq!(yaml_value("management:\n  server:\n    port: 9\nserver:\n  address: x\n", "server.port"), None);
    }

    #[test]
    fn an_empty_or_missing_folder_suggests_nothing() {
        let dir = scratch(&[]);
        assert!(detect(dir.path()).is_empty());
        assert!(detect(Path::new("/definitely/not/here")).is_empty());
    }
}
