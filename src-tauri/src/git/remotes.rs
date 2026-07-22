use serde::{Deserialize, Serialize};

use super::repo::open;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

pub fn list_remotes(path: &str) -> Result<Vec<RemoteInfo>, String> {
    let repo = open(path)?;
    let names = repo.remotes().map_err(|e| e.message().to_string())?;
    let mut result = Vec::new();
    for name in names.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            result.push(RemoteInfo {
                name: name.to_string(),
                url: remote.url().unwrap_or("").to_string(),
            });
        }
    }
    Ok(result)
}

pub fn set_remote_url(path: &str, name: &str, url: &str) -> Result<(), String> {
    let repo = open(path)?;
    repo.remote_set_url(name, url).map_err(|e| e.message().to_string())?;
    repo.remote_set_pushurl(name, Some(url))
        .map_err(|e| e.message().to_string())?;
    Ok(())
}
