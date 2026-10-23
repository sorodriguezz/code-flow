//! The computer outside CodeFlow, for Codi (the user, 2026-10-22: «que pueda interactuar con otras
//! apps del PC… abrir navegador… leer mensajes de Teams»):
//!
//! - [`open`]: an installed app by the name a person gives it, a web address, a Google search, a file
//!   or a folder — the system's own launcher does the opening (`open -a`, Explorer's AppsFolder).
//! - [`apps`]: the installed apps, found where each system lists them.
//! - [`read`]: what another app's window says, through the system's accessibility API — text, not
//!   pixels, read on this machine — with an OCR'd screenshot as the fallback, held in memory and
//!   dropped (see `read`'s note).
//!
//! Nothing here clicks, types or sends: Codi reads and opens. What would act on another app is a
//! door this module does not have.

pub mod apps;
pub mod read;

use serde::Serialize;

/// What [`open`] did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// `app` · `url` · `search` · `path`.
    pub kind: &'static str,
    /// What was opened, as it is called: the app's name, the address, the query, the path.
    pub name: String,
}

/// Why [`open`] could not: said in the user's language, with the apps whose names are nearest
/// when the name was an app nobody installed — what Codi offers instead («¿Quisiste decir…?»).
#[derive(Debug, Clone, PartialEq)]
pub struct NotOpened {
    pub message: String,
    pub near: Vec<String>,
}

impl NotOpened {
    fn plain(message: String) -> Self {
        NotOpened { message, near: Vec::new() }
    }
}

impl std::fmt::Display for NotOpened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// What a target given by voice or by a routine is.
#[derive(Debug, Clone, PartialEq)]
enum Target {
    Url(String),
    Path(std::path::PathBuf),
    App(String),
}

/// Words that mean the web browser rather than an app called that.
const BROWSER: &[&str] = &["navegador", "el navegador", "browser", "the browser", "internet", "navegador web", "web browser"];

fn classify(target: &str) -> Target {
    let target = target.trim();
    let lower = target.to_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:") {
        return Target::Url(target.to_string());
    }
    // `~/Documentos`, an absolute path, or one that is there.
    let expanded = match target.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|home| home.join(rest)),
        None => Some(std::path::PathBuf::from(target)),
    };
    if let Some(path) = expanded.filter(|p| (p.is_absolute() && p.exists()) || target.starts_with("~/") && p.exists()) {
        return Target::Path(path);
    }
    // `google.com`, `www.emol.com`, `intranet.achs.cl/x`: a host with a dot and no spaces.
    let host = lower.split('/').next().unwrap_or("");
    if !lower.contains(' ') && host.contains('.') && host.rsplit('.').next().is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic())) {
        return Target::Url(format!("https://{target}"));
    }
    Target::App(target.to_string())
}

/// The address of a Google search for `query`.
pub fn search_url(query: &str) -> String {
    let mut url = url::Url::parse("https://www.google.com/search").expect("a fixed address");
    url.query_pairs_mut().append_pair("q", query.trim());
    url.into()
}

/// Opens `target` — an app by name («teams», «el navegador», «Visual Studio Code»), a web address
/// («emol.com»), a file or a folder. An app nobody has installed under anything like that name is an
/// error naming the nearest ones.
pub fn open(target: &str, es: bool) -> Result<Opened, NotOpened> {
    let target = target.trim();
    let say = |es_text: String, en_text: String| NotOpened::plain(if es { es_text } else { en_text });
    if target.is_empty() {
        return Err(say("falta decir qué abrir".into(), "say what to open".into()));
    }
    if BROWSER.contains(&crate::codi::router::normalize(target).as_str()) {
        let address = "https://www.google.com";
        open::that_detached(address).map_err(|e| NotOpened::plain(e.to_string()))?;
        return Ok(Opened { kind: "url", name: address.into() });
    }
    match classify(target) {
        Target::Url(address) => {
            open::that_detached(&address).map_err(|e| say(format!("no se pudo abrir {address}: {e}"), format!("could not open {address}: {e}")))?;
            Ok(Opened { kind: "url", name: address })
        }
        Target::Path(path) => {
            let shown = path.display().to_string();
            open::that_detached(&path).map_err(|e| say(format!("no se pudo abrir {shown}: {e}"), format!("could not open {shown}: {e}")))?;
            Ok(Opened { kind: "path", name: shown })
        }
        Target::App(name) => {
            let installed = apps::installed();
            match apps::find(&installed, &name) {
                apps::Found::One(app) => {
                    apps::launch(&app).map_err(NotOpened::plain)?;
                    Ok(Opened { kind: "app", name: app.name })
                }
                apps::Found::Several(names) => {
                    let list = names.join(", ");
                    Err(say(format!("«{name}» puede ser {list}: di cuál"), format!("«{name}» could be {list}: say which")))
                }
                apps::Found::None(near) if near.is_empty() => {
                    Err(say(format!("no hay ninguna app instalada que se llame «{name}»"), format!("no installed app is called «{name}»")))
                }
                apps::Found::None(near) => {
                    let list = near.join(", ");
                    let message = if es {
                        format!("no hay ninguna app instalada que se llame «{name}»; las más parecidas son {list}")
                    } else {
                        format!("no installed app is called «{name}»; the nearest are {list}")
                    };
                    Err(NotOpened { message, near })
                }
            }
        }
    }
}

/// Opens a Google search for `query` in the default browser.
pub fn open_search(query: &str) -> Result<Opened, String> {
    if query.trim().is_empty() {
        return Err("say what to search for".into());
    }
    open::that_detached(search_url(query)).map_err(|e| e.to_string())?;
    Ok(Opened { kind: "search", name: query.trim().to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_is_read_as_what_it_looks_like() {
        assert_eq!(classify("https://x.cl/a b"), Target::Url("https://x.cl/a b".into()));
        assert_eq!(classify("emol.com"), Target::Url("https://emol.com".into()));
        assert_eq!(classify("intranet.achs.cl/portal"), Target::Url("https://intranet.achs.cl/portal".into()));
        assert_eq!(classify("teams"), Target::App("teams".into()));
        assert_eq!(classify("Visual Studio Code"), Target::App("Visual Studio Code".into()));
        // A version number is not a host.
        assert_eq!(classify("python 3.12"), Target::App("python 3.12".into()));
        let here = std::env::temp_dir();
        assert_eq!(classify(&here.display().to_string()), Target::Path(here));
    }

    #[test]
    fn a_search_is_an_escaped_google_address() {
        assert_eq!(search_url("tiempo San Miguel"), "https://www.google.com/search?q=tiempo+San+Miguel");
        assert_eq!(search_url("c++ & rust"), "https://www.google.com/search?q=c%2B%2B+%26+rust");
    }
}
