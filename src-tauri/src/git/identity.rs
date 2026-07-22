use git2::Config;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Reads/writes the global git identity (`git config --global user.name/user.email`),
/// which is what `repo.signature()` falls back to for any repo that doesn't override it.
pub fn get_identity() -> Result<GitIdentity, String> {
    let config = Config::open_default().map_err(|e| e.message().to_string())?;
    Ok(GitIdentity {
        name: config.get_string("user.name").ok(),
        email: config.get_string("user.email").ok(),
    })
}

pub fn set_identity(name: &str, email: &str) -> Result<(), String> {
    let mut config = Config::open_default().map_err(|e| e.message().to_string())?;
    config.set_str("user.name", name).map_err(|e| e.message().to_string())?;
    config.set_str("user.email", email).map_err(|e| e.message().to_string())?;
    Ok(())
}
