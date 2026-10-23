//! The apps installed on this computer, by the names a person calls them — what «Codi, abre Teams»
//! looks in.
//!
//! - **macOS:** the `.app` bundles in the folders the system and the user install to.
//! - **Windows:** the Start menu as `Get-StartApps` lists it — the one list with the Store apps in it
//!   (the new Teams is one), each with the id Explorer launches it by — and the Start menu's
//!   shortcuts when PowerShell does not answer.
//!
//! Listed once and kept ten minutes: an app installed meanwhile is found on the next look after that.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::codi::router::normalize;

/// One installed app.
#[derive(Debug, Clone, PartialEq)]
pub struct App {
    pub name: String,
    pub launch: Launch,
}

/// How an app is started.
#[derive(Debug, Clone, PartialEq)]
pub enum Launch {
    /// A bundle, a shortcut or an executable: handed to the system's opener.
    Path(PathBuf),
    /// A Windows Start-menu id (`MSTeams_8wekyb3d8bbwe!MSTeams`): `shell:AppsFolder\<id>`.
    #[cfg_attr(not(windows), allow(dead_code))]
    AppId(String),
}

const KEPT: Duration = Duration::from_secs(600);

/// The installed apps, from the last ten minutes' look or a new one.
pub fn installed() -> Vec<App> {
    static CACHE: Mutex<Option<(Instant, Vec<App>)>> = Mutex::new(None);
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, apps)) = cache.as_ref() {
            if at.elapsed() < KEPT && !apps.is_empty() {
                return apps.clone();
            }
        }
    }
    let apps = list();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), apps.clone()));
    }
    apps
}

#[cfg(target_os = "macos")]
fn list() -> Vec<App> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
        PathBuf::from("/System/Library/CoreServices/Finder.app"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }
    let mut apps = Vec::new();
    for root in roots {
        if root.extension().is_some_and(|e| e == "app") {
            push_bundle(&mut apps, root);
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "app") {
                push_bundle(&mut apps, path);
            } else if path.is_dir() && !path.ends_with("Utilities") {
                // A vendor's folder («Microsoft Office», «Adobe…»): its bundles, one level down.
                if let Ok(inner) = std::fs::read_dir(&path) {
                    for app in inner.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "app")) {
                        push_bundle(&mut apps, app);
                    }
                }
            }
        }
    }
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.name == b.name);
    apps
}

#[cfg(target_os = "macos")]
fn push_bundle(apps: &mut Vec<App>, path: PathBuf) {
    if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
        apps.push(App { name: name.to_string(), launch: Launch::Path(path.clone()) });
    }
}

#[cfg(windows)]
fn list() -> Vec<App> {
    let mut apps = start_apps().unwrap_or_default();
    if apps.is_empty() {
        apps = start_menu_shortcuts();
    }
    apps.sort_by(|a, b| a.name.cmp(&b.name));
    apps.dedup_by(|a, b| a.name == b.name);
    apps
}

/// `Get-StartApps`: every app the Start menu shows, Store apps included, with its launch id.
#[cfg(windows)]
fn start_apps() -> Option<Vec<App>> {
    let mut command = std::process::Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"]);
    crate::proc::hide_console_std(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let rows = match value {
        serde_json::Value::Array(rows) => rows,
        one @ serde_json::Value::Object(_) => vec![one],
        _ => return None,
    };
    Some(
        rows.iter()
            .filter_map(|row| {
                let name = row.get("Name")?.as_str()?.trim().to_string();
                let id = row.get("AppID")?.as_str()?.trim().to_string();
                (!name.is_empty() && !id.is_empty()).then(|| {
                    // A desktop app's "id" is often its executable's path: launched as a path.
                    let launch = if std::path::Path::new(&id).is_absolute() { Launch::Path(PathBuf::from(id)) } else { Launch::AppId(id) };
                    App { name, launch }
                })
            })
            .collect(),
    )
}

/// The Start menu's shortcuts, the user's and everyone's.
#[cfg(windows)]
fn start_menu_shortcuts() -> Vec<App> {
    let mut roots = Vec::new();
    if let Some(data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(data) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    let mut apps = Vec::new();
    let mut stack = roots;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for path in entries.flatten().map(|e| e.path()) {
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("lnk") || e.eq_ignore_ascii_case("url")) {
                if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                    apps.push(App { name: name.to_string(), launch: Launch::Path(path.clone()) });
                }
            }
        }
    }
    apps
}

#[cfg(not(any(target_os = "macos", windows)))]
fn list() -> Vec<App> {
    Vec::new()
}

/// Starts `app`, or brings it forward when it is already running.
pub fn launch(app: &App) -> Result<(), String> {
    match &app.launch {
        #[cfg(target_os = "macos")]
        Launch::Path(path) => {
            let status = std::process::Command::new("open").arg("-a").arg(path).status().map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("{} did not open", app.name))
            }
        }
        #[cfg(not(target_os = "macos"))]
        Launch::Path(path) => open::that_detached(path).map_err(|e| format!("{} did not open: {e}", app.name)),
        Launch::AppId(id) => {
            let mut command = std::process::Command::new("explorer.exe");
            command.arg(format!(r"shell:AppsFolder\{id}"));
            // explorer.exe answers 1 even when it opened the app: only a failure to start counts.
            command.spawn().map(|_| ()).map_err(|e| format!("{} did not open: {e}", app.name))
        }
    }
}

/// What [`find`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum Found {
    One(App),
    /// Several, equally good: their names.
    Several(Vec<String>),
    /// None; the nearest names, at most three.
    None(Vec<String>),
}

/// What people call an app, against what it is installed as.
const SPOKEN: &[(&str, &[&str])] = &[
    ("correo", &["outlook", "mail", "correo"]),
    ("email", &["outlook", "mail"]),
    ("mail", &["outlook", "mail"]),
    ("calculadora", &["calculator", "calculadora"]),
    ("ajustes", &["system settings", "settings", "configuracion"]),
    ("configuracion", &["system settings", "settings", "configuracion"]),
    ("configuracion del sistema", &["system settings", "settings"]),
    ("explorador de archivos", &["finder", "file explorer", "explorador de archivos"]),
    ("archivos", &["finder", "file explorer"]),
    ("musica", &["music", "spotify"]),
    ("calendario", &["calendar", "calendario", "outlook"]),
    ("notas", &["notes", "notas"]),
    ("vscode", &["visual studio code"]),
    ("vs code", &["visual studio code"]),
    ("word", &["microsoft word", "word"]),
    ("excel", &["microsoft excel", "excel"]),
    ("powerpoint", &["microsoft powerpoint", "powerpoint"]),
    ("teams", &["microsoft teams", "teams"]),
    ("chrome", &["google chrome", "chrome"]),
    ("guasap", &["whatsapp"]),
    ("wasap", &["whatsapp"]),
    ("whatsap", &["whatsapp"]),
    ("chat", &["chatgpt"]),
    ("edge", &["microsoft edge", "edge"]),
    ("terminal", &["terminal", "windows terminal", "iterm"]),
];

/// The installed app `spoken` names: by its whole name, by the start of its words («teams» →
/// «Microsoft Teams»), by a part of it, by what people call it («correo» → Outlook), or by how it
/// sounds — what dictation writes for a name it does not know («chat gbt», «chat ge pe te» →
/// «ChatGPT»). Of several, the one every other one's name contains wins («Microsoft Teams» over
/// «Microsoft Teams (work or school)»); otherwise they are named back. Nothing like it, but one name
/// a letter or two away from it: that one.
pub fn find(apps: &[App], spoken: &str) -> Found {
    let names: Vec<&str> = apps.iter().map(|app| app.name.as_str()).collect();
    match pick(&names, spoken) {
        Picked::One(i) => Found::One(apps[i].clone()),
        Picked::Several(found) => Found::Several(found.into_iter().take(4).map(|i| apps[i].name.clone()).collect()),
        Picked::None(near) => Found::None(near.into_iter().map(|i| apps[i].name.clone()).collect()),
    }
}

/// [`find`]'s rule over plain names — also how a window is picked by its app's name (`read`).
#[derive(Debug, Clone, PartialEq)]
pub enum Picked {
    One(usize),
    Several(Vec<usize>),
    /// The nearest, at most three.
    None(Vec<usize>),
}

/// Words said before an app's name that are not part of it: «abre **la app de** Teams».
const LEADS: &[&str] = &["la", "el", "los", "las", "app", "aplicacion", "programa", "de", "del", "the", "application"];

/// Letters as Spanish says them: «ge pe te» is how «GPT» is spoken, and dictation writes it so.
/// The vowels and «de» are left out — as words they are far likelier than as letters.
const LETTERS: &[(&str, char)] = &[
    ("be", 'b'), ("ce", 'c'), ("efe", 'f'), ("ge", 'g'), ("hache", 'h'), ("jota", 'j'), ("ka", 'k'), ("ele", 'l'), ("eme", 'm'),
    ("ene", 'n'), ("pe", 'p'), ("cu", 'q'), ("erre", 'r'), ("ese", 's'), ("te", 't'), ("uve", 'v'), ("ve", 'v'), ("equis", 'x'),
    ("ye", 'y'), ("zeta", 'z'),
];

/// `normalized` with two or more spelled letters in a row joined into what they spell.
fn spelled(normalized: &str) -> String {
    let words: Vec<&str> = normalized.split(' ').collect();
    let letter = |w: &str| LETTERS.iter().find(|(name, _)| *name == w).map(|(_, c)| *c);
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        let run: String = words[i..].iter().map_while(|w| letter(w)).collect();
        if run.chars().count() >= 2 {
            i += run.chars().count();
            out.push(run);
        } else {
            out.push(words[i].to_string());
            i += 1;
        }
    }
    out.join(" ")
}

/// How a name sounds, roughly, to compare what dictation heard with how the app is written: no
/// spaces, the letters people and dictation mix up folded together (b/p/v, d/t, c/k/q/g, s/z, i/y),
/// no «h», no doubled letters.
fn sound(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.replace("ph", "f").chars().filter(|c| c.is_alphanumeric()) {
        let c = match c {
            'p' | 'v' => 'b',
            'd' => 't',
            'c' | 'q' | 'g' => 'k',
            'z' => 's',
            'y' => 'i',
            'w' => 'u',
            'h' => continue,
            other => other,
        };
        if !out.ends_with(c) {
            out.push(c);
        }
    }
    out
}

/// One way a name can answer to what was said.
type Tier<'a> = dyn Fn(&str, &str) -> bool + 'a;

pub fn pick(names: &[&str], spoken: &str) -> Picked {
    let mut wanted = normalize(spoken);
    while let Some(rest) = LEADS.iter().find_map(|lead| wanted.strip_prefix(&format!("{lead} ")).map(str::to_string)) {
        wanted = rest;
    }
    if wanted.is_empty() {
        return Picked::None(Vec::new());
    }
    let named: Vec<String> = names.iter().map(|name| normalize(name)).collect();
    let squash = |s: &str| s.replace(' ', "");
    let mut targets = vec![wanted.clone()];
    let joined = spelled(&wanted);
    if joined != wanted {
        targets.push(joined);
    }
    if let Some((_, others)) = SPOKEN.iter().find(|(said, _)| *said == wanted) {
        targets.extend(others.iter().map(|o| o.to_string()));
    }
    let tiers: [&Tier<'_>; 5] = [
        &|name, want| name == want,
        &|name, want| {
            let own: Vec<&str> = name.split(' ').collect();
            want.split(' ').all(|w| own.iter().any(|o| o.starts_with(w)))
        },
        &|name, want| want.len() >= 3 && squash(name).contains(&squash(want)),
        &|name, want| sound(name) == sound(want),
        &|name, want| sound(want).len() >= 4 && sound(name).contains(&sound(want)),
    ];
    for tier in tiers {
        for target in &targets {
            let hits: Vec<usize> = (0..named.len()).filter(|&i| tier(&named[i], target)).collect();
            match hits.len() {
                0 => continue,
                1 => return Picked::One(hits[0]),
                _ => {
                    let shortest = *hits.iter().min_by_key(|&&i| named[i].len()).expect("not empty");
                    if hits.iter().all(|&i| named[i].contains(&named[shortest])) {
                        return Picked::One(shortest);
                    }
                    return Picked::Several(hits);
                }
            }
        }
    }
    let heard = sound(&spelled(&wanted));
    let mut near: Vec<(usize, usize)> =
        (0..named.len()).map(|i| (distance(&heard, &sound(&named[i])), i)).filter(|(d, _)| *d <= (heard.len() / 3).max(2)).collect();
    near.sort();
    // One name a slip away, and nothing as close: that is the one meant («notioon» → Notion).
    if let [(best, i), rest @ ..] = near.as_slice() {
        if *best <= (heard.len() / 5).max(1) && rest.first().is_none_or(|(next, _)| next > best) {
            return Picked::One(*i);
        }
    }
    Picked::None(near.into_iter().take(3).map(|(_, i)| i).collect())
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            current.push((previous[j] + usize::from(ca != *cb)).min(previous[j + 1] + 1).min(current[j] + 1));
        }
        previous = current;
    }
    previous[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str) -> App {
        App { name: name.into(), launch: Launch::Path(PathBuf::from(format!("/Applications/{name}.app"))) }
    }

    fn apps() -> Vec<App> {
        ["Microsoft Teams", "Microsoft Teams (work or school)", "Microsoft Outlook", "Google Chrome", "Visual Studio Code", "Calculator", "Notes", "Notion"]
            .into_iter()
            .map(app)
            .collect()
    }

    #[test]
    fn an_app_is_found_by_the_name_people_give_it() {
        let apps = apps();
        let one = |spoken: &str| match find(&apps, spoken) {
            Found::One(app) => app.name,
            other => panic!("{spoken}: {other:?}"),
        };
        assert_eq!(one("teams"), "Microsoft Teams");
        assert_eq!(one("Teams"), "Microsoft Teams");
        assert_eq!(one("la app de chrome").as_str(), "Google Chrome");
        assert_eq!(one("chrome"), "Google Chrome");
        assert_eq!(one("vs code"), "Visual Studio Code");
        assert_eq!(one("correo"), "Microsoft Outlook");
        assert_eq!(one("calculadora"), "Calculator");
        assert_eq!(one("visual studio"), "Visual Studio Code");
    }

    #[test]
    fn several_or_none_are_said_back() {
        let apps = apps();
        assert_eq!(find(&apps, "no"), Found::Several(vec!["Notes".into(), "Notion".into()]));
        assert_eq!(find(&apps, "photoshop"), Found::None(Vec::new()));
    }

    #[test]
    fn a_name_dictation_misheard_still_finds_its_app() {
        let mut apps = apps();
        apps.push(app("ChatGPT"));
        apps.push(app("WhatsApp"));
        let one = |spoken: &str| match find(&apps, spoken) {
            Found::One(app) => app.name,
            other => panic!("{spoken}: {other:?}"),
        };
        assert_eq!(one("chat gbt"), "ChatGPT");
        assert_eq!(one("chat gpt"), "ChatGPT");
        assert_eq!(one("chat ge pe te"), "ChatGPT");
        assert_eq!(one("la aplicación de chat gbt"), "ChatGPT");
        assert_eq!(one("guasap"), "WhatsApp");
        assert_eq!(one("notioon"), "Notion");
        assert_eq!(one("crome"), "Google Chrome");
    }
}
