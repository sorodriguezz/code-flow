//! The skills and commands each CLI brings with it — what the chat's `/` menu lists beside the
//! app's own, so a skill installed in Claude Code, Codex or Grok is usable from the chat and not
//! only from that CLI's terminal.
//!
//! # Read where each CLI reads, verified per CLI
//!
//! - **Claude Code**: `<config>/skills/<name>`, claude.ai's synced ones under
//!   `<config>/skills/synced/<org>_<user>/<name>`, the enabled plugins' `skills/` (invoked as
//!   `plugin:name`), and the project's `.claude/skills`. The skills built into the binary exist
//!   nowhere on disk; they are known only from the `init` event a chat turn reported
//!   ([`crate::claude::install_report`]).
//! - **Codex**: `~/.agents/skills`, `$CODEX_HOME/skills` (its own under `.system`), the enabled
//!   plugins' `skills/`, and the project's `.agents/skills` — the roots its own
//!   `debug prompt-input` prints.
//! - **Grok**: whatever `grok inspect --json` reports, which is the CLI's own answer (it reads
//!   `.agents/skills`, Claude's skills and Claude's plugins as well as its own).
//! - **agy**: its built-in skills folder. opencode and Cline: nothing is claimed.
//!
//! Folders the app itself copied into a working directory carry a marker and are skipped: they are
//! the workspace's skills, listed once, as the app's.
//!
//! A skill whose front matter says `user-invocable: false` is not listed at all — it is for the
//! model to reach for, not for a person to pick.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::skill_meta;

/// One skill a person can pick in the composer.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProviderSkill {
    /// As it is invoked: `pdf`, `vercel:deploy`.
    pub name: String,
    pub description: String,
    /// `app` | `user` | `project` | `plugin` | `bundled`.
    pub source: String,
    pub plugin: Option<String>,
    /// Its `SKILL.md`, when it lives on disk — what an engine that cannot open it by name is
    /// pointed at. `None` for a skill built into the CLI.
    pub path: Option<String>,
    /// `false` when its front matter forbids the model from starting it (`disable-model-invocation`)
    /// — an instruction naming it would then be asking for something the CLI refuses.
    pub model_invocable: bool,
}

/// A skill picked in the composer, as a turn receives it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SkillPick {
    pub name: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub path: Option<String>,
}

/// One command a CLI expands headlessly — see [`claude_commands`].
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CommandEntry {
    /// With its leading slash.
    pub name: String,
    pub description: String,
    /// `user` | `project` | `plugin`.
    pub source: String,
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

fn read_skill(dir: &Path, invoke_as: String, source: &str, plugin: Option<&str>) -> Option<ProviderSkill> {
    let file = dir.join("SKILL.md");
    let text = std::fs::read_to_string(&file).ok()?;
    let meta = skill_meta::parse(&text);
    if !meta.user_may_invoke() {
        return None;
    }
    Some(ProviderSkill {
        name: invoke_as,
        description: meta.description.clone().unwrap_or_default(),
        source: source.to_string(),
        plugin: plugin.map(str::to_string),
        path: Some(file.to_string_lossy().into_owned()),
        model_invocable: meta.model_may_invoke(),
    })
}

/// Every skill folder directly under `root`, named by its folder — the name the CLIs invoke it by.
fn scan_root(root: &Path, source: &str, plugin: Option<&str>) -> Vec<ProviderSkill> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let folder = entry.file_name().to_string_lossy().to_string();
        if folder.starts_with('.') || !path.is_dir() {
            continue;
        }
        // Copied there by the app for this turn — the workspace's skill, listed as the app's.
        if path.join(crate::commands::skills_cmd::SYNC_MARKER).is_file() {
            continue;
        }
        let invoke = match plugin {
            Some(plugin) => format!("{plugin}:{folder}"),
            None => folder,
        };
        if let Some(skill) = read_skill(&path, invoke, source, plugin) {
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Drops later entries whose name an earlier one already took — the caller orders sources by the
/// CLI's own precedence, so what is kept is what the CLI would run.
fn first_of_each(skills: Vec<ProviderSkill>) -> Vec<ProviderSkill> {
    let mut seen = std::collections::HashSet::new();
    skills.into_iter().filter(|skill| seen.insert(skill.name.clone())).collect()
}

/// `2.1.266` → comparable; anything else sorts by text after every numbered version.
fn version_order(name: &str) -> (u8, Vec<u64>, String) {
    match name.split('.').map(|part| part.parse::<u64>().ok()).collect::<Option<Vec<u64>>>() {
        Some(parts) => (1, parts, String::new()),
        None => (0, Vec::new(), name.to_string()),
    }
}

/// The newest version folder of a cached plugin (`<plugin>/<version>/`).
fn newest_version_dir(plugin_dir: &Path) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = std::fs::read_dir(plugin_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|path| version_order(&path.file_name().unwrap_or_default().to_string_lossy()));
    versions.pop()
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

/// The enabled plugins of a Claude Code config, as `(name, install path)`.
///
/// From the CLI's own report when a chat turn has filed one — that is exactly what it loaded —
/// else from `installed_plugins.json` filtered by `settings.json`'s `enabledPlugins`.
pub fn claude_plugins(config: &Path, report: Option<&crate::claude::ClaudeInstallReport>) -> Vec<(String, PathBuf)> {
    if let Some(report) = report {
        if !report.plugins.is_empty() {
            return report
                .plugins
                .iter()
                .filter(|plugin| !plugin.path.is_empty())
                .map(|plugin| (plugin.name.clone(), PathBuf::from(&plugin.path)))
                .collect();
        }
    }
    let enabled: serde_json::Value = std::fs::read_to_string(config.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let enabled = enabled.get("enabledPlugins").and_then(serde_json::Value::as_object).cloned().unwrap_or_default();
    let installed: serde_json::Value = std::fs::read_to_string(config.join("plugins").join("installed_plugins.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let installed = installed.get("plugins").unwrap_or(&installed).as_object().cloned().unwrap_or_default();

    let mut out = Vec::new();
    for (key, installs) in installed {
        if enabled.get(&key).and_then(serde_json::Value::as_bool) != Some(true) {
            continue;
        }
        let name = key.split('@').next().unwrap_or(&key).to_string();
        let path = installs
            .as_array()
            .and_then(|list| list.iter().find_map(|install| install.get("installPath").and_then(serde_json::Value::as_str)))
            .map(PathBuf::from);
        if let Some(path) = path {
            out.push((name, path));
        }
    }
    out.sort();
    out
}

/// Claude Code's skills for one config directory, in the CLI's own precedence: personal before
/// project, then the plugins' (namespaced, so they never clash), then the built-in ones only the
/// CLI's report knows about.
pub fn claude(config: &Path, cwd: Option<&Path>, report: Option<&crate::claude::ClaudeInstallReport>) -> Vec<ProviderSkill> {
    let mut out = Vec::new();
    let personal = config.join("skills");
    out.extend(scan_root(&personal, "user", None));
    // claude.ai's synced skills: one folder per organisation and user, the skills inside it.
    if let Ok(entries) = std::fs::read_dir(personal.join("synced")) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                out.extend(scan_root(&entry.path(), "user", None));
            }
        }
    }
    if let Some(cwd) = cwd {
        out.extend(scan_root(&cwd.join(".claude").join("skills"), "project", None));
    }
    for (name, path) in claude_plugins(config, report) {
        out.extend(scan_root(&path.join("skills"), "plugin", Some(&name)));
    }
    if let Some(report) = report {
        for name in &report.skills {
            if !out.iter().any(|skill| &skill.name == name) {
                out.push(ProviderSkill {
                    name: name.clone(),
                    description: String::new(),
                    source: "bundled".to_string(),
                    plugin: None,
                    path: None,
                    model_invocable: true,
                });
            }
        }
    }
    first_of_each(out)
}

/// Claude Code's custom commands — the user's, the project's and the enabled plugins'
/// (`commands/<name>.md`, invoked as `/name` or `/plugin:name`). Prompt commands, so they expand
/// in `-p` exactly as typed. Files starting with `_` are a plugin's own notes, not commands.
pub fn claude_commands(config: &Path, cwd: Option<&Path>, report: Option<&crate::claude::ClaudeInstallReport>) -> Vec<CommandEntry> {
    let mut out = Vec::new();
    out.extend(scan_commands(&config.join("commands"), "user", None));
    if let Some(cwd) = cwd {
        out.extend(scan_commands(&cwd.join(".claude").join("commands"), "project", None));
    }
    for (name, path) in claude_plugins(config, report) {
        out.extend(scan_commands(&path.join("commands"), "plugin", Some(&name)));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|command| seen.insert(command.name.clone()));
    out
}

fn scan_commands(root: &Path, source: &str, plugin: Option<&str>) -> Vec<CommandEntry> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = file.strip_suffix(".md") else { continue };
        if stem.starts_with('_') || stem.starts_with('.') || !path.is_file() {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let description = skill_meta::parse(&text).description.unwrap_or_else(|| first_prose_line(&text));
        let name = match plugin {
            Some(plugin) => format!("/{plugin}:{stem}"),
            None => format!("/{stem}"),
        };
        out.push(CommandEntry { name, description, source: source.to_string() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A command with no front matter is described, by Claude Code too, by its first line of prose.
fn first_prose_line(text: &str) -> String {
    let mut lines = text.lines();
    if text.trim_start().starts_with("---") {
        // Skip a front matter block that had no description in it.
        let _ = lines.next();
        for line in lines.by_ref() {
            if line.trim() == "---" {
                break;
            }
        }
    }
    let line = lines.map(str::trim).find(|line| !line.is_empty()).unwrap_or_default();
    let line = line.trim_start_matches('#').trim();
    line.chars().take(140).collect()
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

/// The plugins a Codex `config.toml` enables — `[plugins."name@marketplace"]` with
/// `enabled = true` under it. A line scan, not a TOML parse: two keys are wanted, and there is no
/// TOML crate in this build.
fn codex_enabled_plugins(config: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current = line
                .strip_prefix("[plugins.\"")
                .and_then(|rest| rest.strip_suffix("\"]"))
                .and_then(|key| key.split_once('@'))
                .map(|(name, marketplace)| (name.to_string(), marketplace.to_string()));
            continue;
        }
        if let Some((name, marketplace)) = &current {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "enabled" && value.trim() == "true" {
                    out.push((name.clone(), marketplace.clone()));
                }
            }
        }
    }
    out
}

/// Codex's skills: the project's, the user's (`~/.agents/skills`, `$CODEX_HOME/skills`), the
/// enabled plugins', and its own under `.system`.
pub fn codex(codex_home: &Path, cwd: Option<&Path>) -> Vec<ProviderSkill> {
    let mut out = Vec::new();
    if let Some(cwd) = cwd {
        out.extend(scan_root(&cwd.join(".agents").join("skills"), "project", None));
    }
    if let Some(home) = dirs::home_dir() {
        out.extend(scan_root(&home.join(".agents").join("skills"), "user", None));
    }
    out.extend(scan_root(&codex_home.join("skills"), "user", None));
    let config = std::fs::read_to_string(codex_home.join("config.toml")).unwrap_or_default();
    for (plugin, marketplace) in codex_enabled_plugins(&config) {
        let cached = codex_home.join("plugins").join("cache").join(&marketplace).join(&plugin);
        if let Some(version) = newest_version_dir(&cached) {
            // Codex lists a plugin's skills by their own names, not prefixed.
            let mut skills = scan_root(&version.join("skills"), "plugin", None);
            for skill in &mut skills {
                skill.plugin = Some(plugin.clone());
            }
            out.extend(skills);
        }
    }
    out.extend(scan_root(&codex_home.join("skills").join(".system"), "bundled", None));
    first_of_each(out)
}

// ---------------------------------------------------------------------------------------------
// Grok and agy
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct GrokInspect {
    #[serde(default)]
    skills: Vec<GrokSkill>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrokSkill {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    source: GrokSource,
    #[serde(default = "yes")]
    user_invocable: bool,
}

#[derive(Default, Deserialize)]
struct GrokSource {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    plugin_name: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

fn yes() -> bool {
    true
}

/// Reads `grok inspect --json`'s skills. Pure, so the shape is testable against a captured answer.
pub fn parse_grok_inspect(json: &str) -> Vec<ProviderSkill> {
    let Ok(inspect) = serde_json::from_str::<GrokInspect>(json) else { return Vec::new() };
    let skills = inspect
        .skills
        .into_iter()
        .filter(|skill| skill.user_invocable)
        // Copies the app placed in a chat's folder are the app's skills, listed as such.
        .filter(|skill| {
            !skill.source.path.as_deref().is_some_and(|path| {
                Path::new(path).parent().is_some_and(|dir| dir.join(crate::commands::skills_cmd::SYNC_MARKER).is_file())
            })
        })
        .map(|skill| {
            let source = match skill.source.kind.as_str() {
                "user" | "project" | "plugin" | "bundled" => skill.source.kind.clone(),
                _ => "user".to_string(),
            };
            ProviderSkill {
                name: skill.name,
                description: skill.description.split_whitespace().collect::<Vec<_>>().join(" "),
                source,
                plugin: skill.source.plugin_name,
                path: skill.source.path,
                model_invocable: true,
            }
        })
        .collect();
    first_of_each(skills)
}

/// `grok inspect --json` for `cwd`, as text — the CLI's own account of the skills and MCP servers
/// it sees there. Kept for a minute, because the `/` menu and the MCP switches both ask every time
/// they open and the answer is a process launch. Empty when Grok could not be asked.
pub async fn grok_inspect_json(binary: &str, cwd: Option<&Path>) -> String {
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<Option<(String, std::time::Instant, String)>>> = OnceLock::new();
    let key = cwd.map(|dir| dir.to_string_lossy().into_owned()).unwrap_or_default();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(held) = cache.lock() {
        if let Some((held_key, at, json)) = held.as_ref() {
            if *held_key == key && at.elapsed() < std::time::Duration::from_secs(60) {
                return json.clone();
            }
        }
    }
    let (mut cmd, program) = crate::ai::aux_command_resolved(binary);
    cmd.arg("inspect").arg("--json");
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let launch = crate::ai::output_patiently(&mut cmd, binary, &program);
    let json = match tokio::time::timeout(std::time::Duration::from_secs(10), launch).await {
        Ok(Ok(output)) if output.status.success() => String::from_utf8_lossy(&output.stdout).into_owned(),
        _ => String::new(),
    };
    if let Ok(mut held) = cache.lock() {
        *held = Some((key, std::time::Instant::now(), json.clone()));
    }
    json
}

/// Grok's skills, as the CLI itself reports them for `cwd`.
pub async fn grok(binary: &str, cwd: Option<&Path>) -> Vec<ProviderSkill> {
    parse_grok_inspect(&grok_inspect_json(binary, cwd).await)
}

/// agy's built-in skills.
pub fn gemini() -> Vec<ProviderSkill> {
    let Some(home) = dirs::home_dir() else { return Vec::new() };
    scan_root(&home.join(".gemini").join("antigravity-cli").join("builtin").join("skills"), "bundled", None)
}

// ---------------------------------------------------------------------------------------------
// Using one
// ---------------------------------------------------------------------------------------------

/// The instruction a turn carries when the user picked a skill, appended to what the engine is
/// sent and never to what is stored — the transcript keeps the user's own words.
///
/// Neutral wording rather than a `/name` typed into the message, because a slash command is only
/// expanded when it is the first thing on the command line: a multi-line message (Claude moves it
/// to stdin), an attachment, caveman's rules or agy's system prompt on a first turn all put
/// something in front of it. Claude is told to open it with its `Skill` tool, which every chat turn
/// is granted; everyone else is pointed at the file.
pub fn instruction(provider: &str, pick: &SkillPick, resolved_path: Option<&str>) -> String {
    let name = pick.name.trim();
    let path = resolved_path.or(pick.path.as_deref()).filter(|path| !path.trim().is_empty());
    match (provider, path) {
        ("claude", Some(path)) => format!(
            "Para esta petición usa la skill «{name}»: invócala con tu herramienta Skill y sigue sus \
             instrucciones (su definición está en {path})."
        ),
        ("claude", None) => {
            format!("Para esta petición usa la skill «{name}»: invócala con tu herramienta Skill y sigue sus instrucciones.")
        }
        (_, Some(path)) => format!(
            "Para esta petición usa la skill «{name}»: antes de responder, lee {path} y sigue sus instrucciones."
        ),
        (_, None) => format!("Para esta petición usa tu skill «{name}» y sigue sus instrucciones."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-provider-skills-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn skill(root: &Path, name: &str, front: &str) {
        std::fs::create_dir_all(root.join(name)).unwrap();
        std::fs::write(root.join(name).join("SKILL.md"), format!("---\n{front}\n---\n# {name}\n")).unwrap();
    }

    /// The layout found on the machine this was written on: personal skills, claude.ai's synced
    /// ones three folders down, an enabled plugin's (namespaced) and a disabled one's (absent), and
    /// the built-in ones only the CLI's report names.
    #[test]
    fn claudes_skills_are_read_where_claude_reads_them() {
        let config = scratch();
        skill(&config.join("skills"), "mine", "name: mine\ndescription: >\n  My own\n  skill.");
        skill(&config.join("skills/synced/org_user"), "frontend-design", "description: Design UIs");
        skill(&config.join("skills"), "hidden", "user-invocable: false");
        let enabled = config.join("plugins/cache/official/vercel/1.0.0");
        let disabled = config.join("plugins/cache/other/warp/2.0.0");
        skill(&enabled.join("skills"), "deploy", "description: Deploy it");
        skill(&disabled.join("skills"), "nope", "description: Not enabled");
        std::fs::write(
            config.join("plugins/installed_plugins.json"),
            format!(
                r#"{{"version":2,"plugins":{{"vercel@official":[{{"scope":"user","installPath":"{}"}}],"warp@other":[{{"scope":"user","installPath":"{}"}}]}}}}"#,
                enabled.display(),
                disabled.display()
            ),
        )
        .unwrap();
        std::fs::write(config.join("settings.json"), r#"{"enabledPlugins":{"vercel@official":true,"warp@other":false}}"#).unwrap();
        let report = crate::claude::ClaudeInstallReport {
            skills: vec!["pdf".into(), "mine".into(), "vercel:deploy".into()],
            ..Default::default()
        };

        let skills = claude(&config, None, Some(&report));
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"mine") && names.contains(&"frontend-design"), "{names:?}");
        assert!(names.contains(&"vercel:deploy"), "enabled plugin, namespaced: {names:?}");
        assert!(!names.iter().any(|n| n.contains("nope")), "disabled plugin: {names:?}");
        assert!(!names.contains(&"hidden"), "user-invocable: false is not for the menu");
        let mine = skills.iter().find(|s| s.name == "mine").unwrap();
        assert_eq!(mine.description, "My own skill.");
        assert_eq!(mine.source, "user");
        let pdf = skills.iter().find(|s| s.name == "pdf").unwrap();
        assert_eq!((pdf.source.as_str(), pdf.path.as_deref()), ("bundled", None), "built in: only the report knows it");
        assert_eq!(skills.iter().filter(|s| s.name == "mine").count(), 1, "the report does not list it twice");
        let _ = std::fs::remove_dir_all(&config);
    }

    /// A copy the app placed in a working directory is the app's skill, not the project's.
    #[test]
    fn the_apps_own_copies_are_not_listed_as_the_projects() {
        let cwd = scratch();
        skill(&cwd.join(".claude/skills"), "ours", "description: Synced by the app");
        std::fs::write(cwd.join(".claude/skills/ours").join(crate::commands::skills_cmd::SYNC_MARKER), "x").unwrap();
        skill(&cwd.join(".claude/skills"), "theirs", "description: The team's");
        let config = scratch();
        let names: Vec<String> = claude(&config, Some(&cwd), None).into_iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["theirs".to_string()]);
        let _ = std::fs::remove_dir_all(&cwd);
        let _ = std::fs::remove_dir_all(&config);
    }

    #[test]
    fn codex_reads_its_roots_and_only_its_enabled_plugins() {
        let home = scratch();
        skill(&home.join("skills/.system"), "imagegen", "description: Images");
        skill(&home.join("skills"), "notes", "description: Notes");
        let cache = home.join("plugins/cache/runtime/spreadsheets");
        skill(&cache.join("26.905.11957/skills"), "xlsx", "description: New");
        skill(&cache.join("26.100.1/skills"), "xlsx-old", "description: Old");
        skill(&home.join("plugins/cache/runtime/pdf/1.0.0/skills"), "pdf", "description: Off");
        std::fs::write(
            home.join("config.toml"),
            "[plugins.\"spreadsheets@runtime\"]\nenabled = true\n\n[plugins.\"pdf@runtime\"]\nenabled = false\n",
        )
        .unwrap();
        let skills = codex(&home, None);
        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"notes") && names.contains(&"imagegen") && names.contains(&"xlsx"), "{names:?}");
        assert!(!names.contains(&"xlsx-old"), "the newest version only: {names:?}");
        assert!(!names.contains(&"pdf"), "disabled: {names:?}");
        assert_eq!(skills.iter().find(|s| s.name == "imagegen").unwrap().source, "bundled");
        assert_eq!(skills.iter().find(|s| s.name == "xlsx").unwrap().plugin.as_deref(), Some("spreadsheets"));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The shape `grok inspect --json` answered with (1.0.4), trimmed to what is read.
    #[test]
    fn grok_is_read_from_its_own_inspect_output() {
        let json = r#"{"grokVersion":"1.0.4","skills":[
            {"name":"caveman","description":"Ultra-compressed\n  mode.","source":{"type":"user","path":"/h/.agents/skills/caveman/SKILL.md"},"userInvocable":true},
            {"name":"verification","description":"Full-story","source":{"type":"plugin","plugin_name":"vercel","path":"/p/SKILL.md"},"userInvocable":true},
            {"name":"internal","description":"x","source":{"type":"bundled"},"userInvocable":false}
        ],"mcpServers":[]}"#;
        let skills = parse_grok_inspect(json);
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].description, "Ultra-compressed mode.");
        assert_eq!(skills[1].plugin.as_deref(), Some("vercel"));
        assert!(parse_grok_inspect("not json").is_empty());
    }

    #[test]
    fn commands_are_read_with_their_description_and_namespace() {
        let config = scratch();
        std::fs::create_dir_all(config.join("commands")).unwrap();
        std::fs::write(config.join("commands/standup.md"), "---\ndescription: Summarise my day\n---\nDo it.").unwrap();
        std::fs::write(config.join("commands/plain.md"), "# Explain the diff\n\nMore.").unwrap();
        let plugin = config.join("plugins/cache/o/vercel/1.0.0");
        std::fs::create_dir_all(plugin.join("commands")).unwrap();
        std::fs::write(plugin.join("commands/deploy.md"), "---\ndescription: Deploy\n---\n").unwrap();
        std::fs::write(plugin.join("commands/_conventions.md"), "notes").unwrap();
        std::fs::write(plugin.join("commands/deploy.md.tmpl"), "template").unwrap();
        let report = crate::claude::ClaudeInstallReport {
            plugins: vec![crate::claude::PluginRef { name: "vercel".into(), path: plugin.to_string_lossy().into_owned() }],
            ..Default::default()
        };
        let commands = claude_commands(&config, None, Some(&report));
        let pairs: Vec<(&str, &str)> = commands.iter().map(|c| (c.name.as_str(), c.description.as_str())).collect();
        assert_eq!(
            pairs,
            vec![("/plain", "Explain the diff"), ("/standup", "Summarise my day"), ("/vercel:deploy", "Deploy")]
        );
        let _ = std::fs::remove_dir_all(&config);
    }

    /// What this machine actually has, printed rather than asserted — a signed-in machine and a
    /// bare one are both legitimate. Run by hand:
    ///
    /// ```text
    /// cargo test --lib provider_skills::tests::what_this_machine_has -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "reads the real CLI configuration of the machine it runs on"]
    fn what_this_machine_has() {
        let home = dirs::home_dir().unwrap();
        let claude_skills = claude(&home.join(".claude"), None, None);
        println!("claude skills ({}):", claude_skills.len());
        for skill in &claude_skills {
            println!("  {:<40} {:<8} {}", skill.name, skill.source, skill.description.chars().take(60).collect::<String>());
        }
        let commands = claude_commands(&home.join(".claude"), None, None);
        println!("claude commands: {:?}", commands.iter().map(|c| &c.name).collect::<Vec<_>>());
        let codex_skills = codex(&home.join(".codex"), None);
        println!("codex skills ({}): {:?}", codex_skills.len(), codex_skills.iter().map(|s| &s.name).collect::<Vec<_>>());
        println!("agy skills: {:?}", gemini().iter().map(|s| &s.name).collect::<Vec<_>>());
    }

    #[test]
    fn the_instruction_points_each_engine_at_what_it_can_open() {
        let pick = SkillPick { name: "pdf".into(), source: "user".into(), path: Some("/h/pdf/SKILL.md".into()) };
        let claude = instruction("claude", &pick, None);
        assert!(claude.contains("herramienta Skill") && claude.contains("«pdf»"), "{claude}");
        let codex = instruction("codex", &pick, Some(".agents/skills/pdf/SKILL.md"));
        assert!(codex.contains("lee .agents/skills/pdf/SKILL.md"), "the resolved copy wins: {codex}");
        let bare = instruction("grok", &SkillPick { name: "x".into(), ..Default::default() }, None);
        assert!(bare.contains("«x»"), "{bare}");
    }
}
