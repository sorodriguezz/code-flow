use keyring::Entry;

const SERVICE: &str = "com.codeflow.app";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Stores a secret (PAT, token, etc.) in the OS-native credential store
/// (Windows Credential Manager / macOS Keychain). Never touches disk in plain text.
pub fn set_secret(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(|e| e.to_string())
}

pub fn get_secret(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Deterministic key naming so callers don't have to remember conventions.
pub fn ado_pat_key(org: &str) -> String {
    format!("ado-pat:{org}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = ado_pat_key("diagnostic-test-org");
        set_secret(&key, "hello-token-123").expect("set_secret failed");
        let got = get_secret(&key).expect("get_secret errored");
        assert_eq!(got, Some("hello-token-123".to_string()));
        delete_secret(&key).expect("delete_secret failed");
    }
}
