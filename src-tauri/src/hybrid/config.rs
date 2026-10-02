//! The executor's settings, read from `app_settings` in one place.
//!
//! Every key here is written by the settings pane through the generic `set_setting` command (which
//! announces `settings:changed`, so the frontend store re-reads on its own). What is stored is the
//! user's *choice*; an absent key means "decide for me", and the deciding happens where the facts
//! are — [`crate::commands::localexec_cmd`] knows which servers answer and how much memory the
//! machine has, this module does not.

use rusqlite::Connection;

use super::budget::Delegate;
use super::local_llm::BackendKind;
use crate::db::queries;

pub const KEY_BACKEND: &str = "local_exec_backend";
/// One URL per server kind, so switching from Ollama to LM Studio and back does not lose either.
pub const KEY_URL_OLLAMA: &str = "local_exec_url_ollama";
pub const KEY_URL_OPENAI: &str = "local_exec_url_openai";
/// One model per server kind, for the same reason: an Ollama tag means nothing to LM Studio.
pub const KEY_MODEL_BUNDLED: &str = "local_exec_model_bundled";
pub const KEY_MODEL_OLLAMA: &str = "local_exec_model_ollama";
pub const KEY_MODEL_OPENAI: &str = "local_exec_model_openai";
pub const KEY_CTX: &str = "local_exec_ctx";
pub const KEY_DELEGATE: &str = "local_exec_delegate";
pub const KEY_ON_FAIL: &str = "local_exec_on_fail";
pub const KEY_UNLOAD: &str = "local_exec_unload";
pub const KEY_REVIEW_MODE: &str = "hybrid_review_mode";

/// Keychain entry for the optional Bearer key of an OpenAI-compatible server. Never a settings row:
/// backups copy tables whole.
pub const SECRET_KEY: &str = "local-exec-api-key";

/// What happens to a task the local model could not do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OnFail {
    /// The review step implements it (the default: the subscription is the safety net).
    Review,
    /// It is reported and left undone.
    Skip,
}

/// What the review step may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewMode {
    /// The local fix loop: the review does the tasks that are its own and hands every correction
    /// back to the local model as a task, for up to `prompts::MAX_FIX_ROUNDS` rounds; the review
    /// after the last one finishes the work itself. The default — corrections are code, and code is
    /// what the local model is there to write.
    Local,
    /// Fix what is wrong and do the tasks handed back (writes).
    Fix,
    /// Report only, enforced read-only.
    Report,
}

impl ReviewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Fix => "fix",
            Self::Report => "report",
        }
    }

    pub fn from_setting(raw: &str) -> Option<Self> {
        match raw.trim() {
            "local" => Some(Self::Local),
            "fix" => Some(Self::Fix),
            "report" => Some(Self::Report),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    /// `None`: never chosen — the command layer picks the first server that answers.
    pub backend: Option<BackendKind>,
    pub url_ollama: Option<String>,
    pub url_openai: Option<String>,
    pub model_bundled: Option<String>,
    pub model_ollama: Option<String>,
    pub model_openai: Option<String>,
    /// `None`: suggested from the model and the machine.
    pub ctx: Option<u32>,
    /// `None`: suggested from the model's size.
    pub delegate: Option<Delegate>,
    pub on_fail: OnFail,
    pub unload: bool,
    pub review_mode: ReviewMode,
}

impl Settings {
    pub fn url_for(&self, kind: BackendKind) -> String {
        let chosen = match kind {
            BackendKind::Ollama => self.url_ollama.as_deref(),
            BackendKind::Openai => self.url_openai.as_deref(),
            BackendKind::Bundled => None,
        };
        chosen
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .unwrap_or(kind.default_url())
            .to_string()
    }

    pub fn model_for(&self, kind: BackendKind) -> Option<String> {
        match kind {
            BackendKind::Bundled => self.model_bundled.clone(),
            BackendKind::Ollama => self.model_ollama.clone(),
            BackendKind::Openai => self.model_openai.clone(),
        }
        .filter(|model| !model.trim().is_empty())
    }
}

pub fn read(conn: &Connection) -> Result<Settings, String> {
    let keys: Vec<String> = [
        KEY_BACKEND,
        KEY_URL_OLLAMA,
        KEY_URL_OPENAI,
        KEY_MODEL_BUNDLED,
        KEY_MODEL_OLLAMA,
        KEY_MODEL_OPENAI,
        KEY_CTX,
        KEY_DELEGATE,
        KEY_ON_FAIL,
        KEY_UNLOAD,
        KEY_REVIEW_MODE,
    ]
    .iter()
    .map(|key| key.to_string())
    .collect();
    let values = queries::get_settings(conn, &keys).map_err(|e| e.to_string())?;
    let get = |key: &str| values.get(key).map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    Ok(Settings {
        backend: get(KEY_BACKEND).and_then(|raw| BackendKind::from_setting(&raw)),
        url_ollama: get(KEY_URL_OLLAMA),
        url_openai: get(KEY_URL_OPENAI),
        model_bundled: get(KEY_MODEL_BUNDLED),
        model_ollama: get(KEY_MODEL_OLLAMA),
        model_openai: get(KEY_MODEL_OPENAI),
        ctx: get(KEY_CTX).and_then(|raw| raw.parse::<u32>().ok()).filter(|&ctx| ctx >= 2_048),
        delegate: get(KEY_DELEGATE).and_then(|raw| Delegate::from_setting(&raw)),
        on_fail: match get(KEY_ON_FAIL).as_deref() {
            Some("skip") => OnFail::Skip,
            _ => OnFail::Review,
        },
        // Default on: the model was loaded for this run, and holding gigabytes afterwards is the
        // surprising choice, not the safe one.
        unload: get(KEY_UNLOAD).as_deref() != Some("0"),
        review_mode: match get(KEY_REVIEW_MODE).as_deref() {
            Some("report") => ReviewMode::Report,
            Some("fix") => ReviewMode::Fix,
            _ => ReviewMode::Local,
        },
    })
}

/// The optional API key, from the keychain.
pub fn api_key() -> Option<String> {
    crate::secrets::get_secret(SECRET_KEY).ok().flatten().filter(|key| !key.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().expect("db");
        conn.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);").expect("table");
        conn
    }

    #[test]
    fn nothing_stored_means_decide_for_me() {
        let settings = read(&conn()).expect("read");
        assert_eq!(settings.backend, None);
        assert_eq!(settings.ctx, None);
        assert_eq!(settings.delegate, None);
        assert_eq!(settings.on_fail, OnFail::Review);
        assert!(settings.unload);
        assert_eq!(settings.review_mode, ReviewMode::Local);
        assert_eq!(settings.url_for(BackendKind::Ollama), "http://127.0.0.1:11434");
        assert_eq!(settings.model_for(BackendKind::Ollama), None);
    }

    #[test]
    fn stored_choices_are_read_back() {
        let conn = conn();
        for (key, value) in [
            (KEY_BACKEND, "openai"),
            (KEY_URL_OPENAI, "http://127.0.0.1:4000"),
            (KEY_MODEL_OPENAI, "qwen-coder"),
            (KEY_CTX, "32768"),
            (KEY_DELEGATE, "all"),
            (KEY_ON_FAIL, "skip"),
            (KEY_UNLOAD, "0"),
            (KEY_REVIEW_MODE, "report"),
        ] {
            queries::set_setting(&conn, key, value).expect("write");
        }
        let settings = read(&conn).expect("read");
        assert_eq!(settings.backend, Some(BackendKind::Openai));
        assert_eq!(settings.url_for(BackendKind::Openai), "http://127.0.0.1:4000");
        assert_eq!(settings.model_for(BackendKind::Openai).as_deref(), Some("qwen-coder"));
        assert_eq!(settings.ctx, Some(32_768));
        assert_eq!(settings.delegate, Some(Delegate::All));
        assert_eq!(settings.on_fail, OnFail::Skip);
        assert!(!settings.unload);
        assert_eq!(settings.review_mode, ReviewMode::Report);
    }

    #[test]
    fn junk_values_fall_back_rather_than_fail() {
        let conn = conn();
        queries::set_setting(&conn, KEY_BACKEND, "gpt-cloud").unwrap();
        queries::set_setting(&conn, KEY_CTX, "lots").unwrap();
        let settings = read(&conn).expect("read");
        assert_eq!(settings.backend, None);
        assert_eq!(settings.ctx, None);
    }
}
