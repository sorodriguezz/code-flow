//! The local server the in-app previews load files from — a repository's `.html` page, a PDF, a
//! built site — at `http://127.0.0.1:<port>/<key>/<path>`.
//!
//! # Why a server, and not a custom URI scheme
//!
//! A scheme like `cf-meeting` is the obvious tool and the wrong one here. Tauri counts **every**
//! scheme the app registers as its own origin (`Webview::is_local_url`), so a page served from one
//! is a page that may invoke the app's commands. A meeting recording is audio and runs nothing; a
//! repository's `index.html` is code somebody else wrote — a cloned project, a downloaded report — and
//! it must never be in reach of the IPC. `http://127.0.0.1:<port>` is an origin Tauri does not
//! recognise as the app's, so a preview runs exactly like a page in a browser: its scripts work and
//! the app's commands are not there for it.
//!
//! It also fixes what `file://` gets wrong: module scripts, `fetch` and relative paths all work,
//! because the page is served over HTTP like the site it is.
//!
//! # Who can read through it
//!
//! Loopback only, and only for the folders the app registered. Each folder gets a random **key**,
//! and every path starts with it: nobody who has not been handed a URL can name a file. A request
//! without a key is served only when the page asking for it is one of ours — its `Referer` carries the
//! key (same-origin requests send the whole URL). That second rule is what makes a built site work:
//! Vite writes `/assets/index.js`, absolute, and the page that asks for it is `/<key>/dist/index.html`,
//! so the file is looked up in `dist/` first and the folder's root after it.
//!
//! The `Host` header must be this server's own address. A web page in the user's own browser can
//! point a name it controls at `127.0.0.1` (DNS rebinding) and read the answers as same-origin; its
//! requests then arrive saying that name, and are refused.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::Router;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use tokio::sync::OnceCell;

/// The registered folders, both ways: a key names one folder, and asking for a folder twice hands
/// back the key it already has — so a page reloaded or opened twice keeps one origin path.
#[derive(Default)]
struct Roots {
    by_key: HashMap<String, PathBuf>,
    by_root: HashMap<PathBuf, String>,
}

static ROOTS: LazyLock<Mutex<Roots>> = LazyLock::new(|| Mutex::new(Roots::default()));

/// The port, once the server is up. Started on the first preview rather than at launch: most
/// sessions never open one, and a listening socket nobody uses is one more thing on the machine.
static PORT: OnceCell<u16> = OnceCell::const_new();

/// What a path segment keeps literal in a URL; everything else is percent-encoded.
const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'\\')
    .add(b'^')
    .add(b'|');

async fn port() -> Result<u16, String> {
    PORT.get_or_try_init(|| async {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("preview server: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let app = Router::new().fallback(serve);
        tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                crate::applog::info(&format!("preview server stopped: {error}"));
            }
        });
        crate::applog::info(&format!("preview server listening on 127.0.0.1:{port}"));
        Ok::<u16, String>(port)
    })
    .await
    .copied()
}

fn register(root: &Path) -> String {
    let mut roots = ROOTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = roots.by_root.get(root) {
        return key.clone();
    }
    let key = uuid::Uuid::new_v4().simple().to_string();
    roots.by_key.insert(key.clone(), root.to_path_buf());
    roots.by_root.insert(root.to_path_buf(), key.clone());
    key
}

fn root_of(key: &str) -> Option<PathBuf> {
    ROOTS.lock().ok()?.by_key.get(key).cloned()
}

/// `relative` as path segments, refusing anything that could leave the folder: an absolute path, a
/// `..`, a drive letter. Backslashes are separators too, so a Windows spelling means the same file.
fn segments(relative: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for part in relative.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => return Err(format!("{relative}: the path leaves the folder")),
            part if part.contains(':') && cfg!(windows) => return Err(format!("{relative}: not a relative path")),
            part => out.push(part.to_string()),
        }
    }
    Ok(out)
}

/// The URL a preview loads `relative` (a file or a folder inside `root`) from, starting the server
/// if it is not running yet.
pub async fn url_for(root: &Path, relative: &str) -> Result<String, String> {
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let parts = segments(relative)?;
    let key = register(&root);
    let port = port().await?;
    let path: Vec<String> = parts.iter().map(|part| utf8_percent_encode(part, SEGMENT).to_string()).collect();
    Ok(format!("http://127.0.0.1:{port}/{key}/{}", path.join("/")))
}

/// The folder a URL of this server serves from, when it is one — `None` for any other URL.
/// `browser_tools` checks it: an agent may read a preview of its own repository and no other.
pub fn root_of_url(url: &str) -> Option<PathBuf> {
    let port = PORT.get()?;
    let rest = url.strip_prefix(&format!("http://127.0.0.1:{port}/")).or_else(|| url.strip_prefix(&format!("http://localhost:{port}/")))?;
    let key = rest.split(['/', '?', '#']).next()?;
    // A keyless path is resolved through the page that asked for it; with no page, it is nobody's.
    Some(root_of(key).unwrap_or_default())
}

/// The preview URL for a file of a registered folder, as a command: the editor's `.html`/`.pdf`
/// previews ask for their file with this. `root` is the repository, `path` relative to it.
#[tauri::command]
pub async fn preview_file_url(root: String, path: String) -> Result<String, String> {
    url_for(Path::new(&root), &path).await
}

fn status(code: StatusCode) -> Response {
    Response::builder().status(code).body(Body::empty()).unwrap_or_default()
}

fn host_is_ours(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else { return false };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

/// The decoded segments of a request path. `None` for one that tries to climb out (`%2e%2e`).
fn decoded(path: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    for raw in path.split('/') {
        let part = percent_decode_str(raw).decode_utf8().ok()?.to_string();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains('/') || part.contains('\\') || part.contains('\0') {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

/// The file `parts` names inside `root` — a folder's `index.html` for a folder — provided it is
/// still inside `root` once links are followed.
fn resolve(root: &Path, parts: &[String]) -> Option<PathBuf> {
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
    }
    let real = std::fs::canonicalize(&path).ok()?;
    if !real.starts_with(root) {
        return None;
    }
    if real.is_dir() {
        let index = real.join("index.html");
        return index.is_file().then_some(index);
    }
    real.is_file().then_some(real)
}

/// The folder and the path inside it of the page that asked — from its `Referer`, when that page is
/// one of ours.
fn referring_page(headers: &HeaderMap, port: u16) -> Option<(PathBuf, Vec<String>)> {
    let referer = headers.get(header::REFERER)?.to_str().ok()?;
    let rest = referer.strip_prefix(&format!("http://127.0.0.1:{port}/")).or_else(|| referer.strip_prefix(&format!("http://localhost:{port}/")))?;
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let mut parts = decoded(rest)?;
    if parts.is_empty() {
        return None;
    }
    let root = root_of(&parts.remove(0))?;
    // The page's own folder: everything but the file name, unless the URL named a folder.
    if !referer.ends_with('/') {
        parts.pop();
    }
    Some((root, parts))
}

fn content_type(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" | "csv" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

async fn file_response(path: &Path) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => Response::builder()
            .header(header::CONTENT_TYPE, content_type(path))
            .header(header::CONTENT_LENGTH, bytes.len().to_string())
            // A preview is of the file as it is now: the editor reloads it after every save.
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .body(Body::from(bytes))
            .unwrap_or_default(),
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

async fn serve(headers: HeaderMap, uri: Uri) -> Response {
    let Some(port) = PORT.get().copied() else { return status(StatusCode::SERVICE_UNAVAILABLE) };
    if !host_is_ours(&headers, port) {
        return status(StatusCode::FORBIDDEN);
    }
    let Some(parts) = decoded(uri.path()) else { return status(StatusCode::BAD_REQUEST) };
    // `/<key>/<path>`.
    if let Some(root) = parts.first().and_then(|key| root_of(key)) {
        let inside = &parts[1..];
        let Some(file) = resolve(&root, inside) else { return status(StatusCode::NOT_FOUND) };
        // A folder asked for without its slash: its page's relative links would resolve one level up.
        if file.file_name().is_some_and(|n| n == "index.html")
            && !uri.path().ends_with('/')
            && inside.last().is_none_or(|last| last != "index.html")
        {
            return Response::builder()
                .status(StatusCode::MOVED_PERMANENTLY)
                .header(header::LOCATION, format!("{}/", uri.path()))
                .body(Body::empty())
                .unwrap_or_default();
        }
        return file_response(&file).await;
    }
    // An absolute path a page of ours asked for: its own folder first, then each one above it.
    if let Some((root, mut folder)) = referring_page(&headers, port) {
        loop {
            let mut candidate = folder.clone();
            candidate.extend(parts.iter().cloned());
            if let Some(file) = resolve(&root, &candidate) {
                return file_response(&file).await;
            }
            if folder.pop().is_none() {
                break;
            }
        }
    }
    status(StatusCode::NOT_FOUND)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_never_leaves_its_folder() {
        assert_eq!(segments("dist/index.html").unwrap(), vec!["dist", "index.html"]);
        assert_eq!(segments("./a//b\\c.html").unwrap(), vec!["a", "b", "c.html"]);
        assert!(segments("../secret").is_err());
        assert!(segments("a/../../b").is_err());
        assert_eq!(decoded("/k/a%20b/c.html").unwrap(), vec!["k", "a b", "c.html"]);
        assert!(decoded("/k/%2e%2e/x").is_none());
        assert!(decoded("/k/a%2Fb").is_none());
    }

    #[tokio::test]
    async fn serves_a_registered_folder_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("cf-preview-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("dist/assets")).unwrap();
        std::fs::write(dir.join("dist/index.html"), "<script src=\"/assets/app.js\"></script>").unwrap();
        std::fs::write(dir.join("dist/assets/app.js"), "1").unwrap();
        let url = url_for(&dir, "dist/index.html").await.unwrap();
        let port = PORT.get().copied().unwrap();
        let host = format!("127.0.0.1:{port}");
        let get = |path: String, referer: Option<String>, host: String| async move {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            if let Some(referer) = referer {
                headers.insert(header::REFERER, referer.parse().unwrap());
            }
            serve(headers, path.parse().unwrap()).await.status()
        };
        let path = url.trim_start_matches(&format!("http://{host}")).to_string();
        assert_eq!(get(path.clone(), None, host.clone()).await, StatusCode::OK);
        // The built site's absolute asset, found from the page that asked for it.
        assert_eq!(get("/assets/app.js".into(), Some(url.clone()), host.clone()).await, StatusCode::OK);
        // Without a page of ours behind it, a keyless path is nobody's.
        assert_eq!(get("/assets/app.js".into(), None, host.clone()).await, StatusCode::NOT_FOUND);
        // Another name for this address is a rebinding attempt.
        assert_eq!(get(path, None, format!("evil.example:{port}")).await, StatusCode::FORBIDDEN);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
