//! Services handing a process the secrets its configuration files point at in the Llavero.
//!
//! The other half of «el archivo queda con una referencia y Servicios inyecta el valor al arrancar»
//! (2026-10-23). When a service starts, the files it uses are read for `llavero:<id>` references,
//! each one is opened in the Llavero, and the value goes into the process **as an environment
//! variable** named the way that file's framework reads an override:
//!
//! - dotenv and Compose: the key itself (Compose then passes it through — see `edit`);
//! - appsettings: `A:B` → `A__B`, which .NET reads after every JSON file;
//! - Spring `.properties`/`.yml`: relaxed binding, `spring.datasource.password` →
//!   `SPRING_DATASOURCE_PASSWORD`, which Spring reads after `application.yml`.
//!
//! **Which files a service uses.** Its own env files when it names some; otherwise the dotenv
//! cascade every dev server reads (`.env`, `.env.local`, `.env.development`,
//! `.env.development.local`) — never `.env.production` or an example, so starting a service in
//! development can never hand it production's secret. Then, at its folder: `appsettings.json` and
//! the one for its `ASPNETCORE_ENVIRONMENT` (Development unless the service says otherwise);
//! Spring's `application` files and those of its `SPRING_PROFILES_ACTIVE`; and the Compose files its
//! command names (or the default ones) when it runs Compose.
//!
//! A locked Llavero is said in the service's console, by key names, and the service starts without
//! those values — the same as a missing env file, and for the same reason: a group start should not
//! stop on a dialog nobody is looking at. Values are never written to the console.

use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

use super::{format_of, parse, Format, MAX_BYTES};

/// One reference a service's files hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Wanted {
    /// The environment variable it becomes.
    pub var: String,
    pub item_id: String,
    /// The file, as the service's folder names it.
    pub file: String,
    pub key: String,
}

/// A file a service uses, for the dock to show — names and counts only.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedFile {
    pub path: String,
    pub format: Format,
    /// Loaded whole as variables (the service's env files) rather than read for references only.
    pub loads: bool,
    pub variables: usize,
    /// The keys that are Llavero references.
    pub references: Vec<String>,
}

const DEV_CASCADE: &[&str] = &[".env", ".env.local", ".env.development", ".env.development.local"];

fn lookup<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter().rev().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).filter(|v| !v.trim().is_empty())
}

/// How a service uses one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Use {
    /// One of its env files: loaded whole, as dotenv, whatever it is called.
    Loads,
    /// Read for references only, in the format its name says.
    Config,
    /// A Compose file its command names — Compose, whatever it is called.
    Compose,
}

/// The files a service uses, relative to its folder (or absolute when its env files say so), in
/// load order.
pub fn files_for(cwd: &Path, env_files: &[String], command: &str, env: &[(String, String)]) -> Vec<(String, Use)> {
    let mut out: Vec<(String, Use)> = Vec::new();
    let push = |file: String, loads: Use, out: &mut Vec<(String, Use)>| {
        if !out.iter().any(|(f, _)| *f == file) && cwd.join(&file).is_file() {
            out.push((file, loads));
        }
    };
    if env_files.is_empty() {
        for file in DEV_CASCADE {
            push(file.to_string(), Use::Config, &mut out);
        }
    } else {
        for file in env_files {
            push(file.clone(), Use::Loads, &mut out);
        }
    }
    let dotnet = lookup(env, "ASPNETCORE_ENVIRONMENT").or_else(|| lookup(env, "DOTNET_ENVIRONMENT")).unwrap_or("Development");
    push("appsettings.json".into(), Use::Config, &mut out);
    push(format!("appsettings.{dotnet}.json"), Use::Config, &mut out);
    let profiles: Vec<String> = lookup(env, "SPRING_PROFILES_ACTIVE")
        .map(|p| p.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    for dir in ["", "src/main/resources/", "config/"] {
        for ext in ["properties", "yml", "yaml"] {
            push(format!("{dir}application.{ext}"), Use::Config, &mut out);
            for profile in &profiles {
                push(format!("{dir}application-{profile}.{ext}"), Use::Config, &mut out);
            }
        }
    }
    let words: Vec<&str> = command.split_whitespace().collect();
    if words.iter().any(|w| *w == "compose" || w.ends_with("docker-compose")) {
        let mut named = Vec::new();
        let mut i = 0;
        while i < words.len() {
            if matches!(words[i], "-f" | "--file") && i + 1 < words.len() {
                named.push(words[i + 1].trim_matches(['"', '\'']).to_string());
                i += 1;
            } else if let Some(file) = words[i].strip_prefix("--file=") {
                named.push(file.trim_matches(['"', '\'']).to_string());
            }
            i += 1;
        }
        if named.is_empty() {
            named = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "docker-compose.override.yml", "docker-compose.override.yaml"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        for file in named {
            push(file, Use::Compose, &mut out);
        }
    }
    out
}

/// `spring.datasource.password` → `SPRING_DATASOURCE_PASSWORD` (Spring's relaxed binding).
pub fn spring_env_name(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for ch in key.chars() {
        match ch {
            '.' | '[' | ']' => out.push('_'),
            '-' => {}
            other => out.push(other.to_ascii_uppercase()),
        }
    }
    out
}

/// The variable a reference in a file of `format` becomes.
pub fn var_for(format: Format, key: &str) -> String {
    match format {
        Format::Appsettings | Format::Json => key.replace(':', "__"),
        Format::Properties | Format::Yaml => spring_env_name(key),
        Format::Dotenv | Format::Compose | Format::LaunchSettings => key.to_string(),
    }
}

/// Every file a service uses, read for references — and the dock's summary of them.
pub fn wanted(cwd: &Path, env_files: &[String], command: &str, env: &[(String, String)]) -> (Vec<Wanted>, Vec<UsedFile>) {
    let mut wanted: Vec<Wanted> = Vec::new();
    let mut used = Vec::new();
    for (file, how) in files_for(cwd, env_files, command, env) {
        let loads = how == Use::Loads;
        let path = cwd.join(&file);
        if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        // A service's env files are dotenv, whatever they are called — that is how they load.
        let format = match how {
            Use::Loads => Format::Dotenv,
            Use::Compose => Format::Compose,
            Use::Config => format_of(&file.replace('\\', "/")),
        };
        let Ok((_, entries)) = parse(format, &text) else { continue };
        let mut references = Vec::new();
        for entry in &entries {
            let Some(id) = &entry.reference else { continue };
            references.push(entry.key.clone());
            let var = var_for(format, &entry.key);
            // A later file wins, the way the dotenv cascade itself layers.
            wanted.retain(|w| w.var != var);
            wanted.push(Wanted { var, item_id: id.clone(), file: file.clone(), key: entry.key.clone() });
        }
        used.push(UsedFile { path: file, format, loads, variables: entries.len(), references });
    }
    (wanted, used)
}

/// The value a moved secret is read back from. `apiKey` is where a move stores it; the rest let a
/// reference written by hand point at any entry.
pub fn pick_value(secret: &serde_json::Value) -> Option<String> {
    const ORDER: &[&str] = &["apiKey", "password", "connectionString", "token", "secretAccessKey", "secret", "value", "privateKey", "passphrase"];
    ORDER.iter().find_map(|field| secret.get(field).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(str::to_string))
}

pub struct Injected {
    pub vars: Vec<(String, String)>,
    pub notes: Vec<String>,
}

/// Resolves a service's references. `env` is the service's own variables: a variable the service
/// sets itself is not looked up (it wins anyway).
pub fn for_service<R: Runtime>(app: &AppHandle<R>, cwd: Option<&Path>, env_files: &[String], command: &str, env: &[(String, String)]) -> Injected {
    let mut injected = Injected { vars: Vec::new(), notes: Vec::new() };
    let Some(cwd) = cwd else { return injected };
    let (mut wanted, _) = wanted(cwd, env_files, command, env);
    wanted.retain(|w| !env.iter().any(|(k, _)| *k == w.var));
    if wanted.is_empty() {
        return injected;
    }
    let names = |list: &[&Wanted]| list.iter().map(|w| w.var.as_str()).collect::<Vec<_>>().join(", ");
    let session = app.state::<crate::keyvault::session::VaultSession>();
    if !session.is_unlocked() {
        let all: Vec<&Wanted> = wanted.iter().collect();
        injected.notes.push(format!(
            "the Llavero is locked — started without {} it holds for this service ({}); unlock it and restart",
            plural(all.len()),
            names(&all)
        ));
        return injected;
    }
    let db = app.state::<crate::db::Db>();
    let Ok(conn) = db.0.lock() else { return injected };
    let mut missing: Vec<&Wanted> = Vec::new();
    let mut locked: Vec<&Wanted> = Vec::new();
    for want in &wanted {
        let sealed = crate::db::keyvault_queries::get_sealed(&conn, &want.item_id).ok().flatten();
        let Some((meta, nonce, blob)) = sealed.filter(|(meta, _, _)| meta.deleted_at.is_empty()) else {
            missing.push(want);
            continue;
        };
        let _ = meta;
        let opened = session.with_key(|dek| crate::keyvault::crypto::open(dek, &want.item_id, &nonce, &blob));
        let value = match opened {
            Ok(Ok(bytes)) => serde_json::from_slice::<serde_json::Value>(&bytes).ok().as_ref().and_then(pick_value),
            Ok(Err(_)) => None,
            Err(_) => {
                locked.push(want);
                continue;
            }
        };
        match value {
            Some(value) => {
                crate::db::keyvault_queries::record_audit(&conn, &want.item_id, "use");
                injected.vars.push((want.var.clone(), value));
            }
            None => missing.push(want),
        }
    }
    if !injected.vars.is_empty() {
        let given: Vec<&str> = injected.vars.iter().map(|(k, _)| k.as_str()).collect();
        injected.notes.push(format!("Llavero: {} passed in ({})", plural(given.len()), given.join(", ")));
    }
    if !missing.is_empty() {
        injected.notes.push(format!("Llavero: no value for {} — the entry is gone or empty; started without it", names(&missing)));
    }
    if !locked.is_empty() {
        injected.notes.push(format!("the Llavero locked while starting — started without {}", names(&locked)));
    }
    injected
}

fn plural(n: usize) -> String {
    if n == 1 {
        "1 secret".into()
    } else {
        format!("{n} secrets")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variable_names_follow_each_frameworks_override() {
        assert_eq!(var_for(Format::Dotenv, "API_KEY"), "API_KEY");
        assert_eq!(var_for(Format::Appsettings, "ConnectionStrings:Default"), "ConnectionStrings__Default");
        assert_eq!(var_for(Format::Properties, "spring.datasource.password"), "SPRING_DATASOURCE_PASSWORD");
        assert_eq!(var_for(Format::Yaml, "my-app.list[0]"), "MYAPP_LIST_0_");
        assert_eq!(var_for(Format::Compose, "TOKEN"), "TOKEN");
    }

    #[test]
    fn the_dev_cascade_never_reads_production_and_a_later_file_wins() {
        let root = super::super::temp_dir("inject");
        std::fs::write(root.join(".env"), "A= # llavero:one\nB=plain\n").unwrap();
        std::fs::write(root.join(".env.local"), "A= # llavero:two\n").unwrap();
        std::fs::write(root.join(".env.production"), "P= # llavero:prod\n").unwrap();
        std::fs::write(root.join("appsettings.json"), r#"{"ConnectionStrings":{"Default":"llavero:db"}}"#).unwrap();
        std::fs::write(root.join("appsettings.Production.json"), r#"{"X":"llavero:px"}"#).unwrap();
        let (wanted, used) = wanted(&root, &[], "dotnet run", &[]);
        let got: Vec<(&str, &str)> = wanted.iter().map(|w| (w.var.as_str(), w.item_id.as_str())).collect();
        assert_eq!(got, vec![("A", "two"), ("ConnectionStrings__Default", "db")]);
        let files: Vec<&str> = used.iter().map(|u| u.path.as_str()).collect();
        assert_eq!(files, vec![".env", ".env.local", "appsettings.json"]);
        assert!(!used[0].loads);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn named_env_files_profiles_and_compose_files_are_followed() {
        let root = super::super::temp_dir("inject2");
        std::fs::create_dir_all(root.join("src/main/resources")).unwrap();
        std::fs::write(root.join("custom.env"), "K= # llavero:k\n").unwrap();
        std::fs::write(root.join(".env"), "IGNORED= # llavero:i\n").unwrap();
        std::fs::write(root.join("src/main/resources/application-qa.yml"), "spring:\n  datasource:\n    password: # llavero:s\n").unwrap();
        std::fs::write(root.join("infra.yml"), "services:\n  db:\n    environment:\n      - PG_PASS # llavero:c\n").unwrap();
        let env = vec![("SPRING_PROFILES_ACTIVE".to_string(), "qa".to_string())];
        let (wanted, used) = wanted(&root, &["custom.env".to_string()], "docker compose -f infra.yml up", &env);
        let got: Vec<&str> = wanted.iter().map(|w| w.var.as_str()).collect();
        assert_eq!(got, vec!["K", "SPRING_DATASOURCE_PASSWORD", "PG_PASS"]);
        assert!(used[0].loads);
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn the_value_is_read_from_the_field_a_move_writes_first() {
        let secret = serde_json::json!({"notes": "n", "password": "p", "apiKey": "k"});
        assert_eq!(pick_value(&secret).as_deref(), Some("k"));
        assert_eq!(pick_value(&serde_json::json!({"apiKey": ""})), None);
    }
}
