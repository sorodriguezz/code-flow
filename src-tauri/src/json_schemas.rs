//! JSON schemas for the editor — SchemaStore's catalogue and the schemas it points at, fetched on
//! demand and kept on disk.
//!
//! Monaco's JSON worker validates and completes against a schema it is *handed*; with
//! `enableSchemaRequest` it would fetch one itself, from inside the webview, where the CSP stops it.
//! So the backend fetches, and the editor registers the text (`lib/jsonSchemas.ts`). VS Code does the
//! same download (`json.schemaDownload.enable`, on by default); the switch here is Settings › Editor.
//!
//! Cached under `cache_dir()/json-schemas`, one file per URL. A schema changes rarely and a file
//! opened offline should still validate, so a copy older than [`FRESH`] is refetched when the network
//! answers and served as it is when it does not.

use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// SchemaStore's index: every schema it holds, with the file names each one is for.
pub const CATALOG_URL: &str = "https://www.schemastore.org/api/json/catalog.json";

/// How long a cached copy is used without asking again.
const FRESH: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// The largest schema accepted. SchemaStore's biggest are a few hundred KB; anything near this is
/// not a schema the editor should parse on every keystroke.
const MAX_BYTES: usize = 8 * 1024 * 1024;

const TIMEOUT: Duration = Duration::from_secs(20);

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("CodeFlow")
                .build()
                .unwrap_or_default()
        })
        .clone()
}

fn cache_path(url: &str) -> PathBuf {
    let digest = hex::encode(Sha256::digest(url.as_bytes()));
    crate::paths::cache_dir().join("json-schemas").join(format!("{digest}.json"))
}

/// Only plain web addresses: a `$schema` is written by whoever wrote the file, and `file://` or a
/// private address is not something opening a JSON file should make this app read.
fn allowed(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    if !matches!(parsed.scheme(), "https" | "http") {
        return false;
    }
    match parsed.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            host != "localhost" && !host.ends_with(".localhost") && !host.ends_with(".local") && host.contains('.')
        }
        // A literal IP is never where a published schema lives, and is how a private one is reached.
        _ => false,
    }
}

fn is_fresh(path: &PathBuf) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < FRESH)
}

/// The schema at `url`, from the cache when it is fresh, else from the network — falling back to a
/// stale copy when the network fails.
pub async fn fetch(url: &str) -> Result<String, String> {
    if !allowed(url) {
        return Err(format!("not a public schema address: {url}"));
    }
    let path = cache_path(url);
    if is_fresh(&path) {
        if let Ok(text) = tokio::fs::read_to_string(&path).await {
            return Ok(text);
        }
    }
    match download(url).await {
        Ok(text) => {
            if let Some(dir) = path.parent() {
                let _ = tokio::fs::create_dir_all(dir).await;
            }
            let _ = tokio::fs::write(&path, &text).await;
            Ok(text)
        }
        Err(error) => tokio::fs::read_to_string(&path).await.map_err(|_| error),
    }
}

async fn download(url: &str) -> Result<String, String> {
    let response = client().get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("{url}: HTTP {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err(format!("{url}: too large ({} bytes)", bytes.len()));
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| format!("{url}: not UTF-8"))?;
    // Checked before it is cached: an HTML error page served with a 200 must not be kept for a week.
    serde_json::from_str::<serde_json::Value>(&text).map_err(|e| format!("{url}: not JSON ({e})"))?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_web_addresses_are_fetched() {
        assert!(allowed("https://json.schemastore.org/package.json"));
        assert!(allowed("http://json-schema.org/draft-07/schema"));
        assert!(!allowed("file:///etc/passwd"));
        assert!(!allowed("https://localhost/schema.json"));
        assert!(!allowed("http://127.0.0.1:8080/schema.json"));
        assert!(!allowed("http://[::1]/schema.json"));
        assert!(!allowed("http://intranet/schema.json"));
        assert!(!allowed("http://printer.local/schema.json"));
        assert!(!allowed("not a url"));
    }

    #[test]
    fn each_url_has_its_own_cache_file() {
        let a = cache_path("https://json.schemastore.org/package.json");
        let b = cache_path("https://json.schemastore.org/tsconfig.json");
        assert_ne!(a, b);
        assert!(a.ends_with(a.file_name().unwrap()));
        assert_eq!(a.extension().and_then(|e| e.to_str()), Some("json"));
    }
}
