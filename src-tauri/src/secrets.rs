use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::Entry;

const SERVICE: &str = "com.codeflow.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Secrets already read from (or written to) the OS store during this app session.
///
/// macOS asks for the login password whenever an app reads a Keychain item whose ACL doesn't
/// recognize the app's code signature — which is every build of an app signed ad-hoc rather than
/// with a stable Developer ID. Without a signing certificate that first prompt can't be avoided,
/// but *repeating* it can: after the first read a value is served from here, so a token costs at
/// most one prompt per session instead of one per repo opened, pull-request list, or review.
/// A missing entry is cached as `None` for the same reason — "is a token saved?" is asked just as
/// often as "what is it?". A read that *errors* (including the user dismissing the prompt) is
/// deliberately not cached, so the next attempt asks again rather than inheriting a false miss.
///
/// The trade is that tokens stay resident in the process for as long as it runs, rather than only
/// for the length of a request. Set/delete write through, so a credential changed in Settings
/// takes effect immediately.
fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// A poisoned cache is never a reason to fail a credential operation — the OS store stays
/// authoritative, so the worst case of skipping the cache is the prompt we were avoiding.
fn remember(key: &str, value: Option<String>) {
    if let Ok(mut cache) = cache().lock() {
        cache.insert(key.to_string(), value);
    }
}

/// Stores a secret (PAT, token, etc.) in the OS-native credential store
/// (Windows Credential Manager / macOS Keychain). Never touches disk in plain text.
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())?;
    remember(key, Some(value.to_string()));
    Ok(())
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    if let Ok(cache) = cache().lock() {
        if let Some(hit) = cache.get(key) {
            return Ok(hit.clone());
        }
    }
    let value = match entry(key)?.get_password() {
        Ok(value) => Some(value),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => return Err(e.to_string()),
    };
    remember(key, value.clone());
    Ok(value)
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            remember(key, None);
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Deterministic key naming so callers don't have to remember conventions.
pub fn ado_pat_key(org: &str) -> String {
    format!("ado-pat:{org}")
}

/// GitHub's REST API authenticates one token against every repo/org the account can see, so
/// the token is stored per host (`github.com`) rather than per owner the way Azure DevOps is
/// keyed per org — leaving room for a GitHub Enterprise host later without changing the shape.
pub fn github_token_key(host: &str) -> String {
    format!("github-token:{host}")
}

/// API key for an HTTP AI provider (OpenAI and any OpenAI-compatible endpoint). Keyed per
/// provider id so several can be configured side by side, and kept in the OS credential store
/// rather than `app_settings` — unlike a binary path or a model id, this is a real credential.
pub fn ai_api_key(provider: &str) -> String {
    format!("ai-api-key:{provider}")
}

/// Passphrase the API-client backup is encrypted with. In the credential store rather than in
/// `app_settings` for the obvious reason, and there is exactly one: the automatic backup has to be
/// able to write the file unattended, which it cannot do if the only copy is in the user's head.
pub fn api_backup_passphrase_key() -> String {
    "api-backup-passphrase".to_string()
}

/// The user's own Google OAuth client secret. For an installed app this is not a secret in the
/// cryptographic sense — Google says as much — but it is still theirs, and `app_settings` is a
/// plain SQLite file that ends up in a support bundle far more easily than the credential store.
pub fn gdrive_client_secret_key() -> String {
    "gdrive-client-secret".to_string()
}

/// The long-lived grant. This one *is* a credential: it can mint access tokens for the backup file
/// until the user revokes it.
pub fn gdrive_refresh_token_key() -> String {
    "gdrive-refresh-token".to_string()
}

/// The anon key of the user's own Supabase project. Public by design, but it is still the key to
/// *their* project and belongs beside the share tokens rather than in a settings blob.
pub fn supabase_anon_key() -> String {
    "supabase-anon-key".to_string()
}

/// The share token for one shared workspace — the whole credential for reaching it, so keyed per
/// workspace: hosting one and being a guest in another are the normal case, not an edge one.
pub fn supabase_share_token(workspace_id: &str) -> String {
    format!("supabase-share:{workspace_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forget(key: &str) {
        if let Ok(mut cache) = cache().lock() {
            cache.remove(key);
        }
    }

    #[test]
    fn roundtrip() {
        let key = ado_pat_key("diagnostic-test-org");
        set_secret(&key, "hello-token-123").expect("set_secret failed");
        // Evict first, so this exercises the OS store itself rather than the session cache
        // sitting in front of it.
        forget(&key);
        let got = get_secret(&key).expect("get_secret errored");
        assert_eq!(got, Some("hello-token-123".to_string()));
        delete_secret(&key).expect("delete_secret failed");
        forget(&key);
        assert_eq!(get_secret(&key).expect("get_secret errored"), None);
    }

    /// The cache is what keeps macOS from asking for the login password on every repo switch, so
    /// it gets its own test: a key never written to the OS store still reads back once cached.
    #[test]
    fn reads_are_served_from_the_session_cache() {
        let key = ado_pat_key("cache-only-test-org");
        remember(&key, Some("cached-value".to_string()));
        assert_eq!(get_secret(&key).expect("get_secret errored"), Some("cached-value".to_string()));
    }
}
